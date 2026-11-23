import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import sharp from "sharp";
import { gifFixture } from "../media/gif-fixture";
import { test, expect, account, app, fixture, state, editorSection, saved, publish } from "./helpers";

test("a GIF upload animates the avatar and background after publication", async ({ page, context, expectedErrors }) => {
  // Account setup opens the editor before a profile exists.
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of 404.*\[https:\/\/app\.may-be\.localhost\/api\/profile\]$/);
  await account(page, "gif-media");
  await editorSection(page, "Media");
  const input = await gifFixture();
  const picker = page.getByLabel("Upload image", { exact: false });
  await expect(picker).toHaveAttribute("accept", /image\/gif/);
  await expect(picker).toBeEnabled();
  const upload = page.waitForResponse(r => r.url().endsWith("/api/media?kind=image") && r.request().method() === "POST");
  await picker.setInputFiles({ name: "profile.gif", mimeType: "image/gif", buffer: input });
  expect((await upload).status()).toBe(202);
  await fixture("drain");
  await page.getByRole("button", { name: "Refresh media", exact: true }).click();

  const avatar = page.getByLabel("Avatar", { exact: true });
  await expect(avatar.locator("option")).toHaveCount(2);
  const assetId = await avatar.locator("option").nth(1).getAttribute("value");
  expect(assetId).toBeTruthy();
  await avatar.selectOption(assetId!);
  await page.getByLabel("Background image", { exact: true }).selectOption(assetId!);
  await saved(page);

  const preview = page.frameLocator("iframe");
  const profileImages = (view: typeof preview | typeof page) => [view.locator('main img[aria-hidden="true"]'), view.getByRole("img", { name: /’s avatar$/ })];
  for (const image of profileImages(preview)) {
    await expect(image).toHaveAttribute("src", `/api/media/${assetId}/content`);
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1280);
  }

  await publish(page);
  const visitor = await context.newPage();
  expect((await visitor.goto("https://gif-media.may-be.localhost"))?.status()).toBe(200);
  const [background, portrait] = profileImages(visitor);
  await expect(background).toHaveAttribute("src", /^https:\/\/media\.may-be\.localhost\/media\/.+\.webp$/);
  const url = (await background.getAttribute("src"))!;
  await expect(portrait).toHaveAttribute("src", url);
  const response = await context.request.get(url);
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("image/webp");
  const body = await response.body();
  expect(body.length).toBeLessThan(input.length);
  expect(await sharp(body, { animated: true }).metadata()).toMatchObject({ pages: 2, delay: [300, 500], loop: 0 });

  for (const image of [background, portrait]) {
    await expect.poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1280);
  }
  const [wall, face] = await Promise.all([background.boundingBox(), portrait.boundingBox()]);
  const colors = { background: new Set<string>(), avatar: new Set<string>() };
  async function sample(x: number, y: number) {
    const pixel = await visitor.screenshot({ clip: { x: Math.floor(x), y: Math.floor(y), width: 1, height: 1 } });
    const [red, , blue] = await sharp(pixel).raw().toBuffer();
    return red > blue + 30 ? "red" : blue > red + 30 ? "blue" : "other";
  }
  await expect.poll(async () => {
    colors.background.add(await sample(wall!.x + 4, wall!.y + 4));
    colors.avatar.add(await sample(face!.x + face!.width / 2, face!.y + face!.height / 2));
    return [colors.background.has("red"), colors.background.has("blue"), colors.avatar.has("red"), colors.avatar.has("blue")];
  }).toEqual([true, true, true, true]);
  await visitor.close();
});

