import { describe, expect, it } from "vitest";
import { getSiteDomain, isAllowedPath, isValidUsername, reservedUsernames, resolveHost } from "@/domain/hosts";

describe("hostname authority", () => {
  it.each([
    ["may-be.gay", { kind: "apex" }],
    ["app.may-be.gay", { kind: "app" }],
    ["alex.may-be.gay", { kind: "profile", username: "alex" }],
    ["KAY-123.MAY-BE.GAY:443", { kind: "profile", username: "kay-123" }],
  ])("resolves only explicit production authorities: %s", (host, expected) => {
    expect(resolveHost(host as string, "may-be.gay")).toEqual(expected);
  });
  it.each([
    null, "", "localhost", "evil.example", "may-be.gay.evil.example", "evilmay-be.gay",
    "app.may-be.gay.", "foo.bar.may-be.gay", "foo..may-be.gay", ".may-be.gay",
    "may-be.gay@evil.example", "https://may-be.gay", "app.may-be.gay/path",
    " app.may-be.gay", "app.may-be.gay ", "app.may-be.gay\n", "app.may-be.gay,evil.example",
    "app.may-be.gay:3000", "app.may-be.gay:0", "app.may-be.gay:65536",
    "app.may-be.gay:0443", "app.may-be.gay:443:443", "[::1]", "ＡＰＰ.may-be.gay",
    "xn--alex.may-be.gay", "al.may-be.gay", "-alex.may-be.gay", "alex-.may-be.gay",
    "alex_name.may-be.gay", "alex%2eapp.may-be.gay", "app.may-be.localhost",
  ])("rejects malformed, unrelated or ambiguous Host: %s", host => {
    expect(resolveHost(host, "may-be.gay")).toEqual({ kind: "invalid" });
  });
  it("allows local development ports only on the configured local zone", () => {
    expect(resolveHost("app.may-be.localhost:3000", "may-be.localhost")).toEqual({ kind: "app" });
    expect(resolveHost("alex.may-be.localhost:443", "may-be.localhost")).toEqual({ kind: "profile", username: "alex" });
    expect(resolveHost("may-be.gay", "may-be.localhost")).toEqual({ kind: "invalid" });
  });
  it("does not use infrastructure labels as profile names", () => {
    for (const name of reservedUsernames) {
      expect(isValidUsername(name)).toBe(false);
      if (name !== "app") expect(resolveHost(`${name}.may-be.gay`, "may-be.gay")).toEqual({ kind: "invalid" });
    }
  });
  it("validates the configured zone independently of request values", () => {
    expect(getSiteDomain("may-be.gay")).toBe("may-be.gay");
    expect(getSiteDomain("may-be.localhost")).toBe("may-be.localhost");
    expect(() => getSiteDomain("evil.example/path")).toThrow("SITE_DOMAIN");
  });
});

describe("username format", () => {
  it.each(["abc", "123", "a-b", "a--b", "a".repeat(30)])("accepts %s", name => expect(isValidUsername(name)).toBe(true));
  it.each(["a", "ab", "a".repeat(31), "ABC", "xn--test", "a-b-", "-abc", "a_b", "åbc", "a.b", "abc\n"])("rejects %s", name => expect(isValidUsername(name)).toBe(false));
});

describe("route boundaries", () => {
  it("keeps examples/support on apex and health on app", () => {
    const apex = resolveHost("may-be.gay", "may-be.gay");
    const app = resolveHost("app.may-be.gay", "may-be.gay");
    const profile = resolveHost("alex.may-be.gay", "may-be.gay");
    for (const path of ["/support", "/examples"]) {
      expect(isAllowedPath(apex, path)).toBe(true);
      expect(isAllowedPath(app, path)).toBe(false);
      expect(isAllowedPath(profile, path)).toBe(false);
    }
    expect(isAllowedPath(app, "/api/health")).toBe(true);
    expect(isAllowedPath(profile, "/api/health")).toBe(false);
    expect(isAllowedPath(apex, "/api/health")).toBe(false);
  });
  it("does not expose future auth/editor/media endpoints or encoded path variants", () => {
    for (const host of ["may-be.gay", "app.may-be.gay", "alex.may-be.gay"]) {
      for (const path of ["/api/auth/sign-up/email", "/editor", "/preview", "/_next/image", "/%73upport", "/api/health/extra"]) {
        expect(isAllowedPath(resolveHost(host, "may-be.gay"), path)).toBe(false);
      }
    }
  });
});
