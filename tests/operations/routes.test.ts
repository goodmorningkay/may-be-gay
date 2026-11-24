import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/http";
const mocks = vi.hoisted(() => ({ admin: vi.fn(), user: vi.fn(), mutate: vi.fn(), read: vi.fn(), report: vi.fn(), metrics: vi.fn() }));
vi.mock("@/server/auth/session", () => ({ requireAdmin: mocks.admin, requireUser: mocks.user }));
vi.mock("@/server/operations/admin", () => ({ readAdmin: mocks.read, mutateAdmin: mocks.mutate }));
vi.mock("@/server/operations/reports", () => ({ submitReport: mocks.report }));
vi.mock("@/server/operations/analytics", () => ({ recordMetric: mocks.metrics }));
import { POST as adminPost } from "@/app/api/admin/[resource]/route";
import { POST as reportsPost } from "@/app/api/reports/route";
import { POST as metricsPost } from "@/app/api/metrics/route";
const req = (host: string, body: unknown, origin = `https://${host}`) => new Request(`https://${host}/api/metrics`, { method: "POST", headers: { host, origin, "content-type": "application/json" }, body: JSON.stringify(body) });
describe("operations route boundaries", () => {
  beforeEach(() => { vi.stubEnv("SITE_DOMAIN", "may-be.localhost"); vi.resetAllMocks(); });
  it.each(["SIGN_IN_REQUIRED", "ADMIN_2FA_REQUIRED", "REAUTHENTICATION_REQUIRED", "ORIGIN_REJECTED"])("rejects %s before parsing/actions and supplies security links", async code => {
    mocks.admin.mockRejectedValue(new AppError(403, code, "Confirm access."));
    const response = await adminPost(req("app.may-be.localhost", { action: "invite" }), { params: Promise.resolve({ resource: "actions" }) });
    expect(response.status).toBe(403); expect(await response.json()).toMatchObject({ links: { security: "/account/security" } }); expect(mocks.mutate).not.toHaveBeenCalled();
  });
  it("bounds bytes and rejects role fields", async () => {
    mocks.admin.mockResolvedValue({ userId: "admin" });
    const response = await adminPost(req("app.may-be.localhost", { action: "invite", email: "a@example.invalid", role: "admin" }), { params: Promise.resolve({ resource: "actions" }) });
    expect(response.status).toBe(400); expect(mocks.mutate).not.toHaveBeenCalled();
    const oversized = await adminPost(req("app.may-be.localhost", { action: "x", text: "a".repeat(5000) }), { params: Promise.resolve({ resource: "actions" }) }); expect(oversized.status).toBe(413);
  });
  it("public reports do not depend on sessions and conceal invalid targets", async () => {
    const response = await reportsPost(req("may-be.localhost", { username: "unknown", reason: "other" }));
    expect(response.status).toBe(202); expect(mocks.admin).not.toHaveBeenCalled(); expect(mocks.user).not.toHaveBeenCalled();
    const rejected = await reportsPost(req("may-be.localhost", {}, "https://alice.may-be.localhost")); expect(rejected.status).toBe(400);
  });
  it("honors privacy signals/prefetch and exact tenant origin before metrics", async () => {
    for (const signal of ["dnt", "sec-gpc", "rsc", "next-router-prefetch"]) {
      const request = req("alice.may-be.localhost", { event: "view" }); request.headers.set(signal, "1"); expect((await metricsPost(request)).status).toBe(204);
    }
    expect(mocks.metrics).not.toHaveBeenCalled();
    expect((await metricsPost(req("alice.may-be.localhost", { event: "view" }, "https://bob.may-be.localhost"))).status).toBe(400);
    expect((await metricsPost(req("alice.may-be.localhost", { event: "view" }))).status).toBe(204); expect(mocks.metrics).toHaveBeenCalledWith("alice", { event: "view" });
  });
});

describe("native public report fallback", () => {
  it("accepts POST form fields without reflecting private contact into HTML", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.localhost");
    const response = await reportsPost(new Request("https://may-be.localhost/api/reports", { method: "POST", headers: { host: "may-be.localhost", origin: "https://may-be.localhost", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ username: "alice", reason: "other", contact: "private@example.invalid", details: "private details", linkId: "", mediaId: "", website: "" }).toString() }));
    expect(response.status).toBe(202); expect(response.headers.get("content-type")).toContain("text/html"); const text = await response.text(); expect(text).not.toContain("private@example.invalid"); expect(text).not.toContain("private details");
    expect(mocks.report).toHaveBeenCalledWith({ username: "alice", reason: "other", contact: "private@example.invalid", details: "private details", website: "" });
  });
  it("bounds native form bytes and rejects duplicate fields", async () => {
    for (const body of ["username=alice&username=bob", `details=${"x".repeat(4097)}`]) {
      const response = await reportsPost(new Request("https://may-be.localhost/api/reports", { method: "POST", headers: { host: "may-be.localhost", origin: "https://may-be.localhost", "content-type": "application/x-www-form-urlencoded" }, body })); expect(response.status).toBe(400);
    }
  });
});


describe("native targeted reports", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const native = (body: string, origin = "https://may-be.localhost") => new Request("https://may-be.localhost/api/reports", { method: "POST", headers: { host: "may-be.localhost", origin, "content-type": "application/x-www-form-urlencoded" }, body });
  beforeEach(() => { vi.stubEnv("SITE_DOMAIN", "may-be.localhost"); vi.resetAllMocks(); });
  it.each(["link", "media"])("converts the %s choice to the existing validated service contract", async kind => {
    expect((await reportsPost(native(new URLSearchParams({ username: "alice", reason: "other", target: `${kind}:${id}` }).toString()))).status).toBe(202);
    expect(mocks.report).toHaveBeenCalledWith({ username: "alice", reason: "other", [kind === "link" ? "linkId" : "mediaId"]: id });
  });
  it("rejects malformed, duplicate and mixed target references", async () => {
    for (const body of ["target=invalid", "target=&target=", `target=link:${id}&mediaId=`, "linkId=&linkId=", `target=link:${id}&linkId=${id}`]) {
      expect((await reportsPost(native(body))).status).toBe(400);
    }
    expect(mocks.report).not.toHaveBeenCalled();
  });
  it.each(["null", "https://alice.may-be.localhost", "https://forged.invalid"])("still rejects Origin %s before submission", async origin => {
    expect((await reportsPost(native("username=alice&reason=other", origin))).status).toBe(400);
    expect(mocks.report).not.toHaveBeenCalled();
  });
});
