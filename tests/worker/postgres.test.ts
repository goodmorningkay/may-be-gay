import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fixture } from "../recovery/fixture";
import { Queue, workerConnection } from "../../src/server/worker/queue";
import { executeClaim } from "../../src/server/worker/runtime";
import { operationChecks } from "../../src/server/worker/checks";
import { closeDatabase } from "../../src/server/db";
const url = process.env.WORKER_TEST_DATABASE_URL;
describe.skipIf(!url)("durable PostgreSQL claims", () => {
  let h: Awaited<ReturnType<typeof fixture>>, queue: Queue;
  beforeAll(async () => { process.env.DATABASE_URL = url!; h = await fixture(url!); queue = new Queue(workerConnection(url)); });
  beforeEach(async () => { await h.client`delete from jobs`; });
  afterAll(async () => { await queue?.sql.end(); await h?.close(); await closeDatabase(); });
  async function enqueue(kind = "email", payload: object = {}, max = 3) {
    const [row] = await h.client`insert into jobs(kind,idempotency_key,payload,max_attempts) values(${kind},${randomUUID()},${JSON.stringify(payload)}::jsonb,${max}) returning id`; return row.id;
  }
  it("alerts only after scheduled expiry is overdue and preserves cleanup request age", async () => {
    const id = await enqueue("media", { version: 1, action: "expire" });
    await h.client`update jobs set created_at=now()-interval '10 minutes',available_at=now()+interval '5 minutes' where id=${id}`;
    const age = async () => (await operationChecks()).find(event => event.code === "MEDIA_AGE_SECONDS");
    expect(await age()).toMatchObject({ severity: "ok", value: 0 });
    await h.client`update jobs set available_at=now()-interval '6 minutes' where id=${id}`;
    expect(await age()).toMatchObject({ severity: "critical" });
    await h.client`update jobs set payload='{"version":1,"action":"reconcileAsset"}'::jsonb,available_at=now()+interval '10 seconds' where id=${id}`;
    const cleanup = await age();
    expect(cleanup?.severity).toBe("critical");
    expect(cleanup?.value).toBeGreaterThanOrEqual(600);
  });
  it("racing claimers run once and acknowledgements are idempotent", async () => {
    await enqueue(); const claims = await Promise.all(Array.from({ length: 12 }, () => queue.claim()));
    expect(claims.filter(Boolean)).toHaveLength(1); const c = claims.find(Boolean)!;
    expect(c.attempts).toBe(1); expect(await queue.finish(c)).toBe(true); expect(await queue.finish(c)).toBe(false);
  });
  it("reclaims crashes and fences stale success/retry/renewal", async () => {
    await enqueue(); const old = (await queue.claim())!;
    await h.client`update jobs set locked_at=now()-interval '2 minutes' where id=${old.id}`;
    await queue.reclaim(); await h.client`update jobs set available_at=now() where id=${old.id}`;
    const next = (await queue.claim())!; expect(next.attempts).toBe(2); expect(next.locked_by).not.toBe(old.locked_by);
    expect(await queue.finish(old)).toBe(false); expect(await queue.finish(old, "FAILED")).toBe(false); expect(await queue.renew(old)).toBe(false);
    expect(await queue.renew(next)).toBe(true); expect(await queue.finish(next)).toBe(true);
  });
  it("backs off transient failures and bounds attempts including exhausted crashes", async () => {
    await enqueue("email", {}, 2); const c = (await queue.claim())!;
    await queue.finish(c, "MAIL_NOT_CONFIGURED"); expect(await queue.claim()).toBeUndefined();
    await h.client`update jobs set available_at=now()`; const retry = (await queue.claim())!;
    await h.client`update jobs set locked_at=now()-interval '2 minutes'`; await queue.reclaim();
    const [row] = await h.client`select state,finished_at,payload,locked_by from jobs where id=${retry.id}`;
    expect(row.state).toBe("failed"); expect(row.finished_at).not.toBeNull(); expect(row.locked_by).toBeNull();
  });
  it.each([false, true])("keeps urgent removals and reconciliation ahead of fairness=%s, then progresses email", async fair => {
    const email = await enqueue();
    const urgent = new Set([await enqueue("cache_purge"), await enqueue("media_deletion")]);
    const reconciliation = await enqueue("media", { version: 1, action: "reconcile" });
    await enqueue("media", { version: 1, action: "reconcileAsset", periodic: true });
    for (let i = 0; i < 2; i++) { const claim = (await queue.claim(fair))!; expect(urgent.delete(claim.id)).toBe(true); await queue.finish(claim); }
    expect((await queue.claim(fair))?.id).toBe(reconciliation);
    expect((await queue.claim(fair))?.id).toBe(email);
  });
  it("measures journal age from capture even when the archive just completed", async () => {
    const now = Date.now();
    await h.client`insert into recovery_status(id,state,details) values('journal','succeeded',${JSON.stringify({ capturedAt: new Date(now - 150000).toISOString(), completedAt: new Date(now).toISOString() })}::jsonb)
      on conflict(id) do update set state=excluded.state,details=excluded.details,updated_at=now()`;
    const check = async () => (await operationChecks()).find(event => event.code === "JOURNAL_AGE_SECONDS");
    try {
      expect(await check()).toMatchObject({ severity: "critical" });
      expect((await check())?.value).toBeGreaterThanOrEqual(150);
      await h.client`update recovery_status set details=${JSON.stringify({ completedAt: new Date().toISOString() })}::jsonb where id='journal'`;
      expect(await check()).toMatchObject({ severity: "critical", value: -1 });
      await h.client`update recovery_status set details=${JSON.stringify({ capturedAt: new Date().toISOString(), completedAt: new Date().toISOString() })}::jsonb where id='journal'`;
      expect(await check()).toMatchObject({ severity: "ok" });
    } finally { await h.client`delete from recovery_status where id='journal'`; }
  });
  it("never redelivers uncertain email beyond the finite provider window", async () => {
    await enqueue(); await h.client`update jobs set created_at=now()-interval '24 hours'`;
    let ran = false; await executeClaim(queue, (await queue.claim())!, new AbortController().signal, async () => { ran = true; return undefined; });
    expect(ran).toBe(false); const [r] = await h.client`select state,payload from jobs`; expect(r.state).toBe("failed"); expect(r.payload).toEqual({});
  });
  it("shutdown stops active work and leaves the lease for recovery", async () => {
    await enqueue(); const stop = new AbortController(), c = (await queue.claim())!;
    await expect(executeClaim(queue, c, stop.signal, async (_c, s) => {
      stop.abort();
      expect(s.aborted).toBe(true);
      return undefined;
    })).rejects.toThrow("WORKER_SHUTDOWN");
    const [r] = await h.client`select state from jobs`; expect(r.state).toBe("running");
  });
  it("strict processor payload validation fails terminally without retrying", async () => {
    await enqueue("media_deletion", { version: 999, assetId: "secret/private", token: "secret" });
    await executeClaim(queue, (await queue.claim())!, new AbortController().signal);
    const [r] = await h.client`select state,last_error_code,payload from jobs`;
    expect(r.state).toBe("failed"); expect(r.last_error_code).toBe("INVALID_JOB_PAYLOAD");
    expect(r.payload).toEqual({ version: 999, assetId: "secret/private", token: "secret" });
  });
  it("lost renewal cancels running work without acknowledging its replacement", async () => {
    await enqueue(); const c = (await queue.claim())!;
    const running = executeClaim(queue, c, new AbortController().signal, async (_c, s) => {
      await new Promise<void>(resolve => { s.addEventListener("abort", () => resolve(), { once: true }); });
      return undefined;
    }, 10);
    const interrupted = expect(running).rejects.toThrow("JOB_LEASE_LOST");
    await h.client`update jobs set locked_at=now()-interval '2 minutes' where id=${c.id}`;
    await queue.reclaim(); await h.client`update jobs set available_at=now() where id=${c.id}`;
    const next = (await queue.claim())!; await interrupted;
    expect(next.locked_by).not.toBe(c.locked_by);
    expect((await h.client`select locked_by from jobs where id=${c.id}`)[0].locked_by).toBe(next.locked_by);
  });
  it("missing real provider fails safely through the worker processor", async () => {
    delete process.env.MAIL_TRANSPORT; process.env.SITE_DOMAIN = "may-be.localhost";
    await enqueue("email", { template: "verification", to: "fixture@example.invalid", url: "https://app.may-be.localhost/verify" });
    await executeClaim(queue, (await queue.claim())!, new AbortController().signal);
    const [r] = await h.client`select state,last_error_code from jobs`; expect(r.state).toBe("pending"); expect(r.last_error_code).toBe("MAIL_NOT_CONFIGURED");
  });
}, 30000);
