import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stat, readdir } from "node:fs/promises";
import path from "node:path";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword } from "better-auth/crypto";
import sharp from "sharp";
import postgres from "postgres";

async function main() {
// Run only inside the explicit disposable Compose override, never an app DB.
assert.equal(process.env.DEV_MEDIA_FIXTURE, "isolated-development-media");
const database = new URL(process.env.DATABASE_URL!);
assert.equal(database.hostname, "db"); assert.equal(database.pathname, "/dev_media_test");
assert.equal(process.env.MEDIA_STORAGE, "local"); assert.equal(process.env.MAIL_ALLOW_LIVE, "false");
assert.equal(process.getuid!(), 1000);
const sql = postgres(database.toString(), { max: 2, connect_timeout: 5, onnotice: () => {} });
const ownerId = randomUUID(), profileId = randomUUID(), password = `local-fixture-${randomUUID()}`, email = `${ownerId}@example.invalid`;
let cookie = "";
function call(urlPath: string, method: string, body?: string | Buffer) {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ hostname: "app", port: 3000, path: urlPath, method, headers: {
      host: "app.may-be.localhost", origin: "https://app.may-be.localhost", cookie,
      "x-editor-profile": profileId, "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json",
    } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 1024 ** 2) req.destroy(new Error("RESPONSE_LIMIT")); else chunks.push(chunk); });
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(30000, () => req.destroy(new Error("DEVELOPMENT_HTTP_TIMEOUT")));
    req.on("error", reject); req.end(body);
  });
}
async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) { if (await check()) return; await delay(200); }
  throw new Error(message);
}
try {
  await sql`insert into "user"(id,name,email,email_verified) values(${ownerId},'Disposable development media',${email},true)`;
  await sql`insert into account(id,account_id,provider_id,user_id,password) values(${randomUUID()},${ownerId},'credential',${ownerId},${await hashPassword(password)})`;
  await sql`insert into profiles(id,owner_id) values(${profileId},${ownerId})`;
  const signedIn = await call("/api/auth/sign-in/email", "POST", JSON.stringify({ email, password }));
  assert.equal(signedIn.status, 200, "Development fixture sign-in must succeed");
  cookie = (signedIn.headers["set-cookie"] ?? []).map(c => c.split(";")[0]).filter(c => c.startsWith("__Host-")).join("; ");
  assert(cookie);
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: "green" } }).png().toBuffer();
  const upload = await call("/api/media?kind=image", "POST", png);
  assert.equal(upload.status, 202, "Development upload must reserve and queue its bytes");
  const assetId = JSON.parse(upload.body.toString()).id as string;
  await until(async () => (await sql`select state from media_storage where asset_id=${assetId}`)[0]?.state === "ready", "Worker did not process the development upload");
  const [asset] = await sql`select original,display,token from media_storage where asset_id=${assetId}`;
  for (const object of [asset.original, asset.display]) {
    const info = await stat(path.join(process.env.MEDIA_LOCAL_ROOT!, "private", object.key));
    assert.equal(info.uid, 1000); assert.equal(info.mode & 0o077, 0);
  }
  const content = await call(`/api/media/${assetId}/content`, "GET");
  assert.equal(content.status, 200); assert.equal(content.headers["content-type"], "image/webp"); assert(content.body.length > 0);
  const removed = await call(`/api/media/${assetId}`, "DELETE"); assert.equal(removed.status, 202);
  await until(async () => (await sql`select asset_id from media_storage where asset_id=${assetId}`).length === 0, "Worker did not finish development media deletion");
  const folder = path.join(process.env.MEDIA_LOCAL_ROOT!, "private", "v1", assetId, asset.token);
  assert.deepEqual(await readdir(folder), [], "No retained bytes or interrupted writes may survive cleanup");
  const [usage] = await sql`select coalesce(sum(charged_bytes),0)::int as charged from media_storage where owner_id=${ownerId}`;
  assert.equal(usage.charged, 0);
  assert.equal((await call(`/api/media/${assetId}/content`, "GET")).status, 404);
  console.log("Development Compose media passed: uid 1000, upload, worker parsing, private read, physical deletion and released reservation.");
} finally {
  await sql`delete from "user" where id=${ownerId}`;
  await sql.end({ timeout: 2 });
}
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Development media acceptance failed"); process.exitCode = 1; });
