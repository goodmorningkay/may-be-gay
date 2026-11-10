import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { assertAppHost, assertMutationOrigin, assertLocalRedirect, readJson, apiError, AppError } from "@/server/http";

describe("account HTTP boundaries", () => {
  vi.stubEnv("SITE_DOMAIN", "may-be.localhost");
  it("rejects sibling hosts, forwarded host spoofing and non-exact origins", () => {
    expect(() => assertAppHost(new Headers({ host: "person.may-be.localhost", "x-forwarded-host": "app.may-be.localhost" }))).toThrow();
    for (const origin of ["https://person.may-be.localhost", "null", "https://app.may-be.localhost.evil.invalid", "http://app.may-be.localhost"]) {
      expect(() => assertMutationOrigin(new Request("https://app.may-be.localhost/x", { method: "POST", headers: { host: "app.may-be.localhost", origin } }))).toThrow();
    }
    expect(() => assertMutationOrigin(new Request("https://app.may-be.localhost/x", { method: "POST", headers: { host: "app.may-be.localhost", origin: "https://app.may-be.localhost" } }))).not.toThrow();
  });
  it("restricts all callback URLs to the exact application origin", () => {
    for (const value of ["//evil.invalid", "https://evil.invalid", "/\\evil.invalid", "https://person.may-be.localhost", "/\nother"]) expect(() => assertLocalRedirect(value)).toThrow();
    expect(() => assertLocalRedirect("/account/security")).not.toThrow();
  });
  it("bounds streamed bytes even with missing Content-Length and multibyte text", async () => {
    const request = new Request("https://app.may-be.localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "💜".repeat(40) }) });
    await expect(readJson(request, z.object({ text: z.string() }), 100)).rejects.toMatchObject({ status: 413 });
  });
  it("redacts unexpected errors and never caches them", async () => {
    const response = apiError(new Error("password=private-token"));
    expect(await response.text()).not.toContain("private-token");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(apiError(new AppError(403, "DENIED", "Denied")).status).toBe(403);
  });
});
