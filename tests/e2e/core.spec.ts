import { test, expect, account, app, apex, fixture, saved, state, publish, observeContext } from "./helpers";

test("invited owners edit privately, upload real media, publish and remain isolated", async ({ page, context, browser, expectedErrors }, info) => {
  // Username onboarding intentionally reads a profile before the claim exists.
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of 404.*\[https:\/\/app\.may-be\.localhost\/api\/profile\]$/);
  console.log(`ENGINE ${info.project.name}: ${browser.version()}`);
  const prefix = info.project.name;
  const owner = await account(page, `${prefix}-a`);
  const sibling = await browser.newContext({ ignoreHTTPSErrors: true, reducedMotion: "reduce" });
  const checkSibling = await observeContext(sibling, expectedErrors);
  const otherPage = await sibling.newPage();
  try {
    await account(otherPage, `${prefix}-b`);
    await otherPage.getByLabel("Display name", { exact: true }).fill("Other owner's private draft"); await saved(otherPage);
    const cookies = (await context.cookies()).filter(c => c.name.startsWith("__Host-"));
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) { expect(cookie.secure).toBe(true); expect(cookie.httpOnly).toBe(true); expect(cookie.sameSite).toBe("Lax"); expect(cookie.path).toBe("/"); expect(cookie.domain).toBe("app.may-be.localhost"); }
    expect(await context.cookies(`https://${prefix}-a.may-be.localhost`)).toHaveLength(0);
    expect((await context.request.get(`https://${prefix}-a.may-be.localhost`)).status()).toBe(404);
    expect((await context.request.get("https://unknown.may-be.localhost")).status()).toBe(404);
    const prefetch = await context.request.get(`https://${prefix}-a.may-be.localhost/editor?_rsc=acceptance`, { headers: { rsc: "1", "next-router-prefetch": "1", "next-router-state-tree": "%5B%5D" } });
    expect(prefetch.status()).toBe(404); expect(await prefetch.text()).not.toContain(owner.email);
    for (const host of [apex, `https://${prefix}-a.may-be.localhost`, "https://media.may-be.localhost"]) {
      for (const path of ["/editor", "/preview", "/account/security", "/api/profile", "/api/auth/get-session", "/admin"]) expect((await context.request.get(`${host}${path}`)).status(), `${host}${path}`).toBe(404);
    }
    expect((await context.request.get(`${app}/api/admin/reports`)).status()).toBe(403);
    const original = await state(context);
    expect((await context.request.put(`${app}/api/profile`, { headers: { origin: `https://${prefix}-b.may-be.localhost` }, data: { expectedVersion: original.editVersion, document: original.document } })).status()).toBe(403);
    // Real keyboard events: create and reorder without pointer dragging.
    await page.getByLabel("Display name", { exact: true }).fill("Public chosen name");
    await page.getByLabel("Public contact email (optional)", { exact: true }).fill("public-contact@example.invalid");
    await page.getByRole("button", { name: "Add a link", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByLabel("Link 1 label", { exact: true })).toBeFocused();
    await page.keyboard.type("First link"); await page.keyboard.press("Tab"); await page.keyboard.type(`${apex}/rules`);
    await page.getByRole("button", { name: "Add a link", exact: true }).click();
    await page.getByLabel("Link 2 label", { exact: true }).fill("Hidden destination");
    await page.getByLabel("Link 2 URL", { exact: true }).fill(`${apex}/privacy?private-draft=1`);
    await page.getByLabel("Show on public page").nth(1).uncheck(); await saved(page);
    const before = await state(context);
    await page.getByRole("button", { name: "Move link 2 up", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(page.getByLabel("Link 1 label", { exact: true })).toBeFocused(); await saved(page);
    expect((await state(context)).document.links.map((l: { id: string }) => l.id)).toEqual(before.document.links.map((l: { id: string }) => l.id).reverse());
    await page.getByLabel("Link 2 label", { exact: true }).fill("Visible edited link");
    await page.getByLabel("Show on public page").first().check(); await saved(page);
    await page.getByLabel("Show on public page").first().uncheck();
    const presets = page.getByRole("group", { name: "Appearance presets" }).getByRole("button");
    for (const preset of await presets.all()) { await preset.click(); await expect(preset).toHaveAttribute("aria-pressed", "true"); }
    await page.getByLabel("Layout", { exact: true }).selectOption("split");
    await page.getByLabel("Font", { exact: true }).selectOption("mono");
    await page.getByLabel("Background treatment", { exact: true }).selectOption("gradient");
    await page.getByLabel("Gradient direction", { exact: true }).selectOption("diagonal");
    await page.getByLabel("Link button shape", { exact: true }).selectOption("pill");
    await page.getByLabel("Spacing", { exact: true }).selectOption("airy");
    await page.getByLabel("Custom colours", { exact: true }).check();
    await page.getByLabel("Accent colour", { exact: true }).fill("#743810");
    await saved(page);
    expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    const files = await fixture("fixtures");
    let upload = page.waitForResponse(r => r.url().includes("/api/media?kind=image") && r.request().method() === "POST");
    await page.getByLabel("Upload image", { exact: false }).setInputFiles(files.image);
    expect((await upload).status()).toBe(202);
    await fixture("drain"); await page.getByRole("button", { name: "Refresh media", exact: true }).click();
    await expect(page.getByLabel("Avatar", { exact: true }).locator("option")).toHaveCount(2);
    const image = await page.getByLabel("Avatar", { exact: true }).locator("option").nth(1).getAttribute("value");
    expect(image).toBeTruthy();
    await page.getByLabel("Avatar", { exact: true }).selectOption(image!);
    await page.getByLabel("Background image", { exact: true }).selectOption(image!);
    expect((await sibling.request.get(`${app}/api/media/${image}/content`)).status()).toBe(404);
    upload = page.waitForResponse(r => r.url().includes("/api/media?kind=audio") && r.request().method() === "POST");
    await page.getByLabel("Upload music", { exact: false }).setInputFiles(files.audio);
    expect((await upload).status()).toBe(202);
    await fixture("drain"); await page.getByRole("button", { name: "Refresh media", exact: true }).click();
    await expect(page.getByLabel("Profile music", { exact: true }).locator("option")).toHaveCount(2);
    await page.getByLabel("Profile music", { exact: true }).selectOption({ index: 1 });
    await page.getByLabel("Music rights / attribution", { exact: true }).fill("Generated 440 Hz sine tone; original local test fixture");
    await saved(page);
    const media = await (await context.request.get(`${app}/api/media`, { headers: { "x-editor-profile": (await state(context)).profileId } })).json();
    expect(media.assets.filter((a: { state: string }) => a.state === "ready")).toHaveLength(2);
    expect(media.usage.chargedBytes).toBeGreaterThan(0); expect(media.usage.chargedBytes).toBeLessThan(media.quota.limitBytes);
    // Both actual iframe viewport sizes, rendering and authenticated image reads under CSP.
    for (const [button, width] of [["Desktop", 960], ["Mobile", 375]] as const) {
      await page.getByRole("button", { name: button, exact: true }).click();
      const frame = page.frameLocator("iframe");
      await expect(frame.getByRole("heading", { name: "Public chosen name", exact: true })).toBeVisible();
      expect(await page.locator("iframe").evaluate((el: HTMLIFrameElement) => el.contentWindow?.innerWidth)).toBe(width);
      await expect.poll(() => frame.locator("img").first().evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    }
    const viewsBefore = (await fixture("state", owner.email)).views;
    const preview = await context.newPage(); await preview.goto(`${app}/preview`);
    await expect(preview.getByRole("heading", { name: "Public chosen name", exact: true })).toBeVisible(); await preview.close();
    expect((await fixture("state", owner.email)).views).toBe(viewsBefore);
    // Publish directly after input: proves the action flushes valid pending edits.
    await page.getByLabel("Bio", { exact: true }).fill("Flushed on explicit publication"); await publish(page);
    const visitor = await context.newPage(); const response = await visitor.goto(`https://${prefix}-a.may-be.localhost`);
    expect(response?.status()).toBe(200);
    await expect(visitor.getByText("Flushed on explicit publication", { exact: true })).toBeVisible();
    await expect(visitor.getByRole("link", { name: /^Hidden destination/ })).toHaveCount(0);
    await expect(visitor.getByRole("link", { name: /^Visible edited link/ })).toBeVisible();
    const html = await visitor.content(); expect(html).not.toContain(owner.email); expect(html).not.toContain("Private auth"); expect(html).not.toContain("private-draft=1"); expect(html).toContain("public-contact@example.invalid");
    await expect.poll(() => visitor.locator("img").first().evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    const audio = visitor.locator("audio");
    await expect(audio).toHaveAttribute("preload", "none"); await expect(audio).toHaveAttribute("controls", "");
    expect(await audio.evaluate((el: HTMLAudioElement) => el.paused && !el.autoplay && el.currentTime === 0)).toBe(true);
    await visitor.getByRole("button", { name: "Play music", exact: true }).click();
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThan(0);
    expect(await audio.evaluate((el: HTMLAudioElement) => el.error?.message ?? null)).toBeNull();
    await audio.evaluate((el: HTMLAudioElement) => { el.currentTime = 1.5; });
    await expect.poll(() => audio.evaluate((el: HTMLAudioElement) => el.currentTime)).toBeGreaterThanOrEqual(1.4);
    await visitor.getByRole("button", { name: "Pause music", exact: true }).click();
    const audioURL = await audio.getAttribute("src");
    const range = await context.request.get(audioURL!, { headers: { range: "bytes=0-31" } }); expect(range.status()).toBe(206); expect((await range.body()).length).toBe(32);
    await expect.poll(async () => (await fixture("state", owner.email)).views).toBeGreaterThan(viewsBefore);
    const clicked = visitor.waitForResponse(r => r.url().endsWith("/api/metrics") && r.request().postDataJSON()?.event === "click");
    const opened = context.waitForEvent("page");
    await visitor.getByRole("link", { name: /^Visible edited link/ }).click({ button: "middle" });
    const destination = await opened; await expect(destination).toHaveURL(`${apex}/rules`);
    expect((await clicked).status()).toBe(204); await destination.close(); await visitor.close();
    const analytics = await (await context.request.get(`${app}/api/account/analytics`)).json();
    expect(analytics.days.some((d: { views: number }) => d.views > 0)).toBe(true);
    expect(analytics.links.some((d: { clicks: number }) => d.clicks > 0)).toBe(true);
    expect((await state(sibling)).document.displayName).toBe("Other owner's private draft");
    const stableVisibleId = (await state(context)).document.links[1].id;
    await page.getByRole("button", { name: "Delete link 1", exact: true }).click(); await saved(page);
    expect((await state(context)).document.links.map((l: { id: string }) => l.id)).toEqual([stableVisibleId]);
    // Native links and content remain usable without JavaScript.
    const native = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false });
    const checkNative = await observeContext(native, expectedErrors);
    try {
      const nativePage = await native.newPage(); await nativePage.goto(`https://${prefix}-a.may-be.localhost`);
      await expect(nativePage.getByRole("link", { name: /^Visible edited link/ })).toHaveAttribute("href", `${apex}/rules`);
      await nativePage.getByRole("link", { name: /^Visible edited link/ }).click(); await expect(nativePage).toHaveURL(`${apex}/rules`);
    } finally { await native.close(); checkNative(); }
    expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
    if (prefix === "mobile") expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await sibling.close(); checkSibling(); }
});
