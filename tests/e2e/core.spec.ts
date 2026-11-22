import { test, expect, account, app, apex, fixture, password, saved, state, publish, observeContext, editorSection } from "./helpers";

test("homepage keeps the requested address through public signup and verification", async ({ page, expectedErrors }, info) => {
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of 404.*\[https:\/\/app\.may-be\.localhost\/api\/profile\]$/);
  const username = `${info.project.name}-homepage`;
  const email = `${username}@example.invalid`;

  await page.goto(apex);
  await expect(page.getByRole("link", { name: "Log in" })).toHaveAttribute("href", `${app}/sign-in`);
  await page.getByRole("textbox", { name: "Username" }).fill(username);
  await page.getByRole("button", { name: "Claim address" }).click();
  await expect(page).toHaveURL(`${app}/sign-up?username=${username}`);

  await expect(page.getByRole("link", { name: "Privacy notice" })).toHaveAttribute("href", `${apex}/privacy`);
  await expect(page.getByLabel("Date of birth", { exact: true })).toHaveCount(0);

  await page.getByLabel("Your name").fill("Homepage test account");
  await expect(page.getByLabel("Invitation token")).toHaveCount(0);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create your account" }).click();
  await expect(page.getByRole("status")).toContainText("check your email");
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Resend verification email" })).toHaveAttribute("href", `/verify-email?username=${username}`);
  await fixture("drain");
  const [mail] = await fixture("mail", email);
  await page.goto(mail.url);
  await expect(page.getByRole("status")).toContainText("Email verified");

  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(`${app}/sign-in?username=${username}`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("textbox", { name: "Username" })).toHaveValue(username);

  await page.goto(apex);
  await page.getByRole("textbox", { name: "Username" }).fill(username);
  await page.getByRole("button", { name: "Claim address" }).click();
  await expect(page).toHaveURL(`${app}/editor?username=${username}`);
  await expect(page.getByRole("textbox", { name: "Username" })).toHaveValue(username);
  await page.getByRole("button", { name: "Claim address" }).click();
  await expect(page.getByLabel("Display name", { exact: true })).toBeVisible();
  await expect(page.frameLocator('iframe[title^="Private local profile preview"]').locator("main")).toHaveCount(1);
  await Promise.all(page.frames().map(frame => frame.evaluate(async () => { await document.fonts.ready; })));
  await page.goto(`${app}/account/analytics`);
  await expect(page.getByRole("heading", { name: "No activity recorded" })).toBeVisible();
  await page.goto(`${apex}/examples`);
  await expect(page.getByRole("heading", { name: "Explore a sample page" })).toBeVisible();
  await page.getByLabel("Look", { exact: true }).selectOption("sunset");
  await page.getByLabel("Layout", { exact: true }).selectOption("split");
  await page.getByRole("button", { name: "Try this look" }).click();
  await expect(page.locator("main")).toHaveAttribute("data-preset", "sunset");
  await expect(page.locator("main")).toHaveAttribute("data-layout", "split");
  await page.goto(`${apex}/privacy`);
  await expect(page.getByRole("navigation", { name: "Policies" }).getByRole("link", { name: "Privacy" })).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("Kay", { exact: true })).toBeVisible();
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of 404.*\[https:\/\/unknown\.may-be\.localhost\/\]$/);
  const missing = await page.goto("https://unknown.may-be.localhost/");
  expect(missing?.status()).toBe(404);
  await expect(page.getByRole("link", { name: "Go to may-be.gay", exact: true })).toHaveAttribute("href", apex);
});

