import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";
import { getPublishedProfile } from "@/server/profiles";
import { defaultProfileDocument } from "@/domain/profile";

vi.mock("@/server/profiles", () => ({ getPublishedProfile: vi.fn() }));
beforeEach(() => {
  vi.mocked(getPublishedProfile).mockResolvedValue({ id: "fixture", username: "alex", revisionId: "revision", document: defaultProfileDocument });
});

function request(host: string, path = "/", headers: Record<string, string> = {}, method = "GET") {
  return new NextRequest(`https://may-be.gay${path}`, { headers: { host, ...headers }, method });
}
afterEach(() => vi.unstubAllEnvs());

describe("request boundary and security headers", () => {
  it("ignores forwarded authority and overwrites caller-supplied nonce/CSP", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    const result = await proxy(request("alex.may-be.gay", "/", {
      "x-forwarded-host": "app.may-be.gay", "forwarded": "host=app.may-be.gay",
      "x-nonce": "attacker", "content-security-policy": "script-src 'unsafe-inline'",
      cookie: "__Host-session=private",
    }));
    expect(result.status).toBe(200);
    const overridden = result.headers.get("x-middleware-override-headers")?.split(",");
    expect(overridden).not.toContain("cookie");
    expect(overridden).not.toContain("forwarded");
    expect(overridden).not.toContain("x-forwarded-host");
    expect(result.headers.get("x-middleware-request-x-nonce")).not.toBe("attacker");
    expect(result.headers.get("content-security-policy")).toContain("'strict-dynamic'");
    expect(result.headers.get("content-security-policy")).not.toContain("attacker");
  });
  it("cannot turn another host into the editor through forwarded headers or RSC", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    for (const host of ["alex.may-be.gay", "evil.example"]) {
      const result = await proxy(request(host, "/api/health", { "x-forwarded-host": "app.may-be.gay", rsc: "1" }));
      expect(result.status).toBe(404);
      expect(result.headers.get("cache-control")).toContain("no-store");
    }
  });
  it("applies no-store and restrictive headers to allowed pages and rejected requests", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    for (const host of ["may-be.gay", "app.may-be.gay", "alex.may-be.gay", "evil.example"]) {
      const result = await proxy(request(host));
      expect(result.headers.get("cache-control")).toContain("no-store");
      expect(result.headers.get("cdn-cache-control")).toBe("no-store");
      expect(result.headers.get("x-content-type-options")).toBe("nosniff");
      expect(result.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(result.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });
  it("generates a fresh nonce for every request and forbids mutations", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    const first = await proxy(request("may-be.gay"));
    const second = await proxy(request("may-be.gay"));
    expect(first.headers.get("content-security-policy")).not.toBe(second.headers.get("content-security-policy"));
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const result = await proxy(request("app.may-be.gay", "/", {}, method));
      expect(result.status).toBe(405);
      expect(result.headers.get("allow")).toBe("GET, HEAD");
    }
  });

  it("returns a real 404 before an unknown profile can start an RSC stream", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    vi.mocked(getPublishedProfile).mockResolvedValue(null);
    const result = await proxy(request("unknown.may-be.gay", "/?_rsc=test", { rsc: "1" }));
    expect(result.status).toBe(404);
    expect(result.headers.get("cache-control")).toContain("no-store");
  });

  it("returns a generic non-cacheable 503 on database failure", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(getPublishedProfile).mockRejectedValue(new Error("PRIVATE DB FAILURE DETAILS"));
    const result = await proxy(request("alex.may-be.gay"));
    expect(result.status).toBe(503);
    expect(await result.text()).not.toContain("PRIVATE");
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
});
