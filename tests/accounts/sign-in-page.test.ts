import { describe, it, expect, vi, beforeEach } from "vitest";
import { readReturnTo, resolveSignedInPath } from "@/domain/auth-redirect";

const mocks = vi.hoisted(() => ({
  headers: vi.fn<() => Promise<Headers>>(),
  redirect: vi.fn<(url: string) => never>(),
  getSession: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));

import SignInPage from "@/app/(auth)/sign-in/page";

describe("sign-in redirect resolution", () => {
  it("allows only known signed-in application pages as returnTo targets", () => {
    for (const path of ["/editor", "/preview", "/account", "/account/security", "/account/analytics", "/admin"]) {
      expect(readReturnTo(path)).toBe(path);
    }
    for (const invalid of [
      undefined,
      ["/editor"],
      "",
      "/",
      "/sign-in",
      "/sign-up",
      "/api/account/session",
      "//evil.invalid",
      "https://evil.invalid",
      "/\\evil.invalid",
      "/editor?foo=bar",
    ]) {
      expect(readReturnTo(invalid)).toBeUndefined();
    }
  });

  it("resolves destination for already signed-in users", () => {
    expect(resolveSignedInPath({})).toBe("/editor");
    expect(resolveSignedInPath({ username: "alice" })).toBe("/editor?username=alice");
    expect(resolveSignedInPath({ returnTo: "/preview" })).toBe("/preview");
    expect(resolveSignedInPath({ returnTo: "/editor", username: "alice" })).toBe("/editor?username=alice");
    expect(resolveSignedInPath({ returnTo: "/account/security" })).toBe("/account/security");
    expect(resolveSignedInPath({ returnTo: "https://evil.invalid", username: "alice" })).toBe("/editor?username=alice");
    expect(resolveSignedInPath({ returnTo: "/sign-in" })).toBe("/editor");
    expect(resolveSignedInPath({ emailVerified: false })).toBe("/verify-email");
    expect(resolveSignedInPath({ emailVerified: false, username: "alice" })).toBe("/verify-email?username=alice");
  });
});

describe("sign-in page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SITE_DOMAIN", "may-be.localhost");
    mocks.headers.mockResolvedValue(new Headers({ host: "app.may-be.localhost" }));
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    });
  });

  it("redirects an already signed-in user to the editor by default", async () => {
    mocks.getSession.mockResolvedValue({
      userId: "user-1",
      sessionId: "sess-1",
      email: "user@example.invalid",
      emailVerified: true,
      role: "user",
      authenticatedAt: new Date(),
    });

    await expect(SignInPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT:/editor");
    expect(mocks.redirect).toHaveBeenCalledWith("/editor");
  });

  it("redirects an already signed-in user to a valid returnTo path and preserves claim username for editor", async () => {
    mocks.getSession.mockResolvedValue({
      userId: "user-1",
      sessionId: "sess-1",
      email: "user@example.invalid",
      emailVerified: true,
      role: "user",
      authenticatedAt: new Date(),
    });

    await expect(SignInPage({ searchParams: Promise.resolve({ returnTo: "/preview" }) })).rejects.toThrow("NEXT_REDIRECT:/preview");
    await expect(SignInPage({ searchParams: Promise.resolve({ returnTo: "/editor", username: "alice" }) })).rejects.toThrow("NEXT_REDIRECT:/editor?username=alice");
    await expect(SignInPage({ searchParams: Promise.resolve({ returnTo: "https://evil.invalid" }) })).rejects.toThrow("NEXT_REDIRECT:/editor");
  });

  it("renders the sign-in form when the visitor is not signed in", async () => {
    mocks.getSession.mockResolvedValue(null);

    const element = await SignInPage({ searchParams: Promise.resolve({ username: "alice", returnTo: "/preview" }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(element.props).toMatchObject({
      mode: "sign-in",
      claimUsername: "alice",
      returnTo: "/preview",
      siteDomain: "may-be.localhost",
    });

    const invalid = await SignInPage({ searchParams: Promise.resolve({ returnTo: "https://evil.invalid" }) });
    expect(invalid.props.returnTo).toBeUndefined();
  });
});
