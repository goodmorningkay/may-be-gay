import "server-only";
import { sql } from "drizzle-orm";
import { reportSchema } from "@/domain/operations";
import { getDatabase } from "@/server/db";
import { mediaStorage } from "@/server/db/schema-media";
import { reports } from "@/server/db/schema";
import { activePublication } from "@/server/media/service";
import { rateLimit } from "@/server/rate-limit";
import { eq, and } from "drizzle-orm";
import { currentPublic } from "./public";
import { getPublishedProfile } from "@/server/profiles";

export type ReportTarget = { value: string; label: string };
/** Uses only the same published projection and resolved assets as the renderer.
 * No draft/history/owner query or visitor session can contribute picker options. */
export async function getReportTargets(username: string): Promise<ReportTarget[]> {
  const published = await getPublishedProfile(username);
  if (!published) return [];
  const { document, media } = published;
  const targets = document.links.map(link => ({ value: `link:${link.id.toLowerCase()}`, label: `Link: ${link.label}` }));
  const assets: [string, string | null | undefined][] = [["Avatar", document.avatarAssetId], ["Background", document.backgroundAssetId], ["Music", document.music?.assetId]];
  for (const [label, id] of assets) {
    if (id && media?.[id.toLowerCase()]) targets.push({ value: `media:${id.toLowerCase()}`, label });
  }
  return targets;
}
export async function submitReport(raw: unknown) {
  // Fixed keys and conservative shared budgets; never derive a visitor fingerprint.
  await rateLimit("operations:reports:global-minute", 12, 60);
  await rateLimit("operations:reports:global-day", 150, 86400);
  const input = reportSchema.safeParse(raw);
  if (!input.success || input.data.website) return;
  const data = input.data;
  await getDatabase().transaction(async tx => {
    const target = await currentPublic(tx, data.username);
    if (!target) return;
    if (data.linkId && !target.document.links.some(l => l.visible && l.id.toLowerCase() === data.linkId!.toLowerCase())) return;
    if (data.mediaId) {
      if (!target.assetIds.some(id => id.toLowerCase() === data.mediaId!.toLowerCase())) return;
      const [visible] = await tx.select({ id: mediaStorage.assetId }).from(mediaStorage).where(and(eq(mediaStorage.assetId, data.mediaId), eq(mediaStorage.state, "ready"), activePublication(mediaStorage.assetId)));
      if (!visible) return;
    }
    // Shared advisory lock makes the global retained queue bound race safe.
    await tx.execute(sql`select pg_advisory_xact_lock(740302, 2)`);
    const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(reports);
    if (count.n >= 10000) return;
    await tx.insert(reports).values({ profileId: target.profileId, targetUsername: data.username, mediaId: data.mediaId?.toLowerCase(), linkId: data.linkId?.toLowerCase(), reason: data.reason, details: data.details || null, reporterEmail: data.contact || null });
  });
}
