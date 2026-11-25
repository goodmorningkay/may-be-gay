import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapTestDatabase } from "../db/harness";
import { closeDatabase, getDatabase } from "@/server/db";
import { mediaStorage } from "@/server/db/schema-media";
import { accountQuotas, serviceSettings } from "@/server/db/schema-settings";
import { draftMedia, jobs, media, profileDrafts, profileRevisions, profiles, revisionMedia, user, usernameClaims } from "@/server/db/schema";
import { MAX_ASSETS, MAX_PRIVATE_MEDIA_OBJECTS, MAX_REJECTION_FEEDBACK } from "@/domain/media";
import { mediaListSchema } from "@/components/editor/api";
import { Queue, workerConnection } from "@/server/worker/queue";
import { defaultProfileDocument } from "@/domain/profile";
import { assertOwnedReadyMedia, deleteOwnedMedia, getPrivateMedia, getPublicMedia, listOwnedMedia, publishOwnedMedia, readLocalPublicContent, readPrivateContent, uploadMedia } from "@/server/media/service";
import { enqueueMediaSweep, processCachePurgeJob, processMediaDeletionJob, processMediaJob } from "@/server/media/jobs";
import { getMediaStorage, LocalMediaStorage, objectKeys } from "@/server/media/storage";
import { gifFixture } from "./gif-fixture";
const testUrl = process.env.TEST_MEDIA_DATABASE_URL;
// A separate disposable database allows parallel destructive suite bootstraps.
describe.skipIf(!testUrl)("media PostgreSQL ownership, quota and distributed transactions", () => {
  let harness: Awaited<ReturnType<typeof bootstrapTestDatabase>>, root: string, fixture: Buffer;
  beforeAll(async () => {
    if (process.env.TEST_DATABASE_URL && new URL(process.env.TEST_DATABASE_URL).host === new URL(testUrl!).host
      && new URL(process.env.TEST_DATABASE_URL).pathname === new URL(testUrl!).pathname) {
      throw new Error("TEST_MEDIA_DATABASE_URL must be separate from TEST_DATABASE_URL.");
    }
    harness = await bootstrapTestDatabase(testUrl!);
    root = await mkdtemp(path.join(os.tmpdir(),"media-db-test-"));
    vi.stubEnv("DATABASE_URL",testUrl!); vi.stubEnv("SITE_DOMAIN","may-be.localhost"); vi.stubEnv("MEDIA_STORAGE","local"); vi.stubEnv("MEDIA_LOCAL_ROOT",root);
    fixture = await sharp({create:{width:16,height:16,channels:3,background:"green"}}).png().toBuffer();
  },30000);
  beforeEach(async () => {
    await harness.reset();
  });
  afterAll(async () => { await closeDatabase(); if(harness) await harness.close(); if(root) await rm(root,{recursive:true,force:true}); vi.unstubAllEnvs(); });
  async function owner() {
    const id = randomUUID(), username = `u-${id.slice(0,8)}`;
    await harness.db.insert(user).values({id,email:`${id}@example.invalid`,name:"Owner",emailVerified:true});
    await harness.db.insert(usernameClaims).values({username,ownerId:id});
    const [profile] = await harness.client<{id:string}[]>`insert into profiles(owner_id) values (${id}) returning id`;
    await harness.db.insert(profileDrafts).values({profileId:profile.id,document:defaultProfileDocument});
    return {id,profileId:profile.id};
  }
  async function upload(ownerId: string) { return uploadMedia(ownerId,"image",new ReadableStream({start(c){c.enqueue(fixture);c.close();}})); }
  async function ready(ownerId: string) {
    const asset = await upload(ownerId), [row] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,asset.id));
    await processMediaJob({version:1,action:"process",assetId:asset.id,token:row.token});
    return (await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,asset.id)))[0];
  }
  async function publish(ownerId: string,profileId: string,assetId: string) {
    return getDatabase().transaction(async tx => {
      await tx.select().from(user).where(eq(user.id,ownerId)).for("update");
      const result = await publishOwnedMedia(tx,ownerId,[assetId]);
      const [revision] = await tx.insert(profileRevisions).values({profileId,revisionNumber:1,document:defaultProfileDocument}).returning();
      await tx.insert(revisionMedia).values({revisionId:revision.id,profileId,ownerId,mediaId:assetId});
      await tx.update(profiles).set({currentRevisionId:revision.id}).where(eq(profiles.id,profileId));
      return result;
    });
  }
  it("serializes racing quota reservations with one winner and persists expiry cleanup", async () => {
    const person = await owner(); await harness.db.insert(accountQuotas).values({userId:person.id,mediaLimitBytes:24*1024**2});
    const results = await Promise.allSettled([upload(person.id),upload(person.id)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect((await listOwnedMedia(person.id)).usage.chargedBytes).toBe(24*1024**2);
    expect((await harness.db.select().from(jobs)).some(j=>(j.payload as {action:string}).action==="expire")).toBe(true);
  });
  it("enforces the shared global budget and uploads pause", async () => {
    const a=await owner(), b=await owner();
    await harness.db.insert(serviceSettings).values({id:true,totalMediaLimitBytes:24*1024**2});
    const results=await Promise.allSettled([upload(a.id),upload(b.id)]); expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    await harness.db.update(serviceSettings).set({uploadsPaused:true});
    await expect(upload(a.id)).rejects.toMatchObject({code:"MEDIA_UPLOADS_PAUSED"});
  });
  it("keeps owner content private and denies foreign readiness, deletion and reads", async () => {
    const a=await owner(), b=await owner(), row=await ready(a.id);
    expect(await getPublicMedia([row.assetId])).toEqual({}); expect(await getPrivateMedia(b.id,[row.assetId])).toEqual({});
    expect((await getPrivateMedia(a.id,[row.assetId]))[row.assetId].url).toContain("/api/media/");
    await expect(readPrivateContent(b.id,row.assetId)).rejects.toMatchObject({status:404});
    await expect(deleteOwnedMedia(b.id,row.assetId)).rejects.toMatchObject({status:404});
    await expect(getDatabase().transaction(tx=>assertOwnedReadyMedia(tx,b.id,[row.assetId]))).rejects.toMatchObject({code:"MEDIA_NOT_READY"});
    expect((await listOwnedMedia(a.id)).usage.chargedBytes).toBe(row.privateBytes+row.publicBudgetBytes);
  });
  it("stores and charges one private object for a shared animated derivative", async () => {
    const a = await owner(), gif = await gifFixture(64, 48);
    const asset = await uploadMedia(a.id, "image", new ReadableStream({ start(controller) { controller.enqueue(gif); controller.close(); } }));
    const readRow = async () => (await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id)))[0];
    const { token } = await readRow();
    const locator = { version: 1, assetId: asset.id, token };
    await processMediaJob({ ...locator, action: "process" });
    const ready = await readRow();
    const keys = objectKeys(asset.id, token), storage = getMediaStorage(), bytes = ready.original!.bytes;
    expect(ready.original?.key).toBe(keys.original);
    expect(ready.display).toEqual(ready.original);
    expect(ready.privateBytes).toBe(bytes);
    expect(ready.chargedBytes).toBe(2 * bytes);
    expect(await storage.exists("private", keys.quarantine)).toBe(false);
    expect(await storage.exists("private", keys.display)).toBe(false);
    await publish(a.id, a.profileId, asset.id);
    await processMediaJob({ ...locator, action: "reconcileAsset" });
    expect(await readRow()).toMatchObject({ privateBytes: bytes, chargedBytes: 2 * bytes });
    expect(await sharp(await storage.get("public", ready.publicKey, bytes)).metadata()).toMatchObject({ pages: 2 });
    await harness.db.delete(user).where(eq(user.id, a.id));
    await processMediaJob({ ...locator, action: "reconcileAsset" });
    await processMediaDeletionJob(locator);
    expect(await storage.exists("private", keys.original)).toBe(false);
    expect(await storage.exists("public", ready.publicKey)).toBe(false);
  });
  it("rejects removal of retained drafts and history references", async () => {
    const a=await owner(), row=await ready(a.id);
    await harness.db.insert(draftMedia).values({profileId:a.profileId,ownerId:a.id,mediaId:row.assetId});
    await expect(deleteOwnedMedia(a.id,row.assetId)).rejects.toMatchObject({code:"MEDIA_RETAINED"});
    await harness.db.delete(draftMedia).where(eq(draftMedia.mediaId,row.assetId));
    await publish(a.id,a.profileId,row.assetId);
    await harness.db.update(profiles).set({currentRevisionId:null}).where(eq(profiles.id,a.profileId));
    await expect(deleteOwnedMedia(a.id,row.assetId)).rejects.toMatchObject({code:"MEDIA_RETAINED"});
  });
  it("exposes only active current publication assets and revokes old copies", async () => {
    const a=await owner(), row=await ready(a.id), other=await ready(a.id);
    await publish(a.id,a.profileId,row.assetId);
    expect(Object.keys(await getPublicMedia([row.assetId,other.assetId]))).toEqual([row.assetId]);
    await harness.db.update(profiles).set({currentRevisionId:null}).where(eq(profiles.id,a.profileId));
    expect(await getPublicMedia([row.assetId])).toEqual({});
    await expect(readLocalPublicContent(row.publicKey)).rejects.toMatchObject({status:404});
    await processMediaJob({version:1,action:"reconcileAsset",assetId:row.assetId,token:row.token});
    const [next]=await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,row.assetId)); expect(next.publicKey).not.toBe(row.publicKey);
    expect(next.revokingKey).toBe(row.publicKey);
    await processCachePurgeJob({version:1,assetId:row.assetId,token:row.token,key:row.publicKey});
    expect(await getMediaStorage().exists("public",row.publicKey)).toBe(false);
    expect(await getPrivateMedia(a.id,[row.assetId])).toHaveProperty(row.assetId);
  });
  it("keeps the prior revision visible if a replacement public copy fails", async () => {
    const a=await owner(), old=await ready(a.id), replacement=await ready(a.id);
    await publish(a.id,a.profileId,old.assetId);
    const originalPut=LocalMediaStorage.prototype.put;
    const failure=vi.spyOn(LocalMediaStorage.prototype,"put").mockImplementation(async function(this: LocalMediaStorage,area,key,body,type){
      if(area === "public" && key === replacement.publicKey) throw new Error("simulated copy failure");
      return originalPut.call(this,area,key,body,type);
    });
    try { await expect(getDatabase().transaction(tx=>publishOwnedMedia(tx,a.id,[replacement.assetId]))).rejects.toThrow("copy failure"); }
    finally { failure.mockRestore(); }
    expect(Object.keys(await getPublicMedia([old.assetId,replacement.assetId]))).toEqual([old.assetId]);
    expect(await getMediaStorage().exists("public",old.publicKey)).toBe(true);
  });
  it("discovers and removes provisional copies after publication rollback", async () => {
    const a=await owner(), row=await ready(a.id);
    await expect(getDatabase().transaction(async tx=>{await publishOwnedMedia(tx,a.id,[row.assetId]);throw new Error("rollback");})).rejects.toThrow("rollback");
    expect(await getMediaStorage().exists("public",row.publicKey)).toBe(true); expect(await getPublicMedia([row.assetId])).toEqual({});
    await processMediaJob({version:1,action:"reconcileAsset",assetId:row.assetId,token:row.token});
    await processCachePurgeJob({version:1,assetId:row.assetId,token:row.token,key:row.publicKey});
    expect(await getMediaStorage().exists("public",row.publicKey)).toBe(false);
  });
  it("uses a database-wide parser lock without advancing queued state on contention", async () => {
    const a=await owner(), asset=await upload(a.id), [row]=await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,asset.id));
    await harness.db.transaction(async tx=>{
      await tx.execute(sql`select pg_advisory_xact_lock(740301,1)`);
      await expect(processMediaJob({version:1,action:"process",assetId:asset.id,token:row.token})).rejects.toMatchObject({code:"MEDIA_PARSER_BUSY"});
    });
    expect((await harness.db.select().from(media).where(eq(media.id,asset.id)))[0].state).toBe("quarantined");
  });
  it("retains cleanup locators after owner deletion, then deletes physical files idempotently", async () => {
    const a=await owner(), row=await ready(a.id); await publish(a.id,a.profileId,row.assetId);
    await harness.db.delete(user).where(eq(user.id,a.id));
    expect(await getPublicMedia([row.assetId])).toEqual({});
    await processMediaJob({version:1,action:"reconcileAsset",assetId:row.assetId,token:row.token});
    await processMediaDeletionJob({version:1,assetId:row.assetId,token:row.token});
    await processMediaDeletionJob({version:1,assetId:row.assetId,token:row.token});
    expect(await getMediaStorage().exists("private",row.original!.key)).toBe(false);
    expect(await getMediaStorage().exists("public",row.publicKey)).toBe(false);
    expect(await harness.db.select().from(mediaStorage).where(and(eq(mediaStorage.assetId,row.assetId),eq(mediaStorage.token,row.token)))).toHaveLength(0);
  });
  it("cleans abandoned reservations without releasing quota before physical deletion", async () => {
    const a=await owner(), asset=await upload(a.id), [row]=await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,asset.id));
    await harness.db.update(mediaStorage).set({expiresAt:new Date(0)}).where(eq(mediaStorage.assetId,asset.id));
    await processMediaJob({version:1,action:"expire",assetId:asset.id,token:row.token});
    expect((await listOwnedMedia(a.id)).usage.chargedBytes).toBe(row.chargedBytes);
    await processMediaDeletionJob({version:1,assetId:asset.id,token:row.token}); expect((await listOwnedMedia(a.id)).usage.chargedBytes).toBe(0);
  });
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(r => { resolve = r; });
    return { promise, resolve };
  }
  it.each(["explicit", "account"])("holds the ledger charge and owner lock through a delayed PUT and %s deletion", async mode => {
    const a=await owner(), entered=deferred(), release=deferred(), original=LocalMediaStorage.prototype.putFile;
    const spy=vi.spyOn(LocalMediaStorage.prototype,"putFile").mockImplementation(async function(this: LocalMediaStorage,...args) {
      entered.resolve(); await release.promise; return original.apply(this,args);
    });
    const uploading=upload(a.id);
    await entered.promise;
    const [row]=await harness.db.select().from(mediaStorage).where(eq(mediaStorage.ownerId,a.id));
    let deleted=false;
    const deleting=(mode==="explicit" ? deleteOwnedMedia(a.id,row.assetId) : harness.db.delete(user).where(eq(user.id,a.id))).then(()=>{deleted=true;});
    try {
      await expect(harness.client.begin(async tx=>{ await tx`select id from "user" where id=${a.id} for update nowait`; })).rejects.toMatchObject({code:"55P03"});
      expect(deleted).toBe(false);
      expect((await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,row.assetId)))[0].chargedBytes).toBe(24*1024**2);
    } finally { release.resolve(); }
    await uploading; await deleting; spy.mockRestore();
    if(mode==="account") await processMediaJob({version:1,action:"reconcileAsset",assetId:row.assetId,token:row.token});
    expect((await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,row.assetId)))[0].state).toBe("deleting");
    await processMediaDeletionJob({version:1,assetId:row.assetId,token:row.token});
    expect(await getMediaStorage().exists("private",objectKeys(row.assetId,row.token).quarantine)).toBe(false);
    expect(await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,row.assetId))).toHaveLength(0);
  });
  it.each(["explicit", "account"])("does not PUT after %s deletion wins during spooling",async mode=>{
    const a=await owner(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream=new ReadableStream<Uint8Array>({start(c){controller=c;c.enqueue(fixture);}});
    const result=uploadMedia(a.id,"image",stream).catch(error=>error);
    await expect.poll(async()=> (await harness.db.select().from(mediaStorage).where(eq(mediaStorage.ownerId,a.id))).length).toBe(1);
    const [row]=await harness.db.select().from(mediaStorage).where(eq(mediaStorage.ownerId,a.id));
    if(mode==="explicit") await deleteOwnedMedia(a.id,row.assetId);
    else { await harness.db.delete(user).where(eq(user.id,a.id)); await processMediaJob({version:1,action:"reconcileAsset",assetId:row.assetId,token:row.token}); }
    await processMediaDeletionJob({version:1,assetId:row.assetId,token:row.token});
    const spy=vi.spyOn(LocalMediaStorage.prototype,"putFile");
    controller.close(); expect(await result).toMatchObject({code: mode==="explicit" ? "MEDIA_RESERVATION_EXPIRED" : "ACCOUNT_UNAVAILABLE"});
    expect(spy).not.toHaveBeenCalled();spy.mockRestore();
    expect(await getMediaStorage().exists("private",objectKeys(row.assetId,row.token).quarantine)).toBe(false);
    expect(await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,row.assetId))).toHaveLength(0);
  });
  it("keeps a written object durably charged after a PUT/finalization failure until cleanup",async()=>{
    const a=await owner(),original=LocalMediaStorage.prototype.putFile;
    const spy=vi.spyOn(LocalMediaStorage.prototype,"putFile").mockImplementation(async function(this: LocalMediaStorage,...args){await original.apply(this,args);throw new Error("after write");});
    await expect(upload(a.id)).rejects.toThrow("after write");spy.mockRestore();
    const [row]=await harness.db.select().from(mediaStorage).where(eq(mediaStorage.ownerId,a.id));
    expect(row.state).toBe("deleting");expect(row.chargedBytes).toBe(24*1024**2);
    expect(await getMediaStorage().exists("private",objectKeys(row.assetId,row.token).quarantine)).toBe(true);
    await processMediaDeletionJob({version:1,assetId:row.assetId,token:row.token});
    expect((await listOwnedMedia(a.id)).usage.chargedBytes).toBe(0);
    expect(await getMediaStorage().exists("private",objectKeys(row.assetId,row.token).quarantine)).toBe(false);
  });
  async function partial(area:string,key:string) {
    const file=path.join(root,area,`${key}.${randomUUID()}.partial`);
    await mkdir(path.dirname(file),{recursive:true});await writeFile(file,Buffer.alloc(67));return file;
  }
  it("shares one private object for small still images without duplicating display.webp", async () => {
    const a = await owner(), row = await ready(a.id);
    const keys = objectKeys(row.assetId, row.token), storage = getMediaStorage();
    expect(row.display).toEqual(row.original);
    expect(row.privateBytes).toBe(row.original!.bytes);
    expect(await storage.exists("private", keys.quarantine)).toBe(false);
    expect(await storage.exists("private", keys.display)).toBe(false);
  });
  it("cleans crash temporaries on an existing-original retry, immediate trim and live reconciliation",async()=>{
    const a=await owner();
    const wide=await sharp({create:{width:1700,height:16,channels:3,background:"green"}}).png().toBuffer();
    const asset=await uploadMedia(a.id,"image",new ReadableStream({start(c){c.enqueue(wide);c.close();}}));
    const [row]=await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,asset.id));
    const keys=objectKeys(row.assetId,row.token),original=LocalMediaStorage.prototype.put;
    const failure=vi.spyOn(LocalMediaStorage.prototype,"put").mockImplementation(async function(this: LocalMediaStorage,area,key,body,type){
      if(key===keys.display) throw new Error("crash after original");return original.call(this,area,key,body,type);
    });
    await expect(processMediaJob({version:1,action:"process",assetId:row.assetId,token:row.token})).rejects.toThrow("crash after original");failure.mockRestore();
    expect(await getMediaStorage().exists("private",keys.original)).toBe(true);
    const leftovers=await Promise.all([partial("private",keys.original),partial("private",keys.display),partial("public",row.publicKey)]);
    const unrelated=await partial("private",objectKeys(randomUUID(),randomUUID()).original);
    await processMediaJob({version:1,action:"process",assetId:row.assetId,token:row.token});
    await publish(a.id,a.profileId,row.assetId);
    leftovers.push(await partial("private",keys.original),await partial("private",keys.display),await partial("public",row.publicKey));
    await processMediaJob({version:1,action:"reconcileAsset",assetId:row.assetId,token:row.token});
    for(const file of leftovers) await expect(stat(file)).rejects.toMatchObject({code:"ENOENT"});
    expect((await stat(unrelated)).size).toBe(67);
    const [next]=await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId,row.assetId));
    const privateFiles=await readdir(path.join(root,"private",`v1/${row.assetId}/${row.token}`));
    expect(privateFiles.sort()).toEqual(["display.webp","original.webp"]);
    const physical=(await stat(path.join(root,"private",keys.original))).size+(await stat(path.join(root,"private",keys.display))).size;
    expect(next.privateBytes).toBe(physical);expect(next.chargedBytes).toBe(physical+next.publicBudgetBytes);
    expect(await getMediaStorage().exists("public",row.publicKey)).toBe(true);
  });
  it("reserves global private-object slots across all states and serializes the final slot",async()=>{
    const a=await owner(),b=await owner();
    // Ledger rows intentionally outlive absent owners. Zero bytes isolates this
    // admission budget from byte quota, and state alternation covers ALL states.
    await harness.client`insert into media_storage(asset_id,owner_id,token,kind,state,charged_bytes,public_key,expires_at)
      select gen_random_uuid(),'deleted-fixture-owner-'||n,gen_random_uuid(),'image',
      (array['uploading','queued','ready','deleting','rejected'])[1+n%5],0,'fixture-'||n,now()+interval '1 hour'
      from generate_series(1,${(MAX_PRIVATE_MEDIA_OBJECTS-1)/2}) n`;
    await expect(upload(a.id)).rejects.toMatchObject({code:"MEDIA_OBJECT_CAPACITY"});
    const audio=(id:string)=>uploadMedia(id,"audio",new ReadableStream({start(c){c.enqueue(Buffer.from("local bytes"));c.close();}}));
    const results=await Promise.allSettled([audio(a.id),audio(b.id)]);expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    expect(results.find(r=>r.status==="rejected")).toMatchObject({reason:{code:"MEDIA_OBJECT_CAPACITY"}});
    const [inventory]=await harness.client`select sum(case when kind='image' then 2 else 1 end)::int as slots from media_storage`;
    expect(inventory.slots).toBe(MAX_PRIVATE_MEDIA_OBJECTS);
    expect((await listOwnedMedia(a.id)).quota.globalCapacityAvailable).toBe(false);
  });
  it("discovers old and new ready assets despite 1000 old rejection rows, and bounds feedback",async()=>{
    const a=await owner(),old=await ready(a.id);
    await harness.db.insert(media).values(Array.from({length:1000},(_,n)=>({id:randomUUID(),ownerId:a.id,kind:"image",state:"rejected",objectKey:`rejected-${n}`,createdAt:new Date(1000+n)})));
    const newest=await ready(a.id),list=await listOwnedMedia(a.id);
    expect(list.assets.filter(r=>r.state==="ready").map(r=>r.id)).toEqual([old.assetId,newest.assetId]);
    expect(list.assets.filter(r=>r.state==="rejected")).toHaveLength(20);
    expect((await harness.db.select().from(media).where(eq(media.ownerId,a.id))).length).toBe(22);
  });
  it("rejects stale editor identity before list, reservation or deletion changes B",async()=>{
    const a=await owner(),b=await owner(),row=await ready(b.id);
    const before=await listOwnedMedia(b.id),ledger=await harness.db.select().from(mediaStorage),queued=await harness.db.select().from(jobs),quota=await harness.db.select().from(accountQuotas);
    await expect(listOwnedMedia(b.id,a.profileId)).rejects.toMatchObject({code:"ACCOUNT_CHANGED"});
    await expect(uploadMedia(b.id,"image",new ReadableStream({start(c){c.enqueue(fixture);c.close();}}),a.profileId)).rejects.toMatchObject({code:"ACCOUNT_CHANGED"});
    await expect(deleteOwnedMedia(b.id,row.assetId,a.profileId)).rejects.toMatchObject({code:"ACCOUNT_CHANGED"});
    expect(await listOwnedMedia(b.id,b.profileId)).toEqual(before);
    expect(await harness.db.select().from(mediaStorage)).toEqual(ledger);expect(await harness.db.select().from(jobs)).toEqual(queued);expect(await harness.db.select().from(accountQuotas)).toEqual(quota);
  });
  it("serializes a full usable library plus rejection feedback through the client contract", async () => {
    const a = await owner();
    const rows = Array.from({ length: MAX_ASSETS }, () => ({ id: randomUUID(), token: randomUUID() }));
    await harness.db.insert(media).values(rows.map(r => ({ id: r.id, ownerId: a.id, kind: "image", state: "ready", objectKey: objectKeys(r.id, r.token).original, contentType: "image/webp", actualBytes: 1, width: 1, height: 1 })));
    await harness.db.insert(mediaStorage).values(rows.map(r => ({ assetId: r.id, ownerId: a.id, token: r.token, kind: "image", state: "ready", chargedBytes: 3, privateBytes: 2, publicBudgetBytes: 1,
      original: { area: "private" as const, key: objectKeys(r.id, r.token).original, bytes: 1, contentType: "image/webp" as const },
      display: { area: "private" as const, key: objectKeys(r.id, r.token).display, bytes: 1, contentType: "image/webp" as const },
      publicKey: `v1/${r.id}/${r.token}/public.webp`, expiresAt: new Date() })));
    await harness.db.insert(media).values(Array.from({ length: MAX_REJECTION_FEEDBACK }, (_, n) => ({ ownerId: a.id, kind: "image", state: "rejected", objectKey: `rejected-${n}` })));
    const list = mediaListSchema.parse(JSON.parse(JSON.stringify(await listOwnedMedia(a.id, a.profileId))));
    expect(list.assets).toHaveLength(MAX_ASSETS + MAX_REJECTION_FEEDBACK);
    expect(new Set(list.assets.filter(r => r.state === "ready").map(r => r.id))).toEqual(new Set(rows.map(r => r.id)));
  });
  it("coalesces 2000 periodic checks across repeat sweeps and prioritizes later explicit removal",async()=>{
    const a=await owner();
    await harness.client`insert into media_storage(asset_id,owner_id,token,kind,charged_bytes,public_key,expires_at)
      select gen_random_uuid(),${a.id},gen_random_uuid(),'audio',0,'fixture-'||n,now()+interval '1 hour' from generate_series(1,2000) n`;
    async function sweep() {
      await enqueueMediaSweep(randomUUID());await enqueueMediaSweep(randomUUID());
      for (;;) {
        const [job]=await harness.db.select().from(jobs).where(sql`payload->>'action'='sweep' and state='pending'`).limit(1);
        if(!job) break;
        await processMediaJob(job.payload);await harness.db.update(jobs).set({state:"succeeded",finishedAt:new Date()}).where(eq(jobs.id,job.id));
      }
    }
    const started=performance.now();await sweep();await sweep();
    const checks=await harness.db.select().from(jobs).where(sql`payload->>'periodic'='true'`);expect(checks).toHaveLength(2000);
    const [one]=checks;
    await harness.db.update(jobs).set({state:"succeeded",finishedAt:new Date(),createdAt:new Date(0)}).where(eq(jobs.id,one.id));
    const [two]=checks.slice(1);await harness.db.update(jobs).set({state:"failed",attempts:20,finishedAt:new Date()}).where(eq(jobs.id,two.id));
    await sweep();
    const repaired=await harness.db.select().from(jobs).where(sql`payload->>'periodic'='true'`);expect(repaired).toHaveLength(2000);expect(repaired.every(j=>j.state==="pending")).toBe(true);
    expect(repaired.find(j=>j.id===one.id)!.createdAt.getTime()).toBeGreaterThan(Date.now()-60_000); // New logical checks must not inherit a false over-age alert.
    const enqueueMs=Math.round(performance.now()-started);
    const sample=await harness.db.select().from(mediaStorage).limit(20);
    for(const row of sample) await harness.db.update(mediaStorage).set({state:"ready",publicKey:`v1/${row.assetId}/${row.token}/public-${randomUUID()}.mp3`}).where(eq(mediaStorage.assetId,row.assetId));
    const storageCheck=vi.spyOn(LocalMediaStorage.prototype,"exists").mockResolvedValue(false),checkStarted=performance.now();
    for(const row of sample) await processMediaJob({version:1,action:"reconcileAsset",assetId:row.assetId,token:row.token,periodic:true});
    expect(storageCheck).toHaveBeenCalledTimes(20);storageCheck.mockRestore();
    process.stdout.write(`MEDIA_SWEEP_MEASURE assets=2000 sweeps=3 outstanding=${repaired.length} enqueueMs=${enqueueMs} checks=20 checkMs=${Math.round(performance.now()-checkStarted)}\n`);
    const connection=workerConnection(testUrl),queue=new Queue(connection);
    try {
      await harness.db.insert(jobs).values({kind:"media",idempotencyKey:"explicit-event",payload:{version:1,action:"reconcile",ownerId:"bounded-sweep-fixture"}});
      const explicit=await queue.claim(true);expect((explicit?.payload as {action:string})?.action).toBe("reconcile");
      await harness.db.insert(jobs).values({kind:"media_deletion",idempotencyKey:"explicit-delete",payload:{version:1}});
      const removal=await queue.claim(true);expect(removal?.kind).toBe("media_deletion");
      // A finished periodic job is repaired later; running claim fences survive
      // scheduler coalescing and cannot be overwritten by another sweep.
      const periodic=await queue.claim();expect((periodic?.payload as {periodic:boolean}).periodic).toBe(true);
      await sweep();expect(await queue.finish(periodic!)).toBe(true);
    } finally {await connection.end();}
  },30000);
  it("does not deadlock when a backup snapshot starts during media validation", async () => {
    const a = await owner(), asset = await upload(a.id), [row] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id));
    const keys = objectKeys(row.assetId, row.token), entered = deferred(), release = deferred();
    const originalGet = LocalMediaStorage.prototype.get;
    const spy = vi.spyOn(LocalMediaStorage.prototype, "get").mockImplementation(async function(this: LocalMediaStorage, area, key, maxBytes) {
      if (key === keys.quarantine) { entered.resolve(); await release.promise; }
      return originalGet.call(this, area, key, maxBytes);
    });
    const processing = processMediaJob({ version: 1, action: "process", assetId: row.assetId, token: row.token });
    const conn = await harness.client.reserve();
    let backupLocked = false;
    let parserLocked = false;
    try {
      await Promise.race([
        entered.promise,
        processing.then(() => { throw new Error("processing finished before quarantine read"); }),
      ]);
      await conn`set lock_timeout='5s'`;
      // Exact lock order used by backup.ts: MEDIA_BACKUP_LOCK (740303,1) then PARSER_LOCK (740301,1).
      const [{ acquired }] = await conn<{ acquired: boolean }[]>`select pg_try_advisory_lock(740303, 1) as acquired`;
      expect(acquired).toBe(true);
      backupLocked = true;
      const snapshotWaiting = conn`select pg_advisory_lock(740301, 1)`;
      release.resolve();
      await snapshotWaiting;
      parserLocked = true;
    } finally {
      release.resolve();
      if (parserLocked) await conn`select pg_advisory_unlock(740301, 1)`.catch(() => {});
      if (backupLocked) await conn`select pg_advisory_unlock(740303, 1)`.catch(() => {});
      conn.release();
      spy.mockRestore();
      await processing;
    }
    const [done] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, row.assetId));
    expect(done.state).toBe("ready");
  });
  it("adopts a valid pre-existing derivative on cross-deploy retry without issuing a delete", async () => {
    const a = await owner(), asset = await upload(a.id), [row] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id));
    const keys = objectKeys(row.assetId, row.token);
    // Simulate an interrupted prior encoder that wrote a different valid WebP at original.webp.
    const priorOriginal = await sharp(fixture).webp({ quality: 70, effort: 3 }).toBuffer();
    await getMediaStorage().put("private", keys.original, priorOriginal, "image/webp");
    const deleteSpy = vi.spyOn(LocalMediaStorage.prototype, "delete");
    try {
      await processMediaJob({ version: 1, action: "process", assetId: row.assetId, token: row.token });
      expect(deleteSpy).not.toHaveBeenCalledWith("private", keys.original);
      expect(deleteSpy).not.toHaveBeenCalledWith("private", keys.display);
    } finally { deleteSpy.mockRestore(); }
    const [done] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, row.assetId));
    expect(done.state).toBe("ready");
    expect(done.original?.bytes).toBe(priorOriginal.length);
    expect(await getMediaStorage().exists("private", keys.quarantine)).toBe(false);
  });
  it("keeps an obsolete display.webp charged on ready when immediate trim fails and removes it via reconcileAsset", async () => {
    const a = await owner();
    const { gifFixture } = await import("./gif-fixture");
    const gif = await gifFixture(8, 8, 2);
    const asset = await uploadMedia(a.id, "image", new ReadableStream({ start(c) { c.enqueue(gif); c.close(); } }));
    const [row] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id));
    const keys = objectKeys(row.assetId, row.token);
    const obsoleteDisplay = await sharp(fixture).webp({ quality: 80, effort: 1 }).toBuffer();
    await getMediaStorage().put("private", keys.display, obsoleteDisplay, "image/webp");
    const delSpy = vi.spyOn(LocalMediaStorage.prototype, "delete").mockRejectedValueOnce(new Error("simulated trim failure"));
    try {
      await processMediaJob({ version: 1, action: "process", assetId: row.assetId, token: row.token });
    } finally { delSpy.mockRestore(); }
    const [readyRow] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, row.assetId));
    expect(readyRow.state).toBe("ready");
    expect(readyRow.display?.key).toBe(keys.original);
    expect(readyRow.privateBytes).toBe(row.receivedBytes + readyRow.original!.bytes + obsoleteDisplay.length);
    await processMediaJob({ version: 1, action: "reconcileAsset", assetId: row.assetId, token: row.token });
    expect(await getMediaStorage().exists("private", keys.display)).toBe(false);
    expect(await getMediaStorage().exists("private", keys.quarantine)).toBe(false);
    const [trimmed] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, row.assetId));
    expect(trimmed.privateBytes).toBe(readyRow.original!.bytes);
  });
  it("defers physical deletion while parser scratch lock is active for that asset and token", async () => {
    const a = await owner(), asset = await upload(a.id), [row] = await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, asset.id));
    const keys = objectKeys(row.assetId, row.token), entered = deferred(), release = deferred();
    const originalGet = LocalMediaStorage.prototype.get;
    const spy = vi.spyOn(LocalMediaStorage.prototype, "get").mockImplementation(async function(this: LocalMediaStorage, area, key, maxBytes) {
      if (key === keys.quarantine) { entered.resolve(); await release.promise; }
      return originalGet.call(this, area, key, maxBytes);
    });
    const processing = processMediaJob({ version: 1, action: "process", assetId: row.assetId, token: row.token });
    await entered.promise;
    try {
      await deleteOwnedMedia(a.id, row.assetId);
      await expect(processMediaDeletionJob({ version: 1, assetId: row.assetId, token: row.token })).rejects.toMatchObject({ code: "MEDIA_PARSER_BUSY" });
      expect(await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, row.assetId))).toHaveLength(1);
    } finally { release.resolve(); spy.mockRestore(); }
    await processing;
    await processMediaDeletionJob({ version: 1, assetId: row.assetId, token: row.token });
    expect(await harness.db.select().from(mediaStorage).where(eq(mediaStorage.assetId, row.assetId))).toHaveLength(0);
    expect(await getMediaStorage().exists("private", keys.quarantine)).toBe(false);
  });

});
