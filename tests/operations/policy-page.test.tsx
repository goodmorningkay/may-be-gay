import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const mocks = vi.hoisted(() => ({
  requireApexPage: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/server/operations/pages", () => ({
  requireApexPage: mocks.requireApexPage,
}));

import { PolicyPage } from "@/components/operations/policy-page";

describe("PolicyPage", () => {
  beforeEach(() => {
    mocks.requireApexPage.mockResolvedValue(undefined);
    vi.unstubAllEnvs();
  });

  it.each(["privacy", "terms", "rules"] as const)("renders finalized %s copy without draft or operator sections", async kind => {
    const html = renderToStaticMarkup(await PolicyPage({ kind }));
    expect(html).not.toContain("Development draft");
    expect(html).not.toContain("Operator and audience");
    expect(html.toLowerCase()).not.toContain("pending");
  });

  it("renders light, permissive rules with no-NSFW media guidance by default", async () => {
    const html = renderToStaticMarkup(await PolicyPage({ kind: "rules" }));
    expect(html).toContain(">Rules</h1>");
    expect(html).toContain("No NSFW media");
    expect(html).toContain("nudity");
    expect(html).toContain('href="/support"');
  });

  it("renders finalized safe-default privacy and terms copy", async () => {
    const privacy = renderToStaticMarkup(await PolicyPage({ kind: "privacy" }));
    expect(privacy).toContain(">Privacy</h1>");
    expect(privacy).toContain("What is public");
    expect(privacy).toContain("rolling schedule");

    const terms = renderToStaticMarkup(await PolicyPage({ kind: "terms" }));
    expect(terms).toContain(">Terms</h1>");
    expect(terms).toContain("Publishing your page");
    expect(terms).toContain("Media rights and takedown");
  });

  it("still respects optional environment policy overrides", async () => {
    vi.stubEnv("POLICY_CONTENT_RULES", "Custom content rule override.");
    const html = renderToStaticMarkup(await PolicyPage({ kind: "rules" }));
    expect(html).toContain("Custom content rule override.");
  });
});
