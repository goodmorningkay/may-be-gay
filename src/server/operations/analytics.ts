import "server-only";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import { analyticsDays, metricSchema } from "@/domain/operations";
import { getDatabase } from "@/server/db";
import { dailyLinkMetrics, dailyProfileMetrics, profiles } from "@/server/db/schema";
import { requireUser } from "@/server/auth/session";
import { rateLimit } from "@/server/rate-limit";
import { currentPublic } from "./public";
export async function recordMetric(username: string, raw: unknown) {
  const input = metricSchema.parse(raw);
  await rateLimit("operations:metrics:global", 2000, 60);
  // Tenant key is an existing public name, never an IP, UA, cookie or visitor ID.
  await getDatabase().transaction(async tx => {
    const target = await currentPublic(tx, username);
    if (!target) return;
    const event = input.event;
    if (event === "click" && !target.document.links.some(l => l.visible && l.id.toLowerCase() === input.linkId.toLowerCase())) return;
    // No nested transaction/pool dependency while holding the owning user's lock.
    const day = new Date().toISOString().slice(0, 10);
    if (event === "view") await tx.insert(dailyProfileMetrics).values({ profileId: target.profileId, day, views: 1 }).onConflictDoUpdate({ target: [dailyProfileMetrics.profileId, dailyProfileMetrics.day], set: { views: sql`least(${dailyProfileMetrics.views} + 1, 1000000)` } });
    else {
      // Link churn must not grow per-day cardinality without bound.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${target.profileId}, 740302))`);
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(dailyLinkMetrics).where(and(eq(dailyLinkMetrics.profileId, target.profileId), eq(dailyLinkMetrics.day, day)));
      const [existing] = await tx.select({ id: dailyLinkMetrics.linkId }).from(dailyLinkMetrics).where(and(eq(dailyLinkMetrics.profileId, target.profileId), eq(dailyLinkMetrics.day, day), eq(dailyLinkMetrics.linkId, input.linkId.toLowerCase())));
      if (count.n >= 100 && !existing) return;
      await tx.insert(dailyLinkMetrics).values({ profileId: target.profileId, linkId: input.linkId.toLowerCase(), day, clicks: 1 }).onConflictDoUpdate({ target: [dailyLinkMetrics.profileId, dailyLinkMetrics.linkId, dailyLinkMetrics.day], set: { clicks: sql`least(${dailyLinkMetrics.clicks} + 1, 1000000)` } });
    }
  });
}
export async function readAnalytics(input: Request | Headers) {
  const p = await requireUser(input);
  await rateLimit(`operations:analytics:${p.userId}`, 60, 60);
  const db = getDatabase(), days = analyticsDays();
  const [profile] = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.ownerId, p.userId));
  const views = profile ? await db.select({ day: dailyProfileMetrics.day, views: dailyProfileMetrics.views }).from(dailyProfileMetrics).where(and(eq(dailyProfileMetrics.profileId, profile.id), gte(dailyProfileMetrics.day, days[0]))).orderBy(asc(dailyProfileMetrics.day)).limit(30) : [];
  const clicks = profile ? await db.select({ day: dailyLinkMetrics.day, linkId: dailyLinkMetrics.linkId, clicks: dailyLinkMetrics.clicks }).from(dailyLinkMetrics).where(and(eq(dailyLinkMetrics.profileId, profile.id), gte(dailyLinkMetrics.day, days[0]))).orderBy(asc(dailyLinkMetrics.day), dailyLinkMetrics.linkId).limit(3000) : [];
  return { days: days.map(day => ({ day, views: views.find(v => v.day === day)?.views ?? 0, clicks: clicks.filter(c => c.day === day).reduce((n, c) => n + c.clicks, 0) })), links: clicks, limitations: "Approximate events, not unique people. Bots, repeats, privacy choices, blocked scripts and shared rate limits affect counts. No visitor identifiers, cookies, IP addresses, user agents or referrers are stored by analytics." };
}
