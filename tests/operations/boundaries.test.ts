import { describe, expect, it, vi } from "vitest";
import { adminActionSchema, analyticsDays, deleteAccountSchema, metricSchema, reportSchema, reportUrl, withoutAsset } from "@/domain/operations";
import { defaultProfileDocument } from "@/domain/profile";
import { assertPublicRequest } from "@/server/operations/public";
import { operationsError, pagination } from "@/server/operations/core";
import { recoveryPayloadSchema, recoveryRecordSchema } from "@/server/operations/recovery";
import { launchReadiness } from "@/server/operations/policy";
import { tarHeader } from "@/server/operations/export";
const id = "11111111-1111-4111-8111-111111111111";
describe("operations input and privacy boundaries", () => {
  vi.stubEnv("SITE_DOMAIN", "may-be.localhost");
  it("requires exact apex/profile origin and ignores forwarded identity", () => {
    const request = (host: string, origin?: string) => new Request(`https://${host}/api/reports`, { method: "POST", headers: { host, "x-forwarded-host": "may-be.localhost", ...(origin ? { origin } : {}) } });
    expect(assertPublicRequest(request("may-be.localhost", "https://may-be.localhost"), "apex").kind).toBe("apex");
    for (const [host, origin] of [["app.may-be.localhost", "https://may-be.localhost"], ["alice.may-be.localhost", "https://may-be.localhost"], ["may-be.localhost", undefined], ["may-be.localhost", "null"], ["may-be.localhost", "http://may-be.localhost"], ["may-be.localhost", "https://may-be.localhost.evil"]]) expect(() => assertPublicRequest(request(host!, origin), "apex")).toThrow();
    expect(assertPublicRequest(request("alice.may-be.localhost", "https://alice.may-be.localhost"), "profile")).toMatchObject({ username: "alice" });
  });
  it("restricts reports to bounded local references, reason and private contact", () => {
    expect(reportSchema.safeParse({ username: "alice", reason: "other", mediaId: id }).success).toBe(true);
    for (const data of [{ linkId: id, mediaId: id }, { details: "a".repeat(2001) }, { url: "http://internal/" }, { contact: "bad" }, { ownerId: "other" }]) expect(reportSchema.safeParse({ username: "alice", reason: "other", ...data }).success).toBe(false);
    const url = new URL(reportUrl("alice", { linkId: id }, "may-be.localhost")); expect(url.hostname).toBe("may-be.localhost"); expect(url.searchParams.get("linkId")).toBe(id);
  });
  it("accepts public registration settings while rejecting role escalation and invalid settings", () => {
    const settings = { action: "settings", registrationMode: "public", uploadsPaused: false, accountLimit: 100000, totalMediaLimitBytes: 0 };
    expect(adminActionSchema.safeParse(settings).success).toBe(true);
    expect(adminActionSchema.safeParse({ ...settings, accountLimit: null })).toMatchObject({ success: true, data: { accountLimit: null } });
    expect(adminActionSchema.safeParse({ action: "settings", registrationMode: "public", uploadsPaused: false, totalMediaLimitBytes: 0 })).toMatchObject({ success: true, data: { accountLimit: null } });
    for (const body of [{ action: "promote", userId: "other" }, { action: "invite", email: "a@example.invalid", role: "admin" }, { ...settings, registrationMode: "unknown" }, { ...settings, accountLimit: 0 }, { ...settings, accountLimit: 100001 }, { action: "quota", userId: "other", bytes: -1 }]) expect(adminActionSchema.safeParse(body).success).toBe(false);
    expect(deleteAccountSchema.safeParse({ confirmation: "DELETE MY ACCOUNT", ownerId: "other" }).success).toBe(false);
  });
  it("metrics permit only bounded event and stable link ID, never visitor metadata", () => {
    expect(metricSchema.safeParse({ event: "click", linkId: id }).success).toBe(true);
    for (const extra of ["ip", "ua", "referrer", "visitorId", "profileId", "username"]) expect(metricSchema.safeParse({ event: "view", [extra]: "private" }).success).toBe(false);
    expect(analyticsDays(new Date("2026-03-01T23:59:00Z"))).toHaveLength(30);
    expect(analyticsDays(new Date("2026-03-01T23:59:00Z"))[0]).toBe("2026-01-31");
  });
  it("detaches only matching media fields without touching link or theme data", () => {
    const doc = { ...defaultProfileDocument, avatarAssetId: id, backgroundAssetId: id, music: { assetId: id, attribution: "By owner" } };
    const clean = withoutAsset(doc, id); expect(clean.avatarAssetId).toBeNull(); expect(clean.backgroundAssetId).toBeNull(); expect(clean.music).toBeNull(); expect(clean.links).toEqual(doc.links); expect(doc.avatarAssetId).toBe(id);
  });
  it("bounds pagination and provides helpful redacted errors", async () => {
    for (const query of ["limit=1000", "offset=-1", "offset=10001", "limit=0"]) expect(() => pagination(new URL(`https://app.invalid/?${query}`))).toThrow();
    expect(pagination(new URL("https://app.invalid/?offset=50&limit=25"))).toEqual({ offset: 50, limit: 25 });
    const response = operationsError(new Error("SECRET=token")); expect(await response.text()).not.toContain("token"); expect(response.headers.get("cache-control")).toBe("no-store");
  });
  it("tar uses generated paths, bounded octal sizes and correct checksum", () => {
    for (const path of ["../secret", "/etc/passwd", "a/../b", "a/./b", "a\nfile"]) expect(() => tarHeader(path, 1)).toThrow();
    const header = tarHeader(`media/${id}/original.webp`, 1024);
    const copy = Buffer.from(header), checksum = parseInt(header.subarray(148, 154).toString(), 8); copy.fill(32, 148, 156);
    expect(checksum).toBe(copy.reduce((n, c) => n + c, 0)); expect(header.subarray(257, 262).toString()).toBe("ustar");
  });
  it("keeps recovery payloads versioned, minimal and secret-free", () => {
    expect(recoveryPayloadSchema.safeParse({ action: "delete-account", ownerId: id }).success).toBe(true);
    expect(recoveryPayloadSchema.safeParse({ action: "delete-account", ownerId: id, email: "private@example.invalid" }).success).toBe(false);
    expect(recoveryRecordSchema.safeParse({ sequence: 1, version: 2, payload: { action: "delete-account", ownerId: id }, createdAt: new Date().toISOString() }).success).toBe(false);
  });
  it("keeps all unsettled launch decisions explicit without disabling local tools", () => {
    const config = launchReadiness({}); expect(config.ready).toBe(false); expect(config.missing).toContain("SUPPORT_EMAIL"); expect(config.missing).toContain("POLICY_REVIEWED"); expect(config.values.operator).toBeUndefined();
  });
});
