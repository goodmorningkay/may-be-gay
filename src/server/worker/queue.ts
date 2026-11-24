import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { requireDatabaseUrl } from "../db/connection-options";
export type Claim = { id: string; kind: string; payload: unknown; payload_version: number; attempts: number; max_attempts: number; locked_by: string; created_at: Date };
export const LEASE_MS = 90_000;
export function workerConnection(url = process.env.DATABASE_URL) {
  return postgres(requireDatabaseUrl(url, "DATABASE_URL"), { max: 3, connect_timeout: 5, onnotice: () => {}, connection: { application_name: "may-be-worker", statement_timeout: 10000 } });
}
export type WorkerSql = ReturnType<typeof workerConnection>;
export class Queue {
  constructor(readonly sql: WorkerSql) {}
  async reclaim(leaseMs = LEASE_MS) {
    // Exhausted claims become terminal, preserving cleanup payloads/locators.
    return this.sql`with stale as (select id from jobs where state='running' and locked_at < now() - ${leaseMs} * interval '1 millisecond' order by locked_at limit 100 for update skip locked)
      update jobs j set state=case when attempts>=max_attempts then 'failed' else 'pending' end,
      finished_at=case when attempts>=max_attempts then now() else null end,
      locked_at=null,locked_by=null,available_at=now()+interval '2 seconds',last_error_code='LEASE_EXPIRED',updated_at=now()
      from stale where j.id=stale.id returning j.id`;
  }
  async claim(fair = false): Promise<Claim | undefined> {
    const token = randomUUID();
    const rows = await this.sql<Claim[]>`with candidate as (
      select id from jobs where state='pending' and available_at<=now() and attempts<max_attempts
      order by case when kind in ('cache_purge','media_deletion') then 0
        when kind='media' and (payload->>'action'='reconcile' or (payload->>'action'='reconcileAsset' and coalesce(payload->>'periodic','false')<>'true')) then 1
        when ${fair} then 2
        when kind='media' and payload->>'action' in ('sweep','reconcileAsset','expire') then 3 else 2 end,
        available_at,created_at,id limit 1 for update skip locked)
      update jobs j set state='running', attempts=attempts+1,locked_by=${token},locked_at=now(),finished_at=null,updated_at=now()
      from candidate where j.id=candidate.id returning j.*`;
    return rows[0];
  }
  async renew(c: Claim) {
    const rows = await this.sql`update jobs set locked_at=now(),updated_at=now() where id=${c.id} and state='running' and locked_by=${c.locked_by} and attempts=${c.attempts} and locked_at>now()-${LEASE_MS}*interval '1 millisecond' returning id`;
    return rows.length === 1;
  }
  async finish(c: Claim, error?: string, terminal = false) {
    const failed = !!error && (terminal || c.attempts >= c.max_attempts);
    const delay = Math.min(["media_deletion", "cache_purge"].includes(c.kind) ? 10 : 30, 2 ** Math.min(c.attempts, 5)) + Math.floor(Math.random() * 3);
    const rows = await this.sql`update jobs set state=${!error ? "succeeded" : failed ? "failed" : "pending"},
      finished_at=${!error || failed ? new Date() : null},locked_at=null,locked_by=null,
      available_at=now()+${delay}*interval '1 second',last_error_code=${error ?? null},updated_at=now(),
      payload=case when kind='email' and ${!error || failed} then '{}'::jsonb else payload end
      where id=${c.id} and state='running' and locked_by=${c.locked_by} and attempts=${c.attempts}
      and locked_at>now()-${LEASE_MS}*interval '1 millisecond' returning id`;
    return rows.length === 1;
  }
}
