import { randomBytes } from "node:crypto";
import { request as httpsRequest } from "node:https";
import { test, expect, account, app, fixture, state } from "./helpers";

test("the media library retains the original editor identity after a shared-cookie account switch", async ({ page, context, expectedErrors }) => {
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of (404|409).*\[https:\/\/app\.may-be\.localhost\/api\/(profile|media)/);
  const suffix = randomBytes(3).toString("hex");
  await account(page, `media-a-${suffix}`);
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
  await page.getByText(/^Asset library/).click();
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
