import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { request } from "node:http";
import { request as secureRequest } from "node:https";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { defaultProfileDocument } from "../src/domain/profile";
import * as tables from "../src/server/db/schema";
import { bootstrapTestDatabase } from "../tests/db/harness";

// Explicit disposable DB only. Run after `npm run build`, separately from Vitest.
const testUrl = process.env.TEST_DATABASE_URL;
const appUrl = process.env.TEST_APP_DATABASE_URL;
const httpsPort = process.env.TEST_HTTPS_PORT ? Number(process.env.TEST_HTTPS_PORT) : undefined;
const testCa = httpsPort ? readFileSync(process.env.TEST_CA_FILE ?? "") : undefined;
assert(!httpsPort || (Number.isInteger(httpsPort) && httpsPort > 0 && httpsPort <= 65535), "Invalid local HTTPS port");
assert(testUrl && appUrl, "HTTP smoke requires TEST_DATABASE_URL and TEST_APP_DATABASE_URL.");
const migrationTarget = new URL(testUrl);
const runtimeTarget = new URL(appUrl);
assert(migrationTarget.host === runtimeTarget.host && migrationTarget.pathname === runtimeTarget.pathname,
  "Both test roles must connect to the same disposable database.");

async function main() {
  const database = await bootstrapTestDatabase(testUrl!);
  let server: ReturnType<typeof spawn> | undefined;
  let stopped: Promise<unknown> | undefined;
  let checks = 0;
  try {
    await database.reset();
    async function fixture(username: string, displayName: string, allowIndexing: boolean) {
      const id = randomUUID();
      await database.db.insert(tables.user).values({ id, name: "PRIVATE ACCOUNT NAME", email: `${id}@private.invalid`, emailVerified: true });
      await database.db.insert(tables.usernameClaims).values({ username, ownerId: id });
      const [profile] = await database.db.insert(tables.profiles).values({ ownerId: id }).returning();
      await database.db.insert(tables.profileDrafts).values({ profileId: profile.id, document: { ...defaultProfileDocument, bio: "PRIVATE DRAFT ONLY" } });
      const [revision] = await database.db.insert(tables.profileRevisions).values({
        profileId: profile.id, revisionNumber: 1,
        document: { ...defaultProfileDocument, displayName, pageTitle: displayName, allowIndexing, links: [
          { id: randomUUID(), label: "Public destination", url: "https://example.com/public", visible: true },
          { id: randomUUID(), label: "PRIVATE HIDDEN LINK", url: "https://private.invalid/hidden", visible: false },
        ] },
      }).returning();
      await database.db.update(tables.profiles).set({ currentRevisionId: revision.id }).where(eq(tables.profiles.id, profile.id));
      return { id, profile, revision };
    }
    const alice = await fixture("alice-http", "Alice Sunshine", false);
    const bob = await fixture("bob-http", "Bob Ocean", true);
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    assert(address && typeof address === "object");
    const port = httpsPort ?? address.port;
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));

    if (!httpsPort) {
      server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: { PATH: process.env.PATH, NODE_ENV: "production", NEXT_TELEMETRY_DISABLED: "1", SITE_DOMAIN: "may-be.localhost", DATABASE_URL: appUrl },
      stdio: ["ignore", "ignore", "pipe"],
      });
      stopped = once(server, "exit");
    }
    // Errors stay local and bounded. No raw DB exceptions enter successful output.
    let serverErrors = "";
    server?.stderr?.on("data", chunk => { serverErrors = (serverErrors + String(chunk)).slice(-4000); });

    function fetchPage(host: string, path = "/", extra: Record<string, string> = {}, method = "GET") {
      return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
        const send = httpsPort ? secureRequest : request;
        const req = send({ hostname: "127.0.0.1", port, path, method, headers: { host, ...extra },
          // Fixed trusted local SNI permits negative Host-header tests too.
          ...(httpsPort ? { ca: testCa, servername: "may-be.localhost" } : {}),
        }, res => {
          let body = "";
          res.setEncoding("utf8");
          res.on("data", chunk => { body += chunk; if (body.length > 1_000_000) req.destroy(new Error("Unexpectedly large test response")); });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on("error", reject);
        req.setTimeout(5000, () => req.destroy(new Error("HTTP check timed out")));
        req.end();
      });
    }
    const deadline = Date.now() + 20_000;
    for (;;) {
      try { if ((await fetchPage("may-be.localhost")).status === 200) break; } catch { /* startup */ }
      assert(Date.now() < deadline && (!server || server.exitCode === null), `Production server did not become ready. ${serverErrors}`);
      await delay(150);
    }

    async function check(host: string, path: string, status: number, extra: Record<string, string> = {}, method = "GET") {
      let result = await fetchPage(host, path, extra, method);
      // Next validates its RSC cache-busting hash and redirects a synthetic
      // request once to the correct hash. Follow only a same-host location.
      if (result.status === 307 && extra.rsc === "1" && result.headers.location) {
        const target = new URL(result.headers.location, `https://${host}`);
        assert.equal(target.host, host, "RSC normalization must preserve the tenant");
        result = await fetchPage(host, target.pathname + target.search, extra, method);
      }
      assert.equal(result.status, status, `${host}${path}: expected ${status}, got ${result.status}`);
      assert.match(String(result.headers["cache-control"]), /no-store/);
      assert.equal(result.headers["set-cookie"], undefined);
      assert.equal(result.headers["x-content-type-options"], "nosniff");
      for (const secret of ["PRIVATE DRAFT", "PRIVATE HIDDEN", "PRIVATE ACCOUNT", "private.invalid", alice.id, bob.id]) {
        assert(!result.body.includes(secret), `Private data appeared in ${host}${path}`);
      }
      checks++;
      return result;
    }
    assert.match((await check("may-be.localhost", "/", 200)).body, /All your places/);
    assert.match((await check("app.may-be.localhost", "/", 200)).body, /Account creation and the editor/);
    await check("may-be.localhost", "/examples?preset=midnight&layout=split&font=mono", 200);
    await check("may-be.localhost", "/examples?preset=javascript", 404);
    await check("may-be.localhost", "/support", 200);
    await check("app.may-be.localhost", "/api/health", 200);
    for (const host of ["unknown-http.may-be.localhost", "nested.alice-http.may-be.localhost", "media.may-be.localhost", "evil.invalid"]) await check(host, "/", 404);
    await check("unknown-http.may-be.localhost", "/robots.txt", 404);
    await check("alice-http.may-be.localhost", "/robots.txt", 200);
    for (const path of ["/examples", "/support", "/api/health", "/api/auth/sign-up/email", "/preview"]) {
      await check("alice-http.may-be.localhost", path, 404, { "x-forwarded-host": "app.may-be.localhost", forwarded: "host=app.may-be.localhost" });
    }
    await check("app.may-be.localhost", "/", 405, { origin: "https://alice-http.may-be.localhost" }, "POST");
    const a = await check("alice-http.may-be.localhost", "/", 200, { cookie: "__Host-session=other-account", "x-forwarded-host": "bob-http.may-be.localhost" });
    assert.match(a.body, /Alice Sunshine/);
    assert(!a.body.includes("Bob Ocean"));
    assert.match(a.body, /name="robots" content="noindex, nofollow"/);
    assert.match(a.body, /rel="canonical" href="https:\/\/alice-http.may-be.localhost/);
    const csp = String(a.headers["content-security-policy"]);
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    assert(nonce);
    assert(!csp.includes("unsafe-eval"));
    const scripts = [...a.body.matchAll(/<script\b[^>]*>/g)];
    assert(scripts.length > 0);
    for (const [script] of scripts) assert(script.includes(`nonce="${nonce}"`), "Script missing the request CSP nonce");
    const b = await check("bob-http.may-be.localhost", "/", 200);
    assert.match(b.body, /Bob Ocean/);
    assert(!b.body.includes("Alice Sunshine"));
    assert.match(b.body, /name="robots" content="index, follow"/);
    for (const [host, own, other] of [["alice-http", "Alice Sunshine", "Bob Ocean"], ["bob-http", "Bob Ocean", "Alice Sunshine"]]) {
      for (const prefetch of [false, true]) {
        const rscHeaders: Record<string, string> = { rsc: "1" };
        if (prefetch) rscHeaders["next-router-prefetch"] = "1";
        const rsc = await check(`${host}.may-be.localhost`, "/?_rsc=fixture", 200, rscHeaders);
        assert.match(String(rsc.headers["content-type"]), /text\/x-component/);
        // Dynamic-page prefetch can contain only routing data. A navigation
        // must render its own content; neither response may contain a neighbor.
        if (!prefetch) assert(rsc.body.includes(own), `RSC navigation omitted ${host}'s published content`);
        assert(!rsc.body.includes(other), `RSC response for ${host} contains another profile`);
      }
    }
    await check("unknown-http.may-be.localhost", "/?_rsc=fixture", 404, { rsc: "1" });
    await database.db.update(tables.profiles).set({ currentRevisionId: null }).where(eq(tables.profiles.id, alice.profile.id));
    await check("alice-http.may-be.localhost", "/", 404);
    await database.db.update(tables.user).set({ suspendedAt: new Date() }).where(eq(tables.user.id, bob.id));
    await check("bob-http.may-be.localhost", "/", 404);
    console.log(`Production ${httpsPort ? "HTTPS through Caddy" : "HTTP"} smoke passed: ${checks} requests; HTML/RSC isolation, CSP nonces, real 404s, no-store, unpublish and suspension.`);
  } finally {
    if (server && server.exitCode === null) {
      server.kill("SIGTERM");
      const kill = setTimeout(() => server?.kill("SIGKILL"), 5000);
      kill.unref();
      await stopped;
      clearTimeout(kill);
    }
    await database.close();
  }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "HTTP smoke failed"); process.exitCode = 1; });
