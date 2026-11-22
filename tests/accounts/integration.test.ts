import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { handleAuth, reauthenticate } from "@/server/auth/handler";
import { createAccountAuth } from "@/server/auth/config";
import { getSession, requireAdmin } from "@/server/auth/session";
import { issueInvite, revokeInvite } from "@/server/invites";
import { claimUsername, revokeAccountSessions, listAccountSessions } from "@/server/accounts";
import { closeDatabase, getDatabase } from "@/server/db";
import { user, account, invites, jobs, session, profileDrafts, profiles, usernameClaims, verification, twoFactor } from "@/server/db/schema";
import { sessionAssurance } from "@/server/db/schema-accounts";
import { serviceSettings } from "@/server/db/schema-settings";
import { bootstrapTestDatabase } from "../db/harness";

const testUrl = process.env.ACCOUNTS_TEST_DATABASE_URL;
const origin = "https://app.may-be.localhost";
const password = "test account password 2048";
(testUrl ? describe : describe.skip)("accounts on isolated real PostgreSQL", () => {
  let h: Awaited<ReturnType<typeof bootstrapTestDatabase>>;
  beforeAll(async () => {
    vi.stubEnv("DATABASE_URL", testUrl!); vi.stubEnv("SITE_DOMAIN", "may-be.localhost"); vi.stubEnv("BETTER_AUTH_SECRET", "local-account-test-secret-with-at-least-32-characters");
    h = await bootstrapTestDatabase(testUrl!);
  }, 30000);
  beforeEach(async () => { await h.reset(); });
  afterAll(async () => { await closeDatabase(); if (h) await h.close(); vi.unstubAllEnvs(); });
  function headers(cookie = "") { return new Headers({ host: "app.may-be.localhost", origin, "content-type": "application/json", cookie }); }
  function request(path: string, body?: unknown, cookie = "") { return new Request(`${origin}/api/auth${path}`, { method: body === undefined ? "GET" : "POST", headers: headers(cookie), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); }
  function cookie(response: Response) { return response.headers.getSetCookie().map(s => s.split(";", 1)[0]).join("; "); }
  async function signup(email: string, token?: string) { return handleAuth(request("/sign-up/email", { name: "Account", email, password, inviteToken: token, callbackURL: "/verify-email" })); }
  async function verified(email: string) {
    const invite = await issueInvite({ email });
    expect((await signup(email, invite.token)).status).toBe(202);
    const [job] = await h.db.select().from(jobs).where(eq(jobs.kind, "email"));
    const mail = job.payload as { url: string; to: string };
    const url = new URL(mail.url);
    const verify = await handleAuth(new Request(url, { headers: headers() }));
    expect([200, 302]).toContain(verify.status);
    // Remove completed fixture jobs so subsequent accounts select their own mail.
    await h.db.delete(jobs).where(eq(jobs.id, job.id));
    const login = await handleAuth(request("/sign-in/email", { email, password }));
    expect(login.status, await login.clone().text()).toBe(200);
    return { cookie: cookie(login), response: login, principal: (await getSession(headers(cookie(login))))! };
  }
  function totp(uri: string) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = ""; for (const c of new URL(uri).searchParams.get("secret")!) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
    const key = Buffer.from(bits.match(/.{8}/g)!.map(x => parseInt(x, 2)));
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac("sha1", key).update(counter).digest(); const offset = digest[19] & 15;
    return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
  }
  async function enrolled(email: string, admin = false) {
    const a = await verified(email);
    if (admin) await h.db.update(user).set({ role: "admin" }).where(eq(user.id, a.principal.userId));
    const enabled = await handleAuth(request("/two-factor/enable", { password, method: "totp" }, a.cookie));
    expect(enabled.status).toBe(200);
    const setup = await enabled.json();
    const confirmed = await handleAuth(request("/two-factor/verify-totp", { code: totp(setup.totpURI) }, a.cookie));
    expect(confirmed.status).toBe(200);
    const currentCookie = cookie(confirmed) || a.cookie;
    return { cookie: currentCookie, principal: (await getSession(headers(currentCookie)))!, setup };
  }
  async function expireFactor(a: Awaited<ReturnType<typeof enrolled>>) {
    expect((await reauthenticate(new Request(`${origin}/api/account/reauthenticate`, { method: "POST", headers: headers(a.cookie), body: JSON.stringify({ password }) }))).status).toBe(200);
    await h.db.update(sessionAssurance).set({ secondFactorAt: new Date(Date.now() - 3600000) }).where(eq(sessionAssurance.sessionId, a.principal.sessionId));
    await expect(requireAdmin(headers(a.cookie))).rejects.toMatchObject({ code: "ADMIN_2FA_REQUIRED" });
  }
  async function within<T>(promise: Promise<T>, ms = 8000): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Fixture deadline exceeded")), ms); })]); }
    finally { clearTimeout(timer!); }
  }
  async function factorState(userId: string) {
    return {
      users: await h.db.select().from(user).where(eq(user.id, userId)),
      factors: await h.db.select().from(twoFactor).where(eq(twoFactor.userId, userId)),
      sessions: await h.db.select().from(session).where(eq(session.userId, userId)),
      assurance: await h.db.select().from(sessionAssurance),
      challenges: await h.db.select().from(verification),
    };
  }
  it("completes five simultaneous credential rotations and an unrelated query on the five-connection pool", async () => {
    const owners = [];
    for (let n = 0; n < 5; n++) owners.push(await verified(`pool-${n}@example.invalid`));
    const control = await h.client.reserve();
    const barrier = 71509341;
    let blockedPids: number[] = [];
    let pending: Promise<Response>[] = [];
    let completed = false;
    try {
      await control`SELECT pg_advisory_lock(${barrier})`;
      await control.unsafe(`CREATE FUNCTION accounts_test_credential_barrier() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock_shared(${barrier}); RETURN NEW; END $$; CREATE TRIGGER accounts_test_credential_barrier BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION accounts_test_credential_barrier();`);
      pending = owners.map(a => handleAuth(request("/change-password", { currentPassword: password, newPassword: "pool replacement password 2048", revokeOtherSessions: true }, a.cookie)));
      {
        const deadline = Date.now() + 8000;
        for (;;) {
          const locks = await control`SELECT l.pid FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE l.locktype='advisory' AND l.objid=${barrier} AND NOT l.granted AND a.datname=current_database() AND a.application_name='may-be-gay'`;
          blockedPids = locks.map(row => Number(row.pid));
          if (blockedPids.length === 5) break;
          if (Date.now() > deadline) throw new Error("Five credential transactions did not reach fixture barrier");
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
      // All five transactions now own their connection; no timing-only race.
      await control`SELECT pg_advisory_unlock(${barrier})`;
      const [responses, unrelated] = await within(Promise.all([Promise.all(pending), getDatabase().execute(sql`SELECT 1 AS alive`)]));
      expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200, 200]);
      expect(unrelated[0].alive).toBe(1);
      for (let n = 0; n < owners.length; n++) {
        expect(await getSession(headers(owners[n].cookie))).toBeNull();
        expect((await getSession(headers(cookie(responses[n]))))?.userId).toBe(owners[n].principal.userId);
        expect((await handleAuth(request("/sign-in/email", { email: owners[n].principal.email, password: "pool replacement password 2048" }))).status).toBe(200);
      }
      completed = true;
    } finally {
      try {
        await control`SELECT pg_advisory_unlock_all()`;
        // On regression, terminate only fixture-owned blocked backends, then
        // close this process's owned pool so queued hook queries also settle.
        if (!completed) {
          if (blockedPids.length) await control`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY(${blockedPids}) AND datname=current_database() AND application_name='may-be-gay'`;
          await closeDatabase();
        }
        await within(Promise.allSettled(pending));
      } finally {
        try { await control.unsafe("DROP TRIGGER IF EXISTS accounts_test_credential_barrier ON account; DROP FUNCTION IF EXISTS accounts_test_credential_barrier();"); }
        finally { control.release(); }
      }
    }
  }, 30000);
  it.each(["email_verified = false", "suspended_at = now()", "deleted_at = now()"])("checks current transaction owner flags before session replacement: %s", async flag => {
    const a = await verified("current-owner-flags@example.invalid");
    const before = await factorState(a.principal.userId);
    const credentials = await h.db.select().from(account);
    await h.client.unsafe(`CREATE FUNCTION accounts_test_owner_flag() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE "user" SET ${flag} WHERE id=NEW.user_id; RETURN NEW; END $$; CREATE TRIGGER accounts_test_owner_flag AFTER UPDATE ON account FOR EACH ROW EXECUTE FUNCTION accounts_test_owner_flag();`);
    try {
      const result = await handleAuth(request("/change-password", { currentPassword: password, newPassword: "blocked owner password 2048", revokeOtherSessions: true }, a.cookie));
      expect(result.ok).toBe(false);
      expect(result.headers.getSetCookie()).toEqual([]);
      expect(await factorState(a.principal.userId)).toEqual(before);
      expect(await h.db.select().from(account)).toEqual(credentials);
    } finally { await h.client.unsafe("DROP TRIGGER accounts_test_owner_flag ON account; DROP FUNCTION accounts_test_owner_flag();"); }
  });
  it("rolls back factor removal and enabled flag when disable cannot insert its replacement session", async () => {
    const a = await enrolled("disable-rollback@example.invalid");
    const before = await factorState(a.principal.userId);
    await h.client.unsafe(`CREATE FUNCTION accounts_test_disable_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture disable session failure'; END $$; CREATE TRIGGER accounts_test_disable_failure BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION accounts_test_disable_failure();`);
    try {
      const result = await handleAuth(request("/two-factor/disable", { password }, a.cookie));
      expect(result.ok).toBe(false); expect(result.headers.getSetCookie()).toEqual([]);
      expect(await factorState(a.principal.userId)).toEqual(before);
    } finally { await h.client.unsafe("DROP TRIGGER accounts_test_disable_failure ON session; DROP FUNCTION accounts_test_disable_failure();"); }
    expect((await getSession(headers(a.cookie)))?.userId).toBe(a.principal.userId);
  });
  it.each(["verified", "assurance", "commit"])("rolls back initial confirmation, rotation and proof when the final %s write fails", async target => {
    const a = await verified("confirmation-rollback@example.invalid");
    const enable = await handleAuth(request("/two-factor/enable", { password, method: "totp" }, a.cookie));
    expect(enable.status).toBe(200);
    const setup = await enable.json();
    const before = await factorState(a.principal.userId);
    const table = target === "verified" ? "two_factor" : "session_assurance";
    const operation = target === "verified" ? "UPDATE OF verified" : "INSERT";
    const trigger = target === "commit"
      ? "CREATE CONSTRAINT TRIGGER accounts_test_confirmation_failure AFTER INSERT ON session_assurance DEFERRABLE INITIALLY DEFERRED"
      : `CREATE TRIGGER accounts_test_confirmation_failure BEFORE ${operation} ON ${table}`;
    await h.client.unsafe(`CREATE FUNCTION accounts_test_confirmation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture final confirmation failure'; END $$; ${trigger} FOR EACH ROW EXECUTE FUNCTION accounts_test_confirmation_failure();`);
    try {
      const result = await handleAuth(request("/two-factor/verify-totp", { code: totp(setup.totpURI) }, a.cookie));
      expect(result.ok).toBe(false); expect(result.headers.getSetCookie()).toEqual([]);
      expect(await factorState(a.principal.userId)).toEqual(before);
    } finally { await h.client.unsafe(`DROP TRIGGER accounts_test_confirmation_failure ON ${table}; DROP FUNCTION accounts_test_confirmation_failure();`); }
    const retry = await handleAuth(request("/two-factor/verify-totp", { code: totp(setup.totpURI) }, a.cookie));
    expect(retry.status).toBe(200);
    expect(await getSession(headers(a.cookie))).toBeNull();
    const current = await getSession(headers(cookie(retry)));
    expect(current?.userId).toBe(a.principal.userId);
    expect((await h.db.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, current!.sessionId)))[0].secondFactorAt).not.toBeNull();
  });
  it.each(["verify-totp", "verify-backup-code"])("preserves challenge and factor state if assurance fails during %s", async endpoint => {
    const a = await enrolled("challenge-rollback@example.invalid");
    const login = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
    expect((await login.json()).twoFactorRedirect).toBe(true);
    expect((await handleAuth(request("/two-factor/verify-backup-code", { code: "fixture-invalid-code" }, cookie(login)))).ok).toBe(false);
    expect((await h.db.select().from(twoFactor).where(eq(twoFactor.userId, a.principal.userId)))[0].failedVerificationCount).toBe(1);
    const before = await factorState(a.principal.userId);
    const body = () => ({ code: endpoint === "verify-totp" ? totp(a.setup.totpURI) : a.setup.backupCodes[0] });
    await h.client.unsafe(`CREATE FUNCTION accounts_test_proof_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture assurance failure'; END $$; CREATE TRIGGER accounts_test_proof_failure BEFORE INSERT ON session_assurance FOR EACH ROW EXECUTE FUNCTION accounts_test_proof_failure();`);
    try {
      const result = await handleAuth(request(`/two-factor/${endpoint}`, body(), cookie(login)));
      expect(result.ok).toBe(false); expect(result.headers.getSetCookie()).toEqual([]);
      expect(await factorState(a.principal.userId)).toEqual(before);
    } finally { await h.client.unsafe("DROP TRIGGER accounts_test_proof_failure ON session_assurance; DROP FUNCTION accounts_test_proof_failure();"); }
    expect((await handleAuth(request(`/two-factor/${endpoint}`, body(), cookie(login)))).status).toBe(200);
    expect((await h.db.select().from(twoFactor).where(eq(twoFactor.userId, a.principal.userId)))[0].failedVerificationCount).toBe(0);
  });
  it.each(["verify-totp", "verify-backup-code"])("persists wrong-code challenge budgets and account locks for %s", async endpoint => {
    const a = await enrolled("attempt-persistence@example.invalid");
    for (let challenge = 0; challenge < 2; challenge++) {
      const login = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
      expect((await login.json()).twoFactorRedirect).toBe(true);
      for (let n = 0; n < 5; n++) {
        expect((await handleAuth(request(`/two-factor/${endpoint}`, { code: "fixture-invalid-code" }, cookie(login)))).ok).toBe(false);
        const [factor] = await h.db.select().from(twoFactor).where(eq(twoFactor.userId, a.principal.userId));
        expect(factor.failedVerificationCount).toBe(challenge * 5 + n + 1);
        const attempts = await h.db.select().from(verification).where(sql`${verification.identifier} LIKE '2fa-attempts-%'`);
        expect(attempts.some(attempt => attempt.value === String(n + 1))).toBe(true);
      }
      const result = await handleAuth(request(`/two-factor/${endpoint}`, { code: endpoint === "verify-totp" ? totp(a.setup.totpURI) : a.setup.backupCodes[0] }, cookie(login)));
      expect(result.ok).toBe(false); expect(result.headers.getSetCookie()).toEqual([]);
    }
    const [locked] = await h.db.select().from(twoFactor).where(eq(twoFactor.userId, a.principal.userId));
    expect(locked.lockedUntil!.getTime()).toBeGreaterThan(Date.now());
    const login = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
    expect((await handleAuth(request("/two-factor/verify-totp", { code: totp(a.setup.totpURI) }, cookie(login)))).status).toBe(429);
  });
  it.each(["verify-totp", "verify-backup-code"])("rolls back a correct %s proof if final challenge consumption is rejected", async endpoint => {
    const a = await enrolled("challenge-consumption-failure@example.invalid");
    const login = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
    expect((await login.json()).twoFactorRedirect).toBe(true);
    expect((await handleAuth(request("/two-factor/verify-backup-code", { code: "fixture-invalid-code" }, cookie(login)))).ok).toBe(false);
    const before = await factorState(a.principal.userId);
    const body = () => ({ code: endpoint === "verify-totp" ? totp(a.setup.totpURI) : a.setup.backupCodes[0] });
    await h.client.unsafe(`CREATE FUNCTION accounts_test_challenge_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN DELETE FROM verification WHERE value=NEW.user_id; RETURN NEW; END $$; CREATE TRIGGER accounts_test_challenge_failure AFTER UPDATE OF failed_verification_count ON two_factor FOR EACH ROW WHEN (NEW.failed_verification_count=0) EXECUTE FUNCTION accounts_test_challenge_failure();`);
    try {
      const result = await handleAuth(request(`/two-factor/${endpoint}`, body(), cookie(login)));
      expect(result.ok).toBe(false); expect(result.headers.getSetCookie()).toEqual([]);
      expect(await factorState(a.principal.userId)).toEqual(before);
    } finally { await h.client.unsafe("DROP TRIGGER accounts_test_challenge_failure ON two_factor; DROP FUNCTION accounts_test_challenge_failure();"); }
    expect((await handleAuth(request(`/two-factor/${endpoint}`, body(), cookie(login)))).status).toBe(200);
  });
  it.each(["verify-totp", "verify-backup-code"])("allows only one simultaneous success for the same %s sign-in challenge", async endpoint => {
    const a = await enrolled("challenge-race@example.invalid");
    const login = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
    expect((await login.json()).twoFactorRedirect).toBe(true);
    const body = { code: endpoint === "verify-totp" ? totp(a.setup.totpURI) : a.setup.backupCodes[0] };
    const results = await within(Promise.all(Array.from({ length: 2 }, () => handleAuth(request(`/two-factor/${endpoint}`, body, cookie(login))))));
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    const winner = results.find(r => r.ok)!;
    const principal = (await getSession(headers(cookie(winner))))!;
    expect(principal.userId).toBe(a.principal.userId);
    expect((await h.db.select().from(session).where(eq(session.userId, a.principal.userId)))).toHaveLength(2);
    expect((await h.db.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, principal.sessionId)))[0].secondFactorAt).not.toBeNull();
    expect(results.find(r => !r.ok)!.headers.getSetCookie()).toEqual([]);
  });
  it("consumes a backup code only once across simultaneous distinct sign-in challenges", async () => {
    const a = await enrolled("backup-race@example.invalid");
    const logins = await Promise.all(Array.from({ length: 2 }, () => handleAuth(request("/sign-in/email", { email: a.principal.email, password }))));
    const results = await within(Promise.all(logins.map(login => handleAuth(request("/two-factor/verify-backup-code", { code: a.setup.backupCodes[0] }, cookie(login))))));
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    const principal = (await getSession(headers(cookie(results.find(r => r.ok)!))))!;
    expect(principal.userId).toBe(a.principal.userId);
    expect((await h.db.select().from(session).where(eq(session.userId, a.principal.userId)))).toHaveLength(2);
  });
  it("completes ordinary enrollment, TOTP sign-in, backup-code replacement and disable with live cookies", async () => {
    const a = await enrolled("ordinary-factor@example.invalid");
    const login = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
    const proof = await handleAuth(request("/two-factor/verify-totp", { code: totp(a.setup.totpURI) }, cookie(login)));
    expect(proof.status).toBe(200);
    const currentCookie = cookie(proof);
    const principal = (await getSession(headers(currentCookie)))!;
    expect(principal.userId).toBe(a.principal.userId);
    const codes = await handleAuth(request("/two-factor/generate-backup-codes", { password }, currentCookie));
    expect(codes.status).toBe(200); expect((await codes.json()).backupCodes).not.toEqual(a.setup.backupCodes);
    const disabled = await handleAuth(request("/two-factor/disable", { password }, currentCookie));
    expect(disabled.status).toBe(200);
    expect(await getSession(headers(currentCookie))).toBeNull();
    expect((await getSession(headers(cookie(disabled))))?.userId).toBe(a.principal.userId);
    expect(await h.db.select().from(twoFactor).where(eq(twoFactor.userId, a.principal.userId))).toEqual([]);
    expect((await h.db.select().from(user).where(eq(user.id, a.principal.userId)))[0].twoFactorEnabled).toBe(false);
  });
  it("binds stale security and username controls to their rendered account", async () => {
    const a = await verified("security-screen-a@example.invalid"), b = await enrolled("security-screen-b@example.invalid");
    const originalSessions = await h.db.select().from(session).where(eq(session.userId, b.principal.userId));
    const originalAccount = await h.db.select().from(account).where(eq(account.userId, b.principal.userId));
    const originalFactor = await h.db.select().from(twoFactor).where(eq(twoFactor.userId, b.principal.userId));
    for (const [path, body] of [
      ["/change-password", { currentPassword: password, newPassword: "wrong-account-new-password-2030", revokeOtherSessions: true }],
      ["/two-factor/enable", { password, method: "totp" }],
      ["/two-factor/disable", { password }],
      ["/two-factor/get-totp-uri", { password }],
      ["/two-factor/generate-backup-codes", { password }],
      ["/two-factor/verify-totp", { code: totp(b.setup.totpURI) }],
      ["/sign-out", {}],
    ] as const) {
      const req = request(path, body, b.cookie); req.headers.set("x-account-id", a.principal.userId);
      const denied = await handleAuth(req);
      expect(denied.status, path).toBe(409); expect((await denied.json()).error.code).toBe("ACCOUNT_CHANGED");
    }
    const oldHeaders = headers(b.cookie); oldHeaders.set("x-account-id", a.principal.userId);
    await expect(claimUsername(oldHeaders, "wrong-account-claim")).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await expect(listAccountSessions(oldHeaders)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    await expect(revokeAccountSessions(oldHeaders)).rejects.toMatchObject({ code: "ACCOUNT_CHANGED" });
    const denied = await reauthenticate(new Request(`${origin}/api/account/reauthenticate`, { method: "POST", headers: oldHeaders, body: JSON.stringify({ password }) }));
    expect(denied.status).toBe(409);
    expect(await h.db.select().from(session).where(eq(session.userId, b.principal.userId))).toEqual(originalSessions);
    expect(await h.db.select().from(account).where(eq(account.userId, b.principal.userId))).toEqual(originalAccount);
    expect(await h.db.select().from(twoFactor).where(eq(twoFactor.userId, b.principal.userId))).toEqual(originalFactor);
    expect(await h.db.select().from(usernameClaims).where(eq(usernameClaims.ownerId, b.principal.userId))).toEqual([]);
    expect((await getSession(headers(b.cookie)))?.userId).toBe(b.principal.userId);
  });
  it.each(["verify-totp", "verify-backup-code"])("rejects ambiguous authentication cookies before %s can grant another account assurance", async endpoint => {
    const a = await enrolled("factor-a@example.invalid"), b = await enrolled("factor-b@example.invalid", true);
    await expireFactor(b);
    const [before] = await h.db.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, b.principal.sessionId));
    const code = endpoint === "verify-totp" ? totp(a.setup.totpURI) : a.setup.backupCodes[0];
    const result = await handleAuth(request(`/two-factor/${endpoint}`, { code }, `${a.cookie}; ${b.cookie}`));
    const [after] = await h.db.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, b.principal.sessionId));
    expect(after.secondFactorAt).toEqual(before.secondFactorAt);
    await expect(requireAdmin(headers(b.cookie))).rejects.toMatchObject({ code: "ADMIN_2FA_REQUIRED" });
    expect(result.status).toBe(400);
  });
  it.each(["get-totp-uri", "generate-backup-codes"])("requires an existing administrator factor before %s", async endpoint => {
    const a = await enrolled("factor-management@example.invalid", true);
    await expireFactor(a);
    const denied = await handleAuth(request(`/two-factor/${endpoint}`, { password }, a.cookie));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("ADMIN_2FA_REQUIRED");
    const verifiedFactor = await handleAuth(request("/two-factor/verify-totp", { code: totp(a.setup.totpURI) }, a.cookie));
    expect(verifiedFactor.status).toBe(200);
    expect((await handleAuth(request(`/two-factor/${endpoint}`, { password }, cookie(verifiedFactor) || a.cookie))).status).toBe(200);
  });
  it("rolls back the reset token, sessions and password after a credential update failure", async () => {
    const a = await verified("reset-rollback@example.invalid");
    await handleAuth(request("/request-password-reset", { email: a.principal.email, redirectTo: "/reset-password" }));
    const [job] = await h.db.select().from(jobs);
    const callback = await handleAuth(new Request((job.payload as { url: string }).url, { headers: headers() }));
    const token = new URL(callback.headers.get("location")!).searchParams.get("token");
    const beforeAccount = await h.db.select().from(account).where(eq(account.userId, a.principal.userId));
    const beforeSessions = await h.db.select().from(session).where(eq(session.userId, a.principal.userId));
    const beforeToken = await h.db.select().from(verification).where(sql`${verification.identifier} LIKE 'reset-password:%'`);
    await h.client.unsafe(`CREATE FUNCTION accounts_test_fail_reset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture credential write failure'; END $$; CREATE TRIGGER accounts_test_reset_failure BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION accounts_test_fail_reset();`);
    try {
      expect((await handleAuth(request("/reset-password", { token, newPassword: "changed reset password 2048" }))).ok).toBe(false);
      expect(await h.db.select().from(account).where(eq(account.userId, a.principal.userId))).toEqual(beforeAccount);
      expect(await h.db.select().from(session).where(eq(session.userId, a.principal.userId))).toEqual(beforeSessions);
      expect(await h.db.select().from(verification).where(sql`${verification.identifier} LIKE 'reset-password:%'`)).toEqual(beforeToken);
    } finally { await h.client.unsafe("DROP TRIGGER accounts_test_reset_failure ON account; DROP FUNCTION accounts_test_fail_reset();"); }
    expect((await handleAuth(request("/reset-password", { token, newPassword: "changed reset password 2048" }))).status).toBe(200);
  });
  it("rolls back password change and revocations when replacement session insertion fails", async () => {
    const a = await verified("change-rollback@example.invalid");
    const beforeAccount = await h.db.select().from(account).where(eq(account.userId, a.principal.userId));
    const beforeSessions = await h.db.select().from(session).where(eq(session.userId, a.principal.userId));
    await h.client.unsafe(`CREATE FUNCTION accounts_test_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture session write failure'; END $$; CREATE TRIGGER accounts_test_session_failure BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION accounts_test_fail_session();`);
    try {
      expect((await handleAuth(request("/change-password", { currentPassword: password, newPassword: "changed account password 2048", revokeOtherSessions: true }, a.cookie))).ok).toBe(false);
      expect(await h.db.select().from(account).where(eq(account.userId, a.principal.userId))).toEqual(beforeAccount);
      expect(await h.db.select().from(session).where(eq(session.userId, a.principal.userId))).toEqual(beforeSessions);
    } finally { await h.client.unsafe("DROP TRIGGER accounts_test_session_failure ON session; DROP FUNCTION accounts_test_fail_session();"); }
    expect(await getSession(headers(a.cookie))).not.toBeNull();
  });
  it("never logs raw database failures from the authentication router", async () => {
    const a = await verified("redacted-errors@example.invalid");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await h.client.unsafe(`CREATE FUNCTION accounts_test_fail_verification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'PRIVATE_AUTH_DATABASE_DETAIL'; END $$; CREATE TRIGGER accounts_test_verification_failure BEFORE INSERT ON verification FOR EACH ROW EXECUTE FUNCTION accounts_test_fail_verification();`);
    try {
      const response = await handleAuth(request("/request-password-reset", { email: a.principal.email, redirectTo: "/reset-password" }));
      expect(response.ok).toBe(false);
      expect(await response.text()).not.toContain("PRIVATE_AUTH_DATABASE_DETAIL");
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
      await h.client.unsafe("DROP TRIGGER accounts_test_verification_failure ON verification; DROP FUNCTION accounts_test_fail_verification();");
    }
  });
  it("blocks direct library signup, providers and signup without an invite in invitation mode", async () => {
    const direct = await createAccountAuth().handler(request("/sign-up/email", { name: "Bypass", email: "bypass@example.invalid", password }));
    // Library emits a generic synthetic response when a create hook returns 403.
    expect([200, 400, 403]).toContain(direct.status);
    await h.db.insert(serviceSettings).values({ registrationMode: "invite" });
    expect((await handleAuth(request("/sign-up/email", { name: "Bypass", email: "bypass@example.invalid", password }))).status).toBe(400);
    expect((await signup("no-invite@example.invalid")).status).toBe(400);
    expect((await handleAuth(request("/sign-in/social", { provider: "github" }))).status).toBe(404);
    expect(await h.db.select().from(user)).toHaveLength(0);
    expect(await h.db.select().from(session)).toHaveLength(0);
  });
  it("creates an ordinary unverified account through public signup without an invitation", async () => {
    const fields = { name: "Public account", email: "public@example.invalid", password, role: "admin", emailVerified: true };
    const created = await handleAuth(request("/sign-up/email", { ...fields, callbackURL: "/verify-email" }));
    expect(created.status).toBe(202);
    const users = await h.db.select().from(user);
    const mail = await h.db.select().from(jobs);
    expect(users).toMatchObject([{ email: fields.email, role: "user", emailVerified: false }]);
    expect(mail).toMatchObject([{ kind: "email", payload: { to: fields.email } }]);
    expect(await h.db.select().from(invites)).toHaveLength(0);
    expect(await h.db.select().from(session)).toHaveLength(0);
  });
  it("rejects revoked, expired and wrong-email invitations", async () => {
    const revoked = await issueInvite({ email: "revoked@example.invalid" }); await revokeInvite(revoked.id);
    const expiredToken = "X".repeat(43);
    const { hashInviteToken } = await import("@/server/invites");
    await h.db.insert(invites).values({ email: "expired@example.invalid", tokenHash: hashInviteToken(expiredToken), createdAt: new Date(Date.now() - 7200000), expiresAt: new Date(Date.now() - 3600000) });
    const wrong = await issueInvite({ email: "right@example.invalid" });
    for (const [email, token] of [["revoked@example.invalid", revoked.token], ["expired@example.invalid", expiredToken], ["wrong@example.invalid", wrong.token]]) expect((await signup(email, token)).status).toBe(400);
    expect(await h.db.select().from(user)).toHaveLength(0);
  });
  it("atomically redeems one invite under concurrency and refuses reuse", async () => {
    const invite = await issueInvite({ email: "race@example.invalid" });
    const results = await Promise.all([signup(invite.email, invite.token), signup(invite.email, invite.token)]);
    expect(results.map(r => r.status).sort()).toEqual([202, 400]);
    expect((await signup(invite.email, invite.token)).status).toBe(400);
    expect(await h.db.select().from(user)).toHaveLength(1);
    expect(await h.db.select().from(session)).toHaveLength(0);
    expect(await h.db.select().from(jobs)).toHaveLength(1);
  });
  it("rolls back library writes and mail when final redemption fails", async () => {
    const invite = await issueInvite({ email: "rollback@example.invalid" });
    await h.client.unsafe(`CREATE FUNCTION accounts_test_fail_redemption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test redemption failure'; END $$; CREATE TRIGGER accounts_test_fail BEFORE UPDATE ON invites FOR EACH ROW EXECUTE FUNCTION accounts_test_fail_redemption();`);
    try {
      expect((await signup(invite.email, invite.token)).status).toBe(500);
      expect(await h.db.select().from(user)).toHaveLength(0);
      expect(await h.db.select().from(session)).toHaveLength(0);
      expect(await h.db.select().from(jobs)).toHaveLength(0);
    } finally { await h.client.unsafe("DROP TRIGGER accounts_test_fail ON invites; DROP FUNCTION accounts_test_fail_redemption();"); }
    expect((await signup(invite.email, invite.token)).status).toBe(202);
  });
  it("serializes the final public account slot and honors closed registration", async () => {
    await h.db.insert(serviceSettings).values({ id: true, accountLimit: 1 });
    const results = await Promise.all([signup("cap-a@example.invalid"), signup("cap-b@example.invalid")]);
    expect(results.map(r => r.status).sort()).toEqual([202, 400]);
    expect(await h.db.select().from(user)).toHaveLength(1);
    await h.db.update(serviceSettings).set({ registrationMode: "closed", accountLimit: 50 });
    expect((await signup("cap-c@example.invalid")).status).toBe(400);
    await h.db.update(serviceSettings).set({ registrationMode: "public" });
    expect((await signup("cap-c@example.invalid")).status).toBe(202);
  });
  it("allows configured limits above 50, serializes the final slot, and supports an optional unset limit", async () => {
    await h.db.insert(serviceSettings).values({ id: true, accountLimit: 51 });
    await h.db.insert(user).values(Array.from({ length: 50 }, (_, n) => ({ id: `existing-${n}`, email: `existing-${n}@example.invalid`, name: "Existing" })));
    const a = await issueInvite({ email: "fiftyfirst-a@example.invalid" }); const b = await issueInvite({ email: "fiftyfirst-b@example.invalid" });
    const results = await Promise.all([signup(a.email, a.token), signup(b.email, b.token)]);
    expect(results.map(r => r.status).sort()).toEqual([202, 400]);
    expect(await h.db.select().from(user)).toHaveLength(51);
    await h.db.update(serviceSettings).set({ accountLimit: null });
    expect((await signup("unlimited@example.invalid")).status).toBe(202);
    expect(await h.db.select().from(user)).toHaveLength(52);
  });
  it("persists only hashed bounded rate keys and rejects excess attempts", async () => {
    const { rateLimit } = await import("@/server/rate-limit");
    const key = "private-email@example.invalid";
    await rateLimit(key, 2, 60); await rateLimit(key, 2, 60);
    await expect(rateLimit(key, 2, 60)).rejects.toMatchObject({ status: 429 });
    const rows = await h.client`SELECT * FROM auth_rate_limits`;
    expect(rows).toHaveLength(1); expect(rows[0].key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(rows)).not.toContain(key);
    await h.client`UPDATE auth_rate_limits SET expires_at = now() - interval '1 second'`;
    await expect(rateLimit(key, 2, 60)).resolves.toBeUndefined();
  });
  it("emits only secure host cookies and rejects hostile origins and callbacks", async () => {
    const a = await verified("cookies@example.invalid");
    const response = await handleAuth(request("/get-session", undefined, a.cookie));
    expect((await response.json()).session.token).toBeUndefined();
    for (const value of a.response.headers.getSetCookie()) {
      expect(value).toMatch(/^__Host-/); expect(value).toMatch(/; Secure/i); expect(value).toMatch(/; HttpOnly/i); expect(value).toMatch(/; Path=\//i); expect(value).toMatch(/; SameSite=Lax/i); expect(value).not.toMatch(/; Domain=/i);
    }
    const bad = request("/sign-in/email", { email: "cookies@example.invalid", password }); bad.headers.set("origin", "https://sibling.may-be.localhost");
    expect((await handleAuth(bad)).status).toBe(403);
    expect((await handleAuth(request("/sign-in/email", { email: "cookies@example.invalid", password, callbackURL: "https://evil.invalid" }))).status).toBe(400);
  });
  it("claims verified unpublished profiles and isolates two account sessions", async () => {
    const a = await verified("owner-a@example.invalid"); const b = await verified("owner-b@example.invalid");
    await expect(claimUsername(headers(a.cookie), "admin")).rejects.toMatchObject({ code: "INVALID_USERNAME" });
    const claimA = await claimUsername(headers(a.cookie), "owner-one"); const claimB = await claimUsername(headers(b.cookie), "owner-two");
    expect(claimA.profileId).not.toBe(claimB.profileId);
    expect((await h.db.select().from(profiles)).every(p => p.currentRevisionId === null)).toBe(true);
    expect(await h.db.select().from(profileDrafts)).toHaveLength(2);
    await expect(claimUsername(headers(a.cookie), "new-name")).rejects.toMatchObject({ code: "USERNAME_FIXED" });
    await revokeAccountSessions(headers(a.cookie), b.principal.sessionId);
    expect(await getSession(headers(b.cookie))).not.toBeNull();
    expect(await listAccountSessions(headers(a.cookie))).toHaveLength(1);
    await revokeAccountSessions(headers(a.cookie), a.principal.sessionId);
    expect(await getSession(headers(a.cookie))).toBeNull();
    await h.db.update(user).set({ emailVerified: false }).where(eq(user.id, b.principal.userId));
    await expect(claimUsername(headers(b.cookie), "unverified")).rejects.toMatchObject({ code: "VERIFICATION_REQUIRED" });
    expect(await h.db.select().from(usernameClaims)).toHaveLength(2);
    await h.db.update(user).set({ suspendedAt: new Date() }).where(eq(user.id, b.principal.userId));
    expect(await getSession(headers(b.cookie))).toBeNull();
  });
  it("requires actual recent password confirmation, denies enrolled-only admin", async () => {
    const a = await verified("admin@example.invalid");
    await h.db.update(user).set({ role: "admin", twoFactorEnabled: true }).where(eq(user.id, a.principal.userId));
    await expect(requireAdmin(headers(a.cookie))).rejects.toMatchObject({ code: "ADMIN_2FA_REQUIRED" });
    await h.db.update(session).set({ createdAt: new Date(Date.now() - 3600000) }).where(eq(session.id, a.principal.sessionId));
    await expect(revokeAccountSessions(headers(a.cookie), "other")).rejects.toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    expect((await reauthenticate(new Request(`${origin}/api/account/reauthenticate`, { method: "POST", headers: headers(a.cookie), body: JSON.stringify({ password: "wrong" }) }))).status).toBe(400);
    expect((await reauthenticate(new Request(`${origin}/api/account/reauthenticate`, { method: "POST", headers: headers(a.cookie), body: JSON.stringify({ password }) }))).status).toBe(200);
    await expect(revokeAccountSessions(headers(a.cookie), "other")).resolves.toBeUndefined();
  });
  it("bootstraps only through the configured private CLI and revokes existing sessions", async () => {
    const a = await verified("operator@example.invalid");
    const run = promisify(execFile);
    const args = ["--conditions=react-server", "--import", "tsx", "scripts/bootstrap-admin.ts", "--designate", "--email", a.principal.email];
    await expect(run(process.execPath, args, { env: { ...process.env, ACCOUNT_BOOTSTRAP_ENABLED: "false" } })).rejects.toMatchObject({ code: 1 });
    const result = await run(process.execPath, args, { env: { ...process.env, ACCOUNT_BOOTSTRAP_ENABLED: "true" } });
    expect(result.stdout).toContain("Verified account designated");
    expect(await getSession(headers(a.cookie))).toBeNull();
    const [owner] = await h.db.select().from(user).where(eq(user.id, a.principal.userId));
    expect(owner.role).toBe("admin");
    const bootstrap = await run(process.execPath, ["--conditions=react-server", "--import", "tsx", "scripts/bootstrap-admin.ts", "--invite", "--email", "bootstrap@example.invalid"], { env: { ...process.env, ACCOUNT_BOOTSTRAP_ENABLED: "true" } });
    expect(bootstrap.stdout).toContain("Bootstrap invitation queued");
    const [mail] = await h.db.select().from(jobs);
    const token = new URLSearchParams(new URL((mail.payload as { url: string }).url).hash.slice(1)).get("invite")!;
    expect(bootstrap.stdout).not.toContain(token);
    expect((await signup("bootstrap@example.invalid", token)).status).toBe(202);
    const [designated] = await h.db.select().from(user).where(eq(user.email, "bootstrap@example.invalid"));
    expect(designated.role).toBe("admin"); expect(designated.emailVerified).toBe(false);
  }, 15000);
  it("supports real TOTP enrollment, challenge, single-use recovery and administrator proof", async () => {
    const a = await verified("totp@example.invalid");
    await h.db.update(user).set({ role: "admin" }).where(eq(user.id, a.principal.userId));
    const enable = await handleAuth(request("/two-factor/enable", { password, method: "totp" }, a.cookie));
    expect(enable.status, await enable.clone().text()).toBe(200);
    const data = await enable.json();
    // Decode authenticator's RFC4648 Base32 key to calculate a real code.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = ""; for (const c of new URL(data.totpURI).searchParams.get("secret")!) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
    const key = Buffer.from(bits.match(/.{8}/g)!.map(x => parseInt(x, 2)));
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const digest = createHmac("sha1", key).update(counter).digest(); const offset = digest[19] & 15;
    const code = ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
    const confirm = await handleAuth(request("/two-factor/verify-totp", { code }, a.cookie));
    expect(confirm.status, await confirm.clone().text()).toBe(200);
    const confirmedCookie = cookie(confirm) || a.cookie;
    await expect(requireAdmin(headers(confirmedCookie))).resolves.toMatchObject({ role: "admin" });
    const confirmedPrincipal = (await getSession(headers(confirmedCookie)))!;
    const [enrolledAssurance] = await h.db.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, confirmedPrincipal.sessionId));
    expect(enrolledAssurance.reauthenticatedAt).not.toBeNull();
    expect(enrolledAssurance.secondFactorAt).not.toBeNull();
    const totpLogin = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
    expect((await totpLogin.json()).twoFactorRedirect).toBe(true);
    const totpSession = await handleAuth(request("/two-factor/verify-totp", { code }, cookie(totpLogin)));
    expect(totpSession.status, await totpSession.clone().text()).toBe(200);
    const totpPrincipal = (await getSession(headers(cookie(totpSession))))!;
    const [totpAssurance] = await h.db.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, totpPrincipal.sessionId));
    expect(totpAssurance.reauthenticatedAt).not.toBeNull();
    expect(totpAssurance.secondFactorAt).not.toBeNull();
    const login = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
    expect((await login.json()).twoFactorRedirect).toBe(true);
    expect(await getSession(headers(cookie(login)))).toBeNull();
    const recovery = await handleAuth(request("/two-factor/verify-backup-code", { code: data.backupCodes[0] }, cookie(login)));
    expect(recovery.status, await recovery.clone().text()).toBe(200);
    await expect(requireAdmin(headers(cookie(recovery)))).resolves.toMatchObject({ role: "admin" });
    const recoveryPrincipal = (await getSession(headers(cookie(recovery))))!;
    const [recoveryAssurance] = await h.db.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, recoveryPrincipal.sessionId));
    expect(recoveryAssurance.reauthenticatedAt).not.toBeNull();
    expect(recoveryAssurance.secondFactorAt).not.toBeNull();
    // Re-verifying TOTP on an existing session must not forge password confirmation.
    const expired = new Date(Date.now() - 3600000);
    await h.db.update(sessionAssurance).set({ reauthenticatedAt: expired }).where(eq(sessionAssurance.sessionId, recoveryPrincipal.sessionId));
    const reverify = await handleAuth(request("/two-factor/verify-totp", { code }, cookie(recovery)));
    expect(reverify.status, await reverify.clone().text()).toBe(200);
    const [afterReverify] = await h.db.select().from(sessionAssurance).where(eq(sessionAssurance.sessionId, recoveryPrincipal.sessionId));
    expect(afterReverify.reauthenticatedAt).toEqual(expired);
    const secondLogin = await handleAuth(request("/sign-in/email", { email: a.principal.email, password }));
    expect((await handleAuth(request("/two-factor/verify-backup-code", { code: data.backupCodes[0] }, cookie(secondLogin)))).status).toBe(400);
  });
  it("recovers passwords non-enumeratingly, consumes reset tokens and revokes sessions", async () => {
    const a = await verified("recovery@example.invalid");
    const known = await handleAuth(request("/request-password-reset", { email: a.principal.email, redirectTo: "/reset-password" }));
    const unknown = await handleAuth(request("/request-password-reset", { email: "unknown@example.invalid", redirectTo: "/reset-password" }));
    expect(await known.text()).toBe(await unknown.text());
    const [job] = await h.db.select().from(jobs);
    const callback = await handleAuth(new Request((job.payload as { url: string }).url, { headers: headers() }));
    const token = new URL(callback.headers.get("location")!).searchParams.get("token");
    const reset = await handleAuth(request("/reset-password", { token, newPassword: "new password for account 2048" }));
    expect(reset.status, await reset.clone().text()).toBe(200);
    expect(await getSession(headers(a.cookie))).toBeNull();
    expect((await handleAuth(request("/reset-password", { token, newPassword: password }))).status).toBe(400);
    expect((await handleAuth(request("/sign-in/email", { email: a.principal.email, password }))).status).toBe(400);
    expect((await h.db.select().from(verification).where(sql`${verification.identifier} LIKE 'reset-password:%'`))).toHaveLength(0);
    await handleAuth(request("/request-password-reset", { email: a.principal.email, redirectTo: "/reset-password" }));
    const [expired] = await h.db.select().from(verification).where(sql`${verification.identifier} LIKE 'reset-password:%'`);
    await h.db.update(verification).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(verification.id, expired.id));
    expect((await handleAuth(request("/reset-password", { token: expired.identifier.slice("reset-password:".length), newPassword: password }))).status).toBe(400);
  });
});
