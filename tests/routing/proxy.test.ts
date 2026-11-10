import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config } from "@/proxy";
import { proxy } from "@/proxy";
import { getPublishedProfile } from "@/server/profiles";
import { defaultProfileDocument } from "@/domain/profile";
import { serviceState } from "@/server/service-state";

vi.mock("@/server/profiles", () => ({ getPublishedProfile: vi.fn() }));
vi.mock("@/server/service-state", () => ({ serviceState: vi.fn() }));
beforeEach(() => {
  vi.mocked(serviceState).mockResolvedValue("open");
  vi.mocked(getPublishedProfile).mockResolvedValue({ id: "fixture", username: "alex", revisionId: "revision", document: defaultProfileDocument });
});

function request(host: string, path = "/", headers: Record<string, string> = {}, method = "GET") {
  return new NextRequest(`https://may-be.gay${path}`, { headers: { host, ...headers }, method });
}
afterEach(() => vi.unstubAllEnvs());

describe("request boundary and security headers", () => {
  it("excludes only the raw collection path from Next body cloning", () => {
    for (const path of ["/api/media", "/api/media?kind=image", "/api/media/"]) {
      expect(unstable_doesMiddlewareMatch({config, url:`https://app.may-be.gay${path}`})).toBe(false);
    }
    for (const path of ["/api/media/id", "/api/media/id/content", "/api/medial", "/api/%6dedia", "/api/media%2f", "/api/media.json", "/API/media"]) {
      expect(unstable_doesMiddlewareMatch({config, url:`https://app.may-be.gay${path}`})).toBe(true);
    }
  });

  it.each(["closed", "unavailable"] as const)("blocks HTML, RSC, media and mutations while service is %s", async state => {
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    vi.mocked(serviceState).mockResolvedValue(state);
    for (const [host, path, method] of [["alex.may-be.gay", "/?_rsc=fixture", "GET"], ["app.may-be.gay", "/api/profile", "PUT"], ["media.may-be.gay", "/media/v1/file", "GET"], ["may-be.gay", "/", "GET"]]) {
      const result = await proxy(request(host, path, { rsc: "1" }, method));
      expect(result.status).toBe(503);
      expect(result.headers.get("cache-control")).toContain("no-store");
      expect(result.headers.get("retry-after")).toBe("60");
    }
  });
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
  it("admits only each implemented mutation method and host", async () => {
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    expect((await proxy(request("app.may-be.gay", "/api/profile", {}, "PUT"))).status).toBe(200);
    expect((await proxy(request("app.may-be.gay", "/api/profile", {}, "POST"))).status).toBe(405);
    expect((await proxy(request("alex.may-be.gay", "/api/profile", {}, "PUT"))).status).toBe(404);
    expect((await proxy(request("may-be.gay", "/api/reports", {}, "POST"))).status).toBe(200);
    expect((await proxy(request("app.may-be.gay", "/api/reports", {}, "POST"))).status).toBe(404);
    expect((await proxy(request("alex.may-be.gay", "/api/metrics", {}, "POST"))).status).toBe(200);
    const app = await proxy(request("app.may-be.gay", "/editor"));
    expect(app.headers.get("content-security-policy")).toContain("media-src 'self' https://media.may-be.gay");
    expect(app.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(app.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});