test("the media library retains the original editor identity after a shared-cookie account switch", async ({ page, context, expectedErrors }) => {
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of (404|409).*\[https:\/\/app\.may-be\.localhost\/api\/(profile|media)/);
  const suffix = randomBytes(3).toString("hex");
  await account(page, `media-a-${suffix}`);
  await editorSection(page, "Media");
  const a = await state(context), files = await fixture("fixtures");
  const aUpload = page.waitForResponse(r => r.url().includes("/api/media?kind=image") && r.request().method() === "POST");
  await page.getByLabel("Upload image", { exact: false }).setInputFiles(files.image);
  const aUploaded = await aUpload; expect(aUploaded.status()).toBe(202);
  await fixture("drain");
  await page.getByRole("button", { name: "Refresh media", exact: true }).click();
  await expect(page.getByLabel("Avatar", { exact: true }).locator("option")).toHaveCount(2);
  const switcher = await context.newPage();
  await context.request.post(`${app}/api/auth/sign-out`, { headers: { origin: app }, data: {} });
  await account(switcher, `media-b-${suffix}`);
  await editorSection(switcher, "Media");
  const b = await state(context);
  const upload = switcher.waitForResponse(r => r.url().includes("/api/media?kind=image") && r.request().method() === "POST");
  await switcher.getByLabel("Upload image", { exact: false }).setInputFiles(files.image);
  expect((await upload).status()).toBe(202);
  await fixture("drain");
  const before = await (await context.request.get(`${app}/api/media`, { headers: { "x-editor-profile": b.profileId } })).json();
  expect(before.assets).toHaveLength(1);

  const refresh = page.waitForResponse(r => new URL(r.url()).pathname === "/api/media");
  await page.getByRole("button", { name: "Refresh media", exact: true }).click();
  const refreshed = await refresh;
  expect(refreshed.request().headers()["x-editor-profile"]).toBe(a.profileId);
  expect(refreshed.status()).toBe(409); expect((await refreshed.json()).error.code).toBe("ACCOUNT_CHANGED");
  await expect(page.getByText(/Sign in to the account that opened this editor before accessing its media library/)).toBeVisible();

  const staleUpload = page.waitForResponse(r => r.url().includes("/api/media?kind=image") && r.request().method() === "POST");
  await page.getByLabel("Upload image", { exact: false }).setInputFiles(files.image);
  const uploaded = await staleUpload;
  expect(uploaded.request().headers()["x-editor-profile"]).toBe(a.profileId);
  expect(uploaded.status()).toBe(409);
  // Chromium can discard the inspector copy of a file-upload response. The
  // application consumes it; assert its displayed code, then verify JSON via
  // the separate API requests below without relying on DevTools body retention.
  await expect(page.getByText("(ACCOUNT_CHANGED)", { exact: true })).toBeVisible();
  await page.getByText("Open asset library", { exact: true }).click();
  const staleDeletion = page.waitForResponse(r => r.request().method() === "DELETE" && new URL(r.url()).pathname.startsWith("/api/media/"));
  await page.getByRole("button", { name: /^Delete Image/ }).click();
  const deleted = await staleDeletion;
  expect(deleted.request().headers()["x-editor-profile"]).toBe(a.profileId);
  expect(deleted.status()).toBe(409); expect((await deleted.json()).error.code).toBe("ACCOUNT_CHANGED");

  const stale = { origin: app, "x-editor-profile": a.profileId };
  for (const response of [
    await context.request.get(`${app}/api/media`, { headers: stale }),
    await context.request.post(`${app}/api/media?kind=image`, { headers: stale, data: Buffer.from("stale-tab") }),
    await context.request.delete(`${app}/api/media/${before.assets[0].id}`, { headers: stale }),
  ]) { expect(response.status()).toBe(409); expect((await response.json()).error.code).toBe("ACCOUNT_CHANGED"); }
  const after = await (await context.request.get(`${app}/api/media`, { headers: { "x-editor-profile": b.profileId } })).json();
  expect(after).toEqual(before);
  // Browser image/audio loads cannot attach the editor header. Their separate
  // asset authorization remains usable by the current owner.
  expect((await context.request.get(`${app}/api/media/${before.assets[0].id}/content`)).status()).toBe(200);
  await switcher.close();
});

test("Caddy rejects an anonymous HTTP/1 upload before the client sends EOF", async () => {
  let upload: ReturnType<typeof httpsRequest> | undefined;
  try {
    const result = await new Promise<{ status: number; body: string; cache: string | undefined }>((resolve, reject) => {
      upload = httpsRequest({ hostname: "127.0.0.1", port: 443, path: "/api/media?kind=audio", method: "POST",
        // Same isolated internal CA exception as the browser fixture. The root
        // acceptance script separately verifies the actual CA chain.
        rejectUnauthorized: false, servername: "app.may-be.localhost", agent: false,
        headers: { host: "app.may-be.localhost", origin: app, "content-type": "application/octet-stream" },
      }, response => {
        let body = "";
        response.on("data", chunk => { body += chunk; if (body.length > 8192) upload?.destroy(new Error("Unbounded fixture response")); });
        response.on("error", reject);
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body, cache: response.headers["cache-control"] }));
      });
      upload.on("error", reject);
      upload.setTimeout(8000, () => upload?.destroy(new Error("Anonymous rejection waited for upload EOF")));
      upload.write(Buffer.alloc(32768)); // No end(): admission must respond first.
    });
    expect(result.status).toBe(401);
    expect(JSON.parse(result.body).error.code).toBe("SIGN_IN_REQUIRED");
    expect(result.cache).toContain("no-store");
  } finally { upload?.destroy(); }
});
