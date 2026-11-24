import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertObjectKey, getMediaStorage, LocalMediaStorage, objectKeys, publicObjectKey, S3MediaStorage } from "@/server/media/storage";
import { CloudflareMediaPurge, getMediaPurge } from "@/server/media/purge";
import { mediaResponse } from "@/server/media/responses";

const config = { endpoint: "https://example.r2.cloudflarestorage.com", region: "auto", privateBucket: "private", publicBucket: "approved", accessKeyId: "test-only", secretAccessKey: "test-only", publicOrigin: "https://media.example.com" };
const key = objectKeys(randomUUID(),randomUUID()).display;
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("private/public storage boundaries", () => {
  it("separates local namespaces, rejects traversal and preserves immutable data", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(),"media-storage-test-"));
    try {
      const store = new LocalMediaStorage(root), body = Buffer.from("validated");
      await store.put("private",key,body,"image/webp");
      expect(await store.exists("public",key)).toBe(false);
      await expect(store.get("public",key,100)).rejects.toMatchObject({ code: "MEDIA_STORAGE_UNAVAILABLE" });
      expect(await store.get("private",key,body.length)).toEqual(body);
      await expect(store.get("private",key,body.length-1)).rejects.toMatchObject({ code: "MEDIA_STORAGE_UNAVAILABLE" });
      await store.put("private",key,body,"image/webp");
      await expect(store.put("private",key,Buffer.from("changed"),"image/webp")).rejects.toMatchObject({ code: "MEDIA_STORAGE_UNAVAILABLE" });
      await store.delete("private",key); await store.delete("private",key);
      expect(await store.exists("private",key)).toBe(false);
      for (const bad of ["../secret",key+"/..",key.replace("v1/","v1/../"),"https://evil.invalid"]) expect(()=>assertObjectKey(bad)).toThrow();
      expect(()=>new LocalMediaStorage("/app/public/media")).toThrow();
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it("allows explicit local HTTPS acceptance and fails closed for the real production zone", () => {
    vi.stubEnv("NODE_ENV","production"); vi.stubEnv("MEDIA_STORAGE","");
    expect(()=>getMediaStorage()).toThrowError(expect.objectContaining({ code: "MEDIA_PROVIDER_UNCONFIGURED" }));
    vi.stubEnv("MEDIA_STORAGE","local"); vi.stubEnv("SITE_DOMAIN","may-be.localhost"); vi.stubEnv("MEDIA_LOCAL_ROOT","/tmp/local-media");
    expect(getMediaStorage()).toBeInstanceOf(LocalMediaStorage);
    vi.stubEnv("SITE_DOMAIN","may-be.gay");
    expect(()=>getMediaStorage()).toThrow();
    expect(()=>new S3MediaStorage({...config,publicBucket:"private"})).toThrow();
    expect(()=>new S3MediaStorage({...config,endpoint:"http://localhost"})).toThrow();
  });
  it("uses explicit S3 buckets, immutable conditional writes, bounded reads and redacted failures", async () => {
    const send = vi.spyOn(S3Client.prototype,"send");
    send.mockResolvedValue({} as never);
    const store = new S3MediaStorage(config), publicKey = publicObjectKey(randomUUID(),randomUUID(),"image");
    await store.put("public",publicKey,Buffer.from("image"),"image/webp");
    const command = send.mock.calls[0][0] as PutObjectCommand;
    expect(command).toBeInstanceOf(PutObjectCommand);
    expect(command.input).toMatchObject({ Bucket:"approved", ContentType:"image/webp", IfNoneMatch:"*", CacheControl:"public, max-age=60, must-revalidate" });
    send.mockResolvedValueOnce({ Body: (async function*(){yield Buffer.alloc(8);yield Buffer.alloc(8);})() } as never);
    await expect(store.get("private",key,10)).rejects.toMatchObject({ code: "MEDIA_STORAGE_UNAVAILABLE" });
    expect(send.mock.calls[1][0]).toBeInstanceOf(GetObjectCommand);
    send.mockRejectedValueOnce({ $metadata:{httpStatusCode:404} }); expect(await store.exists("public",key)).toBe(false);
    expect(send.mock.calls[2][0]).toBeInstanceOf(HeadObjectCommand);
    send.mockRejectedValueOnce(new Error("secret access token"));
    await expect(store.delete("public",key)).rejects.toThrow("temporarily unavailable");
    expect(send.mock.calls[3][0]).toBeInstanceOf(DeleteObjectCommand);
  });
  it("purges only configured media URLs and treats provider refusal as failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({success:true})); vi.stubGlobal("fetch",fetchMock);
    const purge = new CloudflareMediaPurge("a".repeat(32),"test-only",config.publicOrigin);
    const url = `${config.publicOrigin}/media/${key}`;
    await purge.purge([url]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({files:[url]});
    await expect(purge.purge(["https://evil.invalid/media/v1/object"])).rejects.toThrow();
    fetchMock.mockResolvedValue(Response.json({success:false},{status:403}));
    await expect(purge.purge([url])).rejects.toMatchObject({code:"MEDIA_STORAGE_UNAVAILABLE"});
    vi.stubEnv("MEDIA_CLOUDFLARE_ZONE_ID",""); expect(()=>getMediaPurge(new S3MediaStorage(config))).toThrow();
  });
  it("serves exact content types and bounded ranges with nosniff and no-store", async () => {
    const object = { area:"private" as const,key,bytes:10,contentType:"audio/mpeg" as const };
    const response = mediaResponse(Buffer.from("0123456789"),object,new Request("https://app.example/content",{headers:{range:"bytes=2-5"}}));
    expect(response.status).toBe(206); expect(await response.text()).toBe("2345");
    expect(response.headers.get("content-type")).toBe("audio/mpeg"); expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    const bad = mediaResponse(Buffer.alloc(10),object,new Request("https://app.example/content",{headers:{range:"bytes=10-20,30-40"}}));
    expect(bad.status).toBe(416);
  });
});
