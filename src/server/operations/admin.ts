import "server-only";
import { randomBytes } from "node:crypto";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { adminActionSchema } from "@/domain/operations";
import { requireAdmin } from "@/server/auth/session";
import { getDatabase } from "@/server/db";
import { accountQuotas, serviceSettings } from "@/server/db/schema-settings";
import { auditEvents, invites, media, profiles, reports, user, usernameClaims } from "@/server/db/schema";
import { hashInviteToken, normalizeEmail } from "@/server/invites";
import { AppError } from "@/server/http";
import { rateLimit } from "@/server/rate-limit";
import { assertPrincipal, audit, lockOwner, operationsLock, pagination } from "./core";
import { detachAndRemoveMedia, journal, setSuspension } from "./recovery";

export async function readAdmin(input: Request | Headers, resource: string, url = new URL("https://app.invalid")) {
  const p = await requireAdmin(input), page = pagination(url);
  await rateLimit(`operations:admin-read:${p.userId}`, 120, 60);
  return getDatabase().transaction(async tx => {
    await assertPrincipal(tx, p, true);
    const { limit, offset } = page;
    if (resource === "reports") {
      const state = z.enum(["open", "reviewing", "resolved", "dismissed"]).optional().parse(url.searchParams.get("state") ?? undefined);
      const id = z.uuid().optional().parse(url.searchParams.get("id") ?? undefined);
      const rows = await tx.select({ id: reports.id, username: reports.targetUsername, profileId: reports.profileId, mediaId: reports.mediaId, linkId: reports.linkId, reason: reports.reason, state: reports.state, assignedTo: reports.assignedTo, createdAt: reports.createdAt,
        ...(id ? { details: reports.details, reporterEmail: reports.reporterEmail } : {}) }).from(reports)
        .where(and(state ? eq(reports.state, state) : undefined, id ? eq(reports.id, id) : undefined)).orderBy(desc(reports.createdAt), reports.id).limit(limit).offset(offset);
      return { rows, page };
    }
    if (resource === "accounts") {
      const q = z.string().max(100).parse(url.searchParams.get("q") ?? "").replace(/[%_\\]/g, "");
      const rows = await tx.select({ id: user.id, email: user.email, verified: user.emailVerified, role: user.role, suspendedAt: user.suspendedAt, deletedAt: user.deletedAt, username: usernameClaims.username, profileId: profiles.id, profileSuspendedAt: profiles.suspendedAt, publishedRevisionId: profiles.currentRevisionId, quotaBytes: accountQuotas.mediaLimitBytes })
        .from(user).leftJoin(usernameClaims, eq(usernameClaims.ownerId, user.id)).leftJoin(profiles, eq(profiles.ownerId, user.id)).leftJoin(accountQuotas, eq(accountQuotas.userId, user.id))
        .where(q ? or(ilike(user.email, `%${q}%`), ilike(usernameClaims.username, `%${q}%`)) : undefined).orderBy(user.createdAt, user.id).limit(limit).offset(offset);
      return { rows, page };
    }
    if (resource === "invites") {
      const rows = await tx.select({ id: invites.id, email: invites.email, expiresAt: invites.expiresAt, revokedAt: invites.revokedAt, redeemedAt: invites.redeemedAt }).from(invites).orderBy(desc(invites.createdAt), invites.id).limit(limit).offset(offset);
      return { rows, page };
    }
    if (resource === "settings") {
      const [settings] = await tx.select({ registrationMode: serviceSettings.registrationMode, uploadsPaused: serviceSettings.uploadsPaused, accountLimit: serviceSettings.accountLimit, totalMediaLimitBytes: serviceSettings.totalMediaLimitBytes }).from(serviceSettings).where(eq(serviceSettings.id, true));
      return { settings: settings ?? { registrationMode: "invite", uploadsPaused: false, accountLimit: 50, totalMediaLimitBytes: 5 * 1024 ** 3 } };
    }
    if (resource === "audit") return { rows: await tx.select({ id: auditEvents.id, actorId: auditEvents.actorId, subjectUserId: auditEvents.subjectUserId, action: auditEvents.action, createdAt: auditEvents.createdAt }).from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit).offset(offset), page };
    throw new AppError(404, "ADMIN_RESOURCE_NOT_FOUND", "Choose reports, accounts, invites, settings or audit.");
  });
}
export async function mutateAdmin(request: Request, raw: unknown) {
  const p = await requireAdmin(request), input = adminActionSchema.parse(raw);
  await rateLimit(`operations:admin-mutation:${p.userId}`, 60, 60);
  return getDatabase().transaction(async tx => {
    await operationsLock(tx);
    await lockOwner(tx, p.userId);
    await assertPrincipal(tx, p, true);
    if (input.action === "report") {
      const [report] = await tx.select({ id: reports.id }).from(reports).where(eq(reports.id, input.id)).for("update");
      if (!report) throw new AppError(404, "REPORT_NOT_FOUND", "Report no longer available.");
      await tx.update(reports).set({ state: input.state, resolvedAt: ["resolved", "dismissed"].includes(input.state) ? new Date() : null, ...(input.assign ? { assignedTo: input.assign === "me" ? p.userId : null } : {}) }).where(eq(reports.id, input.id));
      await audit(tx, p.userId, "report.review", undefined, { state: input.state, assignment: input.assign ?? "unchanged" }, input.id);
    } else if (input.action === "settings") {
      // Owner -> settings is identical to upload capacity lock order. Admission
      // locks settings before creating a new user, never an existing owner.
      await tx.insert(serviceSettings).values({ id: true }).onConflictDoNothing();
      await tx.select().from(serviceSettings).where(eq(serviceSettings.id, true)).for("update");
      const { action: _, ...settings } = input; void _;
      await tx.update(serviceSettings).set({ ...settings, updatedAt: new Date() }).where(eq(serviceSettings.id, true));
      await audit(tx, p.userId, "settings.update", undefined, settings);
    } else if (input.action === "invite") {
      // Transactional facade over the existing invite service's normalization,
      // hashing and table contract. No bootstrap option, role or implicit mail.
      const token = randomBytes(32).toString("base64url");
      const [invite] = await tx.insert(invites).values({ email: normalizeEmail(input.email), tokenHash: hashInviteToken(token), createdBy: p.userId, expiresAt: new Date(Date.now() + input.expiresInHours * 3600000) }).returning({ id: invites.id, email: invites.email, expiresAt: invites.expiresAt });
      await audit(tx, p.userId, "invite.issue", undefined, { inviteId: invite.id });
      return { invite: { ...invite, token } };
    } else if (input.action === "revoke-invite") {
      await tx.update(invites).set({ revokedAt: new Date() }).where(and(eq(invites.id, input.id), isNull(invites.revokedAt), isNull(invites.redeemedAt)));
      await audit(tx, p.userId, "invite.revoke", undefined, { inviteId: input.id });
    } else {
      const target = await lockOwner(tx, input.userId);
      if (!target || target.deletedAt) throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account unavailable.");
      if (input.action === "quota") {
        await tx.insert(serviceSettings).values({ id: true }).onConflictDoNothing();
        await tx.select().from(serviceSettings).where(eq(serviceSettings.id, true)).for("update");
        await tx.insert(accountQuotas).values({ userId: target.id, mediaLimitBytes: input.bytes }).onConflictDoUpdate({ target: accountQuotas.userId, set: { mediaLimitBytes: input.bytes, updatedAt: new Date() } });
        await audit(tx, p.userId, "quota.update", target.id, { bytes: input.bytes });
      } else if (input.action === "suspend") {
        if (target.id === p.userId || target.role === "admin") throw new AppError(409, "ADMIN_SAFETY_WORKFLOW_REQUIRED", "Administrator and self suspension require a separate operator recovery workflow.");
        const [profile] = await tx.select().from(profiles).where(eq(profiles.ownerId, target.id)).for("update");
        if (input.scope === "profile" && !profile) throw new AppError(404, "PROFILE_NOT_FOUND", "Profile unavailable.");
        await setSuspension(tx, target.id, input.scope, input.suspended, profile?.id);
        await journal(tx, input.scope === "account" ? { action: "account-suspension", ownerId: target.id, suspended: input.suspended } : { action: "profile-suspension", ownerId: target.id, profileId: profile!.id, suspended: input.suspended });
        await audit(tx, p.userId, "moderation.suspension", target.id, { scope: input.scope, suspended: input.suspended });
      } else {
        const [asset] = await tx.select({ id: media.id }).from(media).where(and(eq(media.id, input.mediaId), eq(media.ownerId, target.id)));
        if (!asset) throw new AppError(404, "MEDIA_NOT_FOUND", "Media asset unavailable.");
        await detachAndRemoveMedia(tx, target.id, input.mediaId);
        await journal(tx, { action: "remove-media", ownerId: target.id, assetId: input.mediaId });
        await audit(tx, p.userId, "moderation.media-remove", target.id, { assetId: input.mediaId });
      }
    }
    return { ok: true };
  });
}
