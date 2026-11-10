import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword } from "better-auth/crypto";
import postgres from "postgres";

async function main() {
// Run against the parent's final, already-running build. This script never
// launches Next, migrates a DB, contacts providers, or sends mail. Its sole DB
// target is the explicitly authorized local disposable media_test database.
const databaseUrl = process.env.TEST_MEDIA_DATABASE_URL;
assert(databaseUrl, "Set TEST_MEDIA_DATABASE_URL for the running app's media_test database.");
const databaseTarget = new URL(databaseUrl);
assert(["127.0.0.1", "localhost", "[::1]"].includes(databaseTarget.hostname) && databaseTarget.pathname === "/media_test", "Local media_test only.");
const target = new URL(process.env.UPLOAD_SMOKE_URL ?? "http://127.0.0.1:3000");
assert(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) && ["http:", "https:"].includes(target.protocol), "Loopback HTTP(S) only.");
const ca = process.env.TEST_CA_FILE ? await readFile(process.env.TEST_CA_FILE) : undefined;
const sql = postgres(databaseUrl, { max: 2, onnotice: () => {}, connect_timeout: 5 });
const ownerId = randomUUID(), profileId = randomUUID(), password = `local-smoke-${randomUUID()}`, email = `${ownerId}@example.invalid`;
let cookie = "";
type Result = { status: number; headers: IncomingHttpHeaders; body: string };
const openRequests = new Set<ReturnType<typeof httpRequest>>();
function openUpload(urlPath: string, headers: Record<string, string> = {}, method = "POST") {
  let request!: ReturnType<typeof httpRequest>;
  const response = new Promise<Result>((resolve, reject) => {
    request = (target.protocol === "https:" ? httpsRequest : httpRequest)(new URL(urlPath, target), {
      method, ca, servername: "app.may-be.localhost",
      headers: { host: "app.may-be.localhost", origin: "https://app.may-be.localhost", "x-editor-profile": profileId, ...(cookie ? { cookie } : {}), ...headers },
    }, incoming => {
      let body = "";
      incoming.on("data", chunk => { body += chunk; assert(body.length < 65536); });
      incoming.on("end", () => resolve({ status: incoming.statusCode!, headers: incoming.headers, body }));
      incoming.on("error", reject);
    });
    request.setTimeout(8000, () => request.destroy(new Error("HTTP upload deadline exceeded")));
    request.on("error", reject);
  });
  // Attach immediately: an early socket failure must not become an unhandled
  // rejection while the test is observing the reservation/spool independently.
  void response.catch(() => {});
  openRequests.add(request);
  return { request, response };
}
function security(result: Result) {
  assert.match(String(result.headers["cache-control"]), /private, no-store/);
  assert.equal(result.headers["cdn-cache-control"], "no-store");
  assert.equal(result.headers["cloudflare-cdn-cache-control"], "no-store");
  assert.equal(result.headers["x-content-type-options"], "nosniff");
  assert.match(String(result.headers["content-security-policy"]), /frame-ancestors 'none'/);
}
async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error(message);
}
try {
  await sql`insert into "user"(id,name,email,email_verified) values (${ownerId},'Local media smoke',${email},true)`;
  await sql`insert into account(id,account_id,provider_id,user_id,password) values (${randomUUID()},${ownerId},'credential',${ownerId},${await hashPassword(password)})`;
  await sql`insert into profiles(id,owner_id) values (${profileId},${ownerId})`;
  const login = openUpload("/api/auth/sign-in/email", { "content-type": "application/json" });
  login.request.end(JSON.stringify({ email, password }));
  const signedIn = await login.response; assert.equal(signedIn.status, 200, "Local fixture must sign in through the real auth route.");
  cookie = (signedIn.headers["set-cookie"] ?? []).map(value => value.split(";")[0]).filter(value => value.startsWith("__Host-")).join("; ");
  assert(cookie, "Expected a host-only signed session cookie.");

  const partial = openUpload("/api/media?kind=audio", { "content-type": "application/octet-stream" });
  partial.request.write(Buffer.alloc(32768, 1));
  let locator: { asset_id: string; token: string } | undefined;
  await until(async () => {
    [locator] = await sql<{ asset_id: string; token: string }[]>`select asset_id,token from media_storage where owner_id=${ownerId} and state='uploading'`;
    if (!locator) return false;
    const scratch = process.env.UPLOAD_SMOKE_SCRATCH_ROOT ?? os.tmpdir();
    for (const name of await readdir(scratch)) if (name.startsWith(`may-be-media-${locator.asset_id}-${locator.token}-`)) {
      if ((await stat(path.join(scratch, name, "upload")).catch(() => null))?.size === 32768) return true;
    }
    return false;
  }, "32 KiB did not reserve capacity AND reach the spool before EOF; check the proxy matcher and the app's scratch path.");
  partial.request.end(); const accepted = await partial.response; assert.equal(accepted.status, 202); security(accepted);
  console.log("PASS: authenticated upload reserved and spooled 32 KiB before EOF");

  const [before] = await sql`select count(*)::int as count from media_storage where owner_id=${ownerId}`;
  const anonymous = openUpload("/api/media?kind=audio", { cookie: "", "content-type": "application/octet-stream" });
  anonymous.request.write(Buffer.alloc(32768)); // Deliberately never send EOF.
  const rejected = await anonymous.response; assert.equal(rejected.status, 401); security(rejected); anonymous.request.destroy();
  const [after] = await sql`select count(*)::int as count from media_storage where owner_id=${ownerId}`;
  assert.equal(before.count, after.count); console.log("PASS: anonymous upload rejected before EOF without reservation");

  const large = openUpload("/api/media?kind=audio", { "content-type": "application/octet-stream" });
  large.request.end(Buffer.alloc(11 * 1024 ** 2));
  const oversized = await large.response; assert.equal(oversized.status, 413, "An 11 MiB body must not be truncated and accepted by Next's clone."); security(oversized);
  assert.equal(JSON.parse(oversized.body).error.code, "MEDIA_TOO_LARGE");
  console.log("PASS: actual 11 MiB audio rejected with 413 MEDIA_TOO_LARGE");
} finally {
  for (const request of openRequests) request.destroy();
  // Use normal durable cleanup: never drop locators/charges before their files.
  const rows = await sql<{ asset_id: string }[]>`select asset_id from media_storage where owner_id=${ownerId}`;
  for (const row of rows) if (cookie) {
    const removal = openUpload(`/api/media/${row.asset_id}`, {}, "DELETE");
    removal.request.end(); await removal.response.catch(() => {});
  }
  await sql`delete from "user" where id=${ownerId}`;
  await sql.end({ timeout: 2 });
}
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Upload acceptance failed"); process.exitCode = 1; });
