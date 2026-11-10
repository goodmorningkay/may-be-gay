import { z } from "zod";
import { getSiteDomain, isValidUsername } from "./hosts";
import type { ProfileDocument } from "./profile";

export const reportReasons = ["harassment", "impersonation", "unsafe-link", "copyright", "other"] as const;
export const reportSchema = z.object({
  username: z.string().max(30).refine(isValidUsername),
  linkId: z.uuid().optional(), mediaId: z.uuid().optional(),
  reason: z.enum(reportReasons), details: z.string().trim().max(2000).default(""),
  contact: z.union([z.email().max(254), z.literal("")]).optional(), website: z.string().max(200).default(""),
}).strict().refine(v => !(v.linkId && v.mediaId));
export const metricSchema = z.discriminatedUnion("event", [
  z.object({ event: z.literal("view") }).strict(),
  z.object({ event: z.literal("click"), linkId: z.uuid() }).strict(),
]);
export const adminActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("report"), id: z.uuid(), state: z.enum(["open", "reviewing", "resolved", "dismissed"]), assign: z.enum(["me", "none"]).optional() }).strict(),
  z.object({ action: z.literal("suspend"), userId: z.string().min(1).max(128), scope: z.enum(["account", "profile"]), suspended: z.boolean() }).strict(),
  z.object({ action: z.literal("remove-media"), userId: z.string().min(1).max(128), mediaId: z.uuid() }).strict(),
  z.object({ action: z.literal("quota"), userId: z.string().min(1).max(128), bytes: z.number().int().min(0).max(1024 ** 4) }).strict(),
  z.object({ action: z.literal("settings"), registrationMode: z.enum(["closed", "invite"]), uploadsPaused: z.boolean(), accountLimit: z.number().int().min(1).max(50), totalMediaLimitBytes: z.number().int().min(0).max(1024 ** 4) }).strict(),
  z.object({ action: z.literal("invite"), email: z.email().max(254), expiresInHours: z.number().int().min(1).max(168).default(72) }).strict(),
  z.object({ action: z.literal("revoke-invite"), id: z.uuid() }).strict(),
]);
export const deleteAccountSchema = z.object({ confirmation: z.literal("DELETE MY ACCOUNT") }).strict();
export function reportUrl(username: string, target: { linkId?: string; mediaId?: string } = {}, domain = getSiteDomain()): string {
  const params = new URLSearchParams({ username });
  if (target.linkId) params.set("linkId", target.linkId);
  if (target.mediaId) params.set("mediaId", target.mediaId);
  return `https://${domain}/support?${params}`;
}
export function withoutAsset(document: ProfileDocument, assetId: string): ProfileDocument {
  const matches = (id?: string | null) => id?.toLowerCase() === assetId.toLowerCase();
  return { ...document,
    ...(matches(document.avatarAssetId) ? { avatarAssetId: null } : {}),
    ...(matches(document.backgroundAssetId) ? { backgroundAssetId: null } : {}),
    ...(matches(document.music?.assetId) ? { music: null } : {}),
  };
}
export function analyticsDays(now = new Date()): string[] {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: 30 }, (_, i) => new Date(end - (29 - i) * 86400000).toISOString().slice(0, 10));
}
