import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn<() => Promise<Headers>>(),
  redirect: vi.fn<(url: string) => never>(),
  notFound: vi.fn<() => never>(),
  getSession: vi.fn(),
  getPublishedProfile: vi.fn(),
  isUsernameClaimed: vi.fn<(username: string) => Promise<boolean>>(),
  readRegistrationMode: vi.fn<() => Promise<"public" | "invite" | "closed">>(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect, notFound: mocks.notFound }));
vi.mock("@/server/auth/session", () => ({ getSession: mocks.getSession }));
vi.mock("@/server/profiles", () => ({ getPublishedProfile: mocks.getPublishedProfile }));
vi.mock("@/server/accounts", () => ({ isUsernameClaimed: mocks.isUsernameClaimed }));
vi.mock("@/server/invites", () => ({ readRegistrationMode: mocks.readRegistrationMode }));

import Home from "@/app/page";
import SignUpPage from "@/app/(auth)/sign-up/page";
import { Homepage } from "@/components/homepage/homepage";
import { AuthForm } from "@/components/auth/auth-form";

describe("claimed username warning popup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("SITE_DOMAIN", "may-be.gay");
    mocks.headers.mockResolvedValue(new Headers({ host: "may-be.gay" }));
    mocks.redirect.mockImplementation((url: string) => {
      throw new Error(`NEXT_REDIRECT:${url}`);
    });
    mocks.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mocks.getSession.mockResolvedValue(null);
    mocks.getPublishedProfile.mockResolvedValue(null);
    mocks.readRegistrationMode.mockResolvedValue("public");
  });

  it("redirects from the homepage to sign-up when the requested username is available", async () => {
    mocks.isUsernameClaimed.mockResolvedValue(false);

    await expect(Home({ searchParams: Promise.resolve({ username: "fresh-name" }) }))
      .rejects.toThrow("NEXT_REDIRECT:https://app.may-be.gay/sign-up?username=fresh-name");
    expect(mocks.isUsernameClaimed).toHaveBeenCalledWith("fresh-name");
  });

  it("keeps the visitor on the homepage with a taken-username popup when the handle is already claimed", async () => {
    mocks.isUsernameClaimed.mockResolvedValue(true);

    const element = await Home({ searchParams: Promise.resolve({ username: "kay" }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.isUsernameClaimed).toHaveBeenCalledWith("kay");
    expect(element.props).toMatchObject({
      appOrigin: "https://app.may-be.gay",
      domain: "may-be.gay",
      takenUsername: "kay",
    });

    const html = renderToStaticMarkup(element);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Username already taken");
    expect(html).toContain("kay.may-be.gay");
    expect(html).toContain("Choose another username");
    expect(html).toContain('href="https://app.may-be.gay/sign-in"');
  });

  it("does not query claimed status for invalid usernames on the homepage", async () => {
    const element = await Home({ searchParams: Promise.resolve({ username: "ab" }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.isUsernameClaimed).not.toHaveBeenCalled();
    expect(element.props).toMatchObject({
      rejectedUsername: "ab",
    });
    const html = renderToStaticMarkup(element);
    expect(html).not.toContain('role="alertdialog"');
    expect(html).toContain("Choose another username.");
  });

  it("shows a taken-username popup instead of Requested address when visiting /sign-up?username=<taken> directly", async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: "app.may-be.gay" }));
    mocks.isUsernameClaimed.mockResolvedValue(true);

    const element = await SignUpPage({ searchParams: Promise.resolve({ username: "kay" }) });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(element.props).toMatchObject({
      mode: "sign-up",
      claimUsername: undefined,
      takenUsername: "kay",
      siteDomain: "may-be.gay",
    });

    const html = renderToStaticMarkup(element);
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain("Username already taken");
    expect(html).toContain("kay.may-be.gay");
    expect(html).not.toContain("Requested address");
  });

  it("keeps Requested address on /sign-up when the username is available", async () => {
    mocks.headers.mockResolvedValue(new Headers({ host: "app.may-be.gay" }));
    mocks.isUsernameClaimed.mockResolvedValue(false);

    const element = await SignUpPage({ searchParams: Promise.resolve({ username: "available-name" }) });
    expect(element.props).toMatchObject({
      mode: "sign-up",
      claimUsername: "available-name",
      takenUsername: undefined,
    });

    const html = renderToStaticMarkup(element);
    expect(html).not.toContain('role="alertdialog"');
    expect(html).toContain("Requested address");
    expect(html).toContain("available-name.may-be.gay");
  });

  it("renders Homepage and AuthForm cleanly without the popup when no username is taken", () => {
    const homeHtml = renderToStaticMarkup(<Homepage appOrigin="https://app.may-be.gay" domain="may-be.gay" />);
    const authHtml = renderToStaticMarkup(<AuthForm mode="sign-up" siteDomain="may-be.gay" registrationMode="public" />);
    expect(homeHtml).not.toContain('role="alertdialog"');
    expect(authHtml).not.toContain('role="alertdialog"');
  });
});
