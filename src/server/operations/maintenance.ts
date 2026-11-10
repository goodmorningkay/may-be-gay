import "server-only";
import { sql } from "drizzle-orm";
import { getDatabase } from "@/server/db";
/** Bounded work per call; worker repeats on its schedule. Never removes recovery
 * journal or pending/failed cleanup work. No feature-owned competing dispatcher. */
export async function operationsMaintenance(limit = 500) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("INVALID_MAINTENANCE_LIMIT");
  return getDatabase().transaction(async tx => {
    // Today plus previous 29 UTC days. Keep the rendered 30-day window exactly.
    const views = await tx.execute(sql`delete from daily_profile_metrics where (profile_id,day) in (select profile_id,day from daily_profile_metrics where day < (now() at time zone 'UTC')::date - 29 limit ${limit}) returning profile_id`);
    const clicks = await tx.execute(sql`delete from daily_link_metrics where (profile_id,link_id,day) in (select profile_id,link_id,day from daily_link_metrics where day < (now() at time zone 'UTC')::date - 29 limit ${limit}) returning profile_id`);
    // Private reporter contact/details are needed for follow-up only: scrub after
    // 30 days even while unresolved. Resolved queue records last at most 90 days.
    const scrubbed = await tx.execute(sql`update reports set reporter_email = null, details = null where id in (select id from reports where created_at < now() - interval '30 days' and (reporter_email is not null or details is not null) limit ${limit}) returning id`);
    const reports = await tx.execute(sql`delete from reports where id in (select id from reports where created_at < now() - interval '90 days' limit ${limit}) returning id`);
    // Redacted privileged audit supports appeals for 180 days. Irreversible
    // recovery events have a distinct archival lifecycle and are never pruned here.
    const audits = await tx.execute(sql`delete from audit_events where id in (select id from audit_events where created_at < now() - interval '180 days' limit ${limit}) returning id`);
    return { views: views.length, clicks: clicks.length, reportContacts: scrubbed.length, reports: reports.length, audits: audits.length };
  });
}