test("owners edit privately, upload real media, publish and remain isolated", async ({ page, context, browser, expectedErrors }, info) => {
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
    await page.getByLabel("Public contact email", { exact: true }).fill("public-contact@example.invalid");
    await expect(page.getByRole("heading", { name: "Links", exact: true })).toBeHidden();
    await editorSection(page, "Links");
    await expect(page.getByLabel("Display name", { exact: true })).toBeHidden();
    const linkEditor = page.getByRole("dialog", { name: "Edit link" });
    const addLink = page.getByRole("button", { name: "Add link", exact: true });
    const editLink = (name: string) => page.getByRole("button", { name: new RegExp(`^${name}`) }).click();
    const closeLink = () => linkEditor.getByRole("button", { name: "Close link editor", exact: true }).click();
    await addLink.focus();
    await page.keyboard.press("Enter");
    await expect(linkEditor.getByLabel("Label", { exact: true })).toBeFocused();
    await page.keyboard.type("First link"); await page.keyboard.press("Tab"); await page.keyboard.type(`${apex}/rules`);
    await closeLink();
    await addLink.click();
    await closeLink();
    await editorSection(page, "About you");
    await page.getByRole("link", { name: /^links\.1\.url:/ }).click();
    await expect(linkEditor.getByLabel("URL", { exact: true })).toBeFocused();
    await linkEditor.getByLabel("Label", { exact: true }).fill("Hidden destination");
    await linkEditor.getByLabel("URL", { exact: true }).fill(`${apex}/privacy?private-draft=1`);
    await linkEditor.getByLabel("Show on public page").uncheck(); await closeLink(); await saved(page);
    const before = await state(context);
    await editLink("Hidden destination");
    await linkEditor.getByRole("button", { name: "Move up", exact: true }).focus(); await page.keyboard.press("Enter");
    await expect(linkEditor.getByLabel("Label", { exact: true })).toBeFocused();
    await closeLink(); await saved(page);
    expect((await state(context)).document.links.map((l: { id: string }) => l.id)).toEqual(before.document.links.map((l: { id: string }) => l.id).reverse());
    await editLink("First link");
    await linkEditor.getByLabel("Label", { exact: true }).fill("Visible edited link");
    await closeLink();
    await editLink("Hidden destination");
    await linkEditor.getByLabel("Show on public page").check(); await closeLink(); await saved(page);
    await editLink("Hidden destination");
    await linkEditor.getByLabel("Show on public page").uncheck(); await closeLink();
    await editorSection(page, "Appearance");
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
    await editorSection(page, "Media");
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
    await page.getByLabel("Upload MP3", { exact: false }).setInputFiles(files.audio);
    expect((await upload).status()).toBe(202);
    await fixture("drain"); await page.getByRole("button", { name: "Refresh media", exact: true }).click();
    await expect(page.getByLabel("Profile music", { exact: true }).locator("option")).toHaveCount(2);
    await page.getByLabel("Profile music", { exact: true }).selectOption({ index: 1 });
    await page.getByLabel("Music rights / attribution", { exact: true }).fill("Generated 440 Hz sine tone; original local test fixture");
    await saved(page);
    const media = await (await context.request.get(`${app}/api/media`, { headers: { "x-editor-profile": (await state(context)).profileId } })).json();
    expect(media.assets.filter((a: { state: string }) => a.state === "ready")).toHaveLength(2);
    expect(media.usage.chargedBytes).toBeGreaterThan(0); expect(media.usage.chargedBytes).toBeLessThan(media.quota.limitBytes);
    // The preview still uses real iframe viewport sizes and private media reads under CSP.
    const mobileView = page.getByRole("group", { name: "Editor view" });
    const isMobile = await mobileView.isVisible();
    if (isMobile) await mobileView.getByRole("button", { name: "Preview", exact: true }).click();
    for (const [button, width] of [["Desktop", 960], ["Mobile", 375]] as const) {
      if (isMobile && button === "Desktop") continue;
      if (!isMobile) await page.getByRole("button", { name: button, exact: true }).click();
      const frame = page.frameLocator("iframe");
      await expect(frame.getByRole("heading", { name: "Public chosen name", exact: true })).toBeVisible();
      await expect.poll(() => page.locator("iframe").evaluate((el: HTMLIFrameElement) => el.contentWindow?.innerWidth)).toBe(width);
      await expect.poll(() => frame.locator("img").first().evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);
    }
    if (isMobile) await mobileView.getByRole("button", { name: "Edit", exact: true }).click();
    await editorSection(page, "About you");
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
    expect(await audio.evaluate((el: HTMLAudioElement) => !el.autoplay && Math.abs(el.volume - 0.2) < 1e-6)).toBe(true);
    if (await audio.evaluate((el: HTMLAudioElement) => el.paused)) {
      await visitor.getByRole("button", { name: "Play music", exact: true }).click();
    }
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
    const analyticsPage = await context.newPage();
    await analyticsPage.goto(`${app}/account/analytics`);
    await expect(analyticsPage.getByRole("heading", { name: "Daily activity" })).toBeVisible();
    await expect(analyticsPage.getByRole("region", { name: "Daily counts" }).getByRole("row")).toHaveCount(31);
    await analyticsPage.close();
    expect((await state(sibling)).document.displayName).toBe("Other owner's private draft");
    const stableVisibleId = (await state(context)).document.links[1].id;
    await editorSection(page, "Links");
    await editLink("Hidden destination");
    await linkEditor.getByRole("button", { name: "Delete link", exact: true }).click(); await saved(page);
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
