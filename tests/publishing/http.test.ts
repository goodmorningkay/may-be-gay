import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultProfileDocument } from "@/domain/profile";
import { AppError } from "@/server/http";
import { GET, PUT } from "@/app/api/profile/route";
import { POST as publish } from "@/app/api/profile/publish/route";
import { POST as unpublish } from "@/app/api/profile/unpublish/route";
import { POST as restore } from "@/app/api/profile/revisions/[id]/restore/route";

const auth = vi.hoisted(() => ({ requireUser: vi.fn() }));
const services = vi.hoisted(() => ({ getProfileEditor: vi.fn(), saveProfile: vi.fn(), publishProfile: vi.fn(), unpublishProfile: vi.fn(), restoreProfileRevision: vi.fn() }));
vi.mock("@/server/auth/session", () => auth);
vi.mock("@/server/profile-editor", async (original) => ({ ...await original<typeof import("@/server/profile-editor")>(), ...services }));

const principal = { userId: "session-owner", sessionId: "session-id", email: "PRIVATE@example.com", emailVerified: true, role: "user", authenticatedAt: new Date() };
const profileId = "c87aa6c9-c504-4bf1-a8a1-00fde9bb5f01";
const state = { profileId, username: "example", editVersion: 4, document: defaultProfileDocument, publishedRevisionId: null, revisions: [] };
const request = (path: string, method: string, body?: unknown) => new Request(`https://app.may-be.gay${path}`, {
  method, headers: { "content-type": "application/json", host: "app.may-be.gay", origin: "https://app.may-be.gay", "x-editor-profile": profileId },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
beforeEach(() => {
  auth.requireUser.mockReset().mockResolvedValue(principal);
  Object.values(services).forEach((mock) => mock.mockReset().mockResolvedValue(state));
});

describe("owner profile HTTP handlers", () => {
  it("returns only the agreed private draft shape with no-store and delegates the whole request to auth", async () => {
    const input = request("/api/profile", "GET");
    const response = await GET(input);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(state);
    expect(auth.requireUser).toHaveBeenCalledWith(input);
    expect(services.getProfileEditor).toHaveBeenCalledWith(principal);
  });
  it("passes only session authority and validated full documents to save", async () => {
    const response = await PUT(request("/api/profile", "PUT", { expectedVersion: 3, document: defaultProfileDocument }));
    expect(response.status).toBe(200);
    expect(services.saveProfile).toHaveBeenCalledWith(principal, { expectedVersion: 3, document: defaultProfileDocument }, profileId, { validated: true });
  });
  it.each(["ownerId", "profileId"])("rejects submitted %s authority rather than forwarding it", async (field) => {
    const response = await PUT(request("/api/profile", "PUT", { expectedVersion: 3, document: defaultProfileDocument, [field]: "someone-else" }));
    expect(response.status).toBe(400);
    expect(services.saveProfile).not.toHaveBeenCalled();
  });
  it("keeps publication, unpublication and restoration explicit and returns the same current-state shape", async () => {
    expect(await (await publish(request("/api/profile/publish", "POST", { expectedVersion: 3 }))).json()).toEqual(state);
    expect(services.publishProfile).toHaveBeenCalledWith(principal, 3, profileId, { validated: true });
    expect(await (await unpublish(request("/api/profile/unpublish", "POST", {}))).json()).toEqual(state);
    expect(services.unpublishProfile).toHaveBeenCalledWith(principal, profileId);
    expect(await (await restore(request(`/api/profile/revisions/${profileId}/restore`, "POST", { expectedVersion: 3 }), { params: Promise.resolve({ id: profileId }) })).json()).toEqual(state);
    expect(services.restoreProfileRevision).toHaveBeenCalledWith(principal, profileId, 3, profileId, { validated: true });
  });
  it.each([null, "invalid-id"])("requires the editor identity precondition on every mutation (%s)", async identity => {
    const requests = [
      request("/api/profile", "PUT", { expectedVersion: 3, document: defaultProfileDocument }),
      request("/api/profile/publish", "POST", { expectedVersion: 3 }),
      request("/api/profile/unpublish", "POST", {}),
      request(`/api/profile/revisions/${profileId}/restore`, "POST", { expectedVersion: 3 }),
    ];
    for (const input of requests) {
      if (identity === null) input.headers.delete("x-editor-profile");
      else input.headers.set("x-editor-profile", identity);
    }
    const responses = await Promise.all([
      PUT(requests[0]), publish(requests[1]), unpublish(requests[2]),
      restore(requests[3], { params: Promise.resolve({ id: profileId }) }),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("EDITOR_IDENTITY_REQUIRED");
    }
    for (const service of [services.saveProfile, services.publishProfile, services.unpublishProfile, services.restoreProfileRevision]) expect(service).not.toHaveBeenCalled();
  });
  it("returns actionable 409 errors without serializing private drafts or raw exceptions", async () => {
    services.publishProfile.mockRejectedValueOnce(new AppError(409, "EDIT_VERSION_CONFLICT", "Reload GET /api/profile and reconcile your changes."));
    const response = await publish(request("/api/profile/publish", "POST", { expectedVersion: 1 }));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: { code: "EDIT_VERSION_CONFLICT", message: "Reload GET /api/profile and reconcile your changes." } });
    services.saveProfile.mockRejectedValueOnce(new Error("PRIVATE SQL CONNECTION DETAILS"));
    const failure = await PUT(request("/api/profile", "PUT", { expectedVersion: 3, document: defaultProfileDocument }));
    expect(failure.status).toBe(500);
    expect(await failure.text()).not.toContain("PRIVATE");
  });
  it("stops before private services when authentication or origin enforcement rejects the request", async () => {
    auth.requireUser.mockRejectedValueOnce(new AppError(401, "SIGN_IN_REQUIRED", "Please sign in."));
    expect((await GET(request("/api/profile", "GET"))).status).toBe(401);
    expect(services.getProfileEditor).not.toHaveBeenCalled();
    auth.requireUser.mockRejectedValueOnce(new AppError(403, "ORIGIN_REJECTED", "Request origin rejected."));
    expect((await unpublish(request("/api/profile/unpublish", "POST", {}))).status).toBe(403);
    expect(services.unpublishProfile).not.toHaveBeenCalled();
  });
  it("bounds bytes and validates versions before any mutation", async () => {
    const oversized = request("/api/profile", "PUT", { expectedVersion: 3, document: { ...defaultProfileDocument, bio: "x".repeat(128 * 1024) } });
    expect((await PUT(oversized)).status).toBe(413);
    for (const expectedVersion of [0, -1, 1.5, "3", 2147483647]) {
      expect((await publish(request("/api/profile/publish", "POST", { expectedVersion }))).status).toBe(400);
    }
    expect(services.saveProfile).not.toHaveBeenCalled();
    expect(services.publishProfile).not.toHaveBeenCalled();
  });
});
