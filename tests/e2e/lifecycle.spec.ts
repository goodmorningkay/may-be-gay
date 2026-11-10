import { createHmac } from "node:crypto";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test, expect, account, app, apex, fixture, saved, state, publish, action, signIn, password, observeContext, confirmPassword } from "./helpers";

test("autosave races, stale tabs, failure recovery, history, report administration, export and deletion", async ({ page, context, expectedErrors }) => {
  test.setTimeout(300_000);
  expectedErrors.push(/^Console: Failed to load resource: (the server responded with a status of (401|404|409)|net::ERR_(FAILED|INTERNET_DISCONNECTED)).*\[https:\/\/app\.may-be\.localhost\/api\/profile(\/publish)?\]$/);
  const owner = await account(page, "lifecycle-a");
  await page.getByLabel("Display name", { exact: true }).fill("Lifecycle owner"); await saved(page);
  // Hold an actual request, then continue it; every successful response is real.
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void; const saving = new Promise<void>(resolve => { started = resolve; });
  await page.route("**/api/profile", async route => {
    if (route.request().method() !== "PUT") return route.continue();
    started(); await gate; await route.continue();
  });
  await page.getByLabel("Bio", { exact: true }).fill("First in-flight edit"); await saving;
  await page.getByLabel("Bio", { exact: true }).fill("Later edit while saving"); release();
  await saved(page); await page.unroute("**/api/profile");
  expect((await state(context)).document.bio).toBe("Later edit while saving");
  const stale = await context.newPage(); await stale.goto(`${app}/editor`);
  await expect(stale.getByLabel("Bio", { exact: true })).toHaveValue("Later edit while saving");
  await page.getByLabel("Bio", { exact: true }).fill("Server won first"); await saved(page);
  await stale.getByLabel("Bio", { exact: true }).fill("Retained local conflict");
  await expect(stale.getByRole("heading", { name: "Another edit reached the server first." })).toBeVisible();
  await expect(stale.getByLabel("Bio", { exact: true })).toHaveValue("Retained local conflict");
  await action(stale, "Keep my input and replace server draft");
  expect((await state(context)).document.bio).toBe("Retained local conflict");
  await page.reload(); await saved(page);
  // A genuine transport failure and offline state, followed by deliberate retry.
  await context.setOffline(true);
  await page.getByLabel("Bio", { exact: true }).fill("Offline retained input");
  await expect(page.getByRole("status").filter({ hasText: "Offline · input retained in this tab" })).toBeVisible();
  await context.setOffline(false); await saved(page);
  await page.route("**/api/profile", route => route.request().method() === "PUT" ? route.abort("failed") : route.continue());
  await page.getByLabel("Bio", { exact: true }).fill("Failed request retains input");
  await expect(page.getByText("Your input is still here", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Bio", { exact: true })).toHaveValue("Failed request retains input");
  await page.unroute("**/api/profile"); await page.getByRole("button", { name: "Retry saving / resume editing", exact: true }).click(); await saved(page);
  await publish(page);
  const live = await state(context);
  // A real stale-version publish returns 409 without replacing the live pointer.
  const failed = await context.request.post(`${app}/api/profile/publish`, { headers: { origin: app, "x-editor-profile": live.profileId }, data: { expectedVersion: 1 } });
  expect(failed.status()).toBe(409); expect((await state(context)).publishedRevisionId).toBe(live.publishedRevisionId);
  // Also show UI retention when publication transport fails.
  await page.route("**/api/profile/publish", route => route.abort("failed"));
  await page.getByRole("button", { name: "Publish changes", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(page.getByText("Your input is still here", { exact: true })).toBeVisible();
  expect((await state(context)).publishedRevisionId).toBe(live.publishedRevisionId);
  await page.unroute("**/api/profile/publish"); await page.getByRole("button", { name: "Retry saving / resume editing", exact: true }).click(); await saved(page);
  for (let n = 2; n <= 6; n++) { await page.getByLabel("Bio", { exact: true }).fill(`Publication snapshot ${n}`); await publish(page); }
  const history = await state(context); expect(history.revisions).toHaveLength(5);
  await expect(page.getByRole("button", { name: /^Restore publication/ })).toHaveCount(5);
  await action(page, "Unpublish page");
  expect((await context.request.get("https://lifecycle-a.may-be.localhost")).status()).toBe(404);
  await action(page, `Restore publication ${history.revisions[4].revisionNumber}`);
  await expect(page.getByLabel("Bio", { exact: true })).toHaveValue("Publication snapshot 2");
  expect((await state(context)).revisions).toHaveLength(5);
  // Revoke through the real account API in a second tab, retain the first tab's edits.
  expect((await context.request.post(`${app}/api/auth/sign-out`, { headers: { origin: app }, data: {} })).status()).toBe(200);
  await page.getByLabel("Bio", { exact: true }).fill("Retained after session expiry");
  await expect(page.getByText("Sign in again to continue", { exact: true })).toBeVisible();
  await signIn(stale, owner.email);
  await page.getByRole("button", { name: "Retry saving / resume editing", exact: true }).click(); await saved(page); await stale.close();
  // Genuine image/audio validation; invalid content accepted for processing then rejected.
  const files = await fixture("fixtures");
  const rejected = page.waitForResponse(r => r.url().includes("/api/media?kind=image") && r.request().method() === "POST");
  await page.getByLabel("Upload image", { exact: false }).setInputFiles({ name: "invalid.png", mimeType: "image/png", buffer: Buffer.from("not an image") });
  expect((await rejected).status()).toBe(202); await fixture("drain");
  let library = await (await context.request.get(`${app}/api/media`, { headers: { "x-editor-profile": (await state(context)).profileId } })).json();
  expect(library.assets.some((a: { state: string }) => a.state === "rejected")).toBe(true);
  expect((await context.request.post(`${app}/api/media?kind=image`, { headers: { origin: app, "x-editor-profile": (await state(context)).profileId, "content-type": "application/octet-stream" }, data: Buffer.alloc(5 * 1024 ** 2 + 1) })).status()).toBe(413);
  for (const [label, kind, file] of [["Upload image", "image", files.image], ["Upload music", "audio", files.audio]]) {
    const response = page.waitForResponse(r => r.url().includes(`/api/media?kind=${kind}`) && r.request().method() === "POST");
    await page.getByLabel(label, { exact: false }).setInputFiles(file); expect((await response).status()).toBe(202); await fixture("drain");
    await page.getByRole("button", { name: "Refresh media", exact: true }).click();
    await expect(page.getByLabel(kind === "image" ? "Avatar" : "Profile music", { exact: true }).locator("option")).toHaveCount(2);
  }
  await page.getByLabel("Avatar", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Profile music", { exact: true }).selectOption({ index: 1 });
  await page.getByLabel("Music rights / attribution", { exact: true }).fill("Original generated sine fixture"); await publish(page);
  const mediaVisitor = await context.newPage(); await mediaVisitor.goto("https://lifecycle-a.may-be.localhost");
  let publicAudio = (await mediaVisitor.locator("audio").getAttribute("src"))!;
  expect((await context.request.get(publicAudio)).status()).toBe(200);
  const mediaPublication = (await state(context)).revisions[0].revisionNumber;
  await action(page, "Unpublish page");
  expect((await context.request.get(publicAudio)).status()).toBe(404);
  await fixture("drain");
  await action(page, `Restore publication ${mediaPublication}`);
  await mediaVisitor.reload(); publicAudio = (await mediaVisitor.locator("audio").getAttribute("src"))!;
  expect((await context.request.get(publicAudio)).status()).toBe(200); await mediaVisitor.close();
  library = await (await context.request.get(`${app}/api/media`, { headers: { "x-editor-profile": (await state(context)).profileId } })).json();
  const image = library.assets.find((a: { kind: string; state: string }) => a.kind === "image" && a.state === "ready");
  const retained = await context.request.delete(`${app}/api/media/${image.id}`, { headers: { origin: app, "x-editor-profile": (await state(context)).profileId } });
  expect(retained.status()).toBe(409); expect((await retained.json()).error.code).toBe("MEDIA_RETAINED");
  await confirmPassword(page);
  await page.goto(`${app}/account`);
  const downloading = page.waitForEvent("download"); await page.getByRole("button", { name: "Download account archive (.tar)", exact: true }).click();
  const download = await downloading; expect(await download.failure()).toBeNull();
  const tar = await readFile((await download.path())!);
  const entries = tarEntries(tar);
  expect(JSON.parse(entries.get("account.json")!.toString()).account.email).toBe(owner.email);
  const audioAsset = library.assets.find((a: { kind: string; state: string }) => a.kind === "audio" && a.state === "ready");
  const ownedAudio = await context.request.get(`${app}/api/media/${audioAsset.id}/content`); expect(ownedAudio.status()).toBe(200);
  expect(entries.get(`media/${audioAsset.id}/original.mp3`)?.equals(await ownedAudio.body())).toBe(true);
  const ownedImage = await context.request.get(`${app}/api/media/${image.id}/content`); expect(ownedImage.status()).toBe(200);
  expect(entries.get(`media/${image.id}/display.webp`)?.equals(await ownedImage.body())).toBe(true);
  expect(tar.includes(Buffer.from("account.json"))).toBe(true); expect(tar.includes(Buffer.from(owner.email))).toBe(true);
  expect(tar.includes(Buffer.from(`media/${image.id}/original.webp`))).toBe(true);
  expect(tar.includes(Buffer.from("RIFF"))).toBe(true); expect(tar.includes(Buffer.from("original.mp3"))).toBe(true);
  for (const secret of [password, "session_token", "tokenHash", "objectKey", "local-only-e2e-auth-secret"]) expect(tar.includes(Buffer.from(secret)), secret).toBe(false);
  const report = await context.newPage(); await report.goto(`${apex}/support?username=lifecycle-a`);
  await report.getByLabel("What should we review?", { exact: true }).fill("Private browser acceptance report details");
  await report.getByLabel("Private reply email (optional)", { exact: true }).fill("reporter@example.invalid");
  await report.getByRole("button", { name: "Submit report", exact: true }).click();
  await expect(report.getByRole("status")).toContainText(/received/i); await report.close();
  // Independent administrator, designated only through a bound fixture invitation.
  const adminContext = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true });
  const checkAdmin = await observeContext(adminContext, expectedErrors);
  try {
    const admin = await adminContext.newPage(); await account(admin, "lifecycle-admin", true);
    expect((await adminContext.request.get(`${app}/api/admin/reports`)).status()).toBe(403);
    await admin.goto(`${app}/account/security`);
    const setup = admin.locator("form").filter({ has: admin.getByRole("button", { name: "Set up authenticator", exact: true }) });
    await setup.getByLabel("Password", { exact: true }).fill(password); await setup.getByRole("button").click();
    const key = admin.locator("code"); await expect(key).toBeVisible(); const secret = (await key.textContent())!;
    // Enrollment alone must remain insufficient.
    expect((await adminContext.request.get(`${app}/api/admin/reports`)).status()).toBe(403);
    await admin.getByLabel("Authenticator code", { exact: true }).fill(totp(secret));
    await admin.getByRole("button", { name: "Verify authenticator", exact: true }).click();
    await expect(admin.getByRole("status")).toContainText("Authenticator verified");
    await confirmPassword(admin);
    await admin.goto(`${app}/admin`); await admin.getByRole("button", { name: "Read details", exact: true }).click();
    await expect(admin.getByText("Private browser acceptance report details", { exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "Assign to me", exact: true }).click(); await expect(admin.getByRole("status")).toHaveText("Change saved.");
    await admin.getByLabel("Queue", { exact: true }).selectOption("reviewing");
    await expect(admin.getByRole("button", { name: "Resolve", exact: true })).toBeVisible();
    await admin.getByRole("button", { name: "Resolve", exact: true }).click(); await expect(admin.getByRole("status")).toHaveText("Change saved.");
    await admin.getByLabel("Queue", { exact: true }).selectOption("resolved"); await expect(admin.getByRole("button", { name: "Read details", exact: true })).toBeVisible();
    await admin.goto(`${app}/account/security`); await admin.getByRole("button", { name: "Sign out", exact: true }).click();
    await signIn(admin, "lifecycle-admin@example.invalid"); await expect(admin).toHaveURL(`${app}/two-factor`);
    await admin.getByLabel("Authenticator code", { exact: true }).fill(totp(secret)); await admin.getByRole("button", { name: "Confirm your sign-in", exact: true }).click();
    await expect(admin).toHaveURL(`${app}/account/security`);
    await confirmPassword(admin);
    expect((await adminContext.request.get(`${app}/api/admin/reports`)).status()).toBe(200);
  } finally { await adminContext.close(); checkAdmin(); }
  await page.getByLabel("Type DELETE MY ACCOUNT", { exact: true }).fill("DELETE MY ACCOUNT");
  await page.getByRole("button", { name: "Delete my account", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(/queued/i);
  expect((await context.request.get(`${app}/api/profile`)).status()).toBe(401);
  expect((await context.request.get("https://lifecycle-a.may-be.localhost")).status()).toBe(404);
  expect((await context.request.get(publicAudio)).status()).toBe(404);
  await fixture("drain"); expect(await fixture("state", owner.email)).toBeNull();
});

function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const bits = [...secret.toUpperCase().replace(/=+$/, "")].map(c => alphabet.indexOf(c).toString(2).padStart(5, "0")).join("");
  const bytes = Buffer.from((bits.match(/.{8}/g) ?? []).map(b => parseInt(b, 2)));
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const digest = createHmac("sha1", bytes).update(counter).digest(); const offset = digest[19] & 15;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1000000).toString().padStart(6, "0");
}

for (const rotation of ["password", "enable", "disable"] as const) {
  test(`current-session sign out revokes the replacement after ${rotation} rotation`, async ({ page, context, expectedErrors }) => {
    expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of 404.*\[https:\/\/app\.may-be\.localhost\/api\/profile\]$/);
    await account(page, `rotation-${randomBytes(3).toString("hex")}`);
    await page.goto(`${app}/account/security`);
    async function currentSession() {
      const response = await context.request.get(`${app}/api/account/session`);
      expect(response.status()).toBe(200);
      return (await response.json()).sessions.find((s: { current: boolean }) => s.current).id;
    }
    async function enroll() {
      const setup = page.locator("form").filter({ has: page.getByRole("button", { name: "Set up authenticator", exact: true }) });
      await setup.getByLabel("Password", { exact: true }).fill(password); await setup.getByRole("button").click();
      await expect(page.locator("code")).toBeVisible();
      await page.getByLabel("Authenticator code", { exact: true }).fill(totp((await page.locator("code").textContent())!));
      await page.getByRole("button", { name: "Verify authenticator", exact: true }).click();
      await expect(page.getByRole("status")).toContainText("Authenticator verified");
    }
    if (rotation === "disable") await enroll();
    const before = await currentSession();
    if (rotation === "password") {
      const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Change password", exact: true }) });
      await form.getByLabel("Current password", { exact: true }).fill(password);
      await form.getByLabel("New password", { exact: true }).fill(`${password}-changed`);
      await form.getByRole("button").click();
      await expect(page.getByRole("status")).toContainText("Password changed");
    } else if (rotation === "enable") await enroll();
    else {
      const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Disable authenticator", exact: true }) });
      await form.getByLabel("Password", { exact: true }).fill(password); await form.getByRole("button").click();
      await expect(page.getByRole("status")).toContainText("Two-factor authentication disabled");
    }
    expect(await currentSession()).not.toBe(before);
    // No navigation/reload: use the original panel after the session rotated.
    await page.getByRole("listitem").filter({ hasText: /^This session/ }).getByRole("button", { name: "Sign out this session", exact: true }).click();
    await expect(page).toHaveURL(`${app}/sign-in`);
    expect((await context.request.get(`${app}/api/account/session`)).status()).toBe(401);
    expect((await context.request.get(`${app}/api/profile`)).status()).toBe(401);
  });
}

function tarEntries(archive: Buffer) {
  const result = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= archive.length;) {
    const name = archive.subarray(offset, offset + 100).toString().split("\0")[0];
    if (!name) break;
    const size = parseInt(archive.subarray(offset + 124, offset + 136).toString().replaceAll("\0", "").trim(), 8);
    expect(Number.isSafeInteger(size) && size >= 0 && offset + 512 + size <= archive.length).toBe(true);
    result.set(name, archive.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return result;
}

test("a retained editor cannot overwrite a different account after session switching", async ({ page, context, expectedErrors }) => {
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of (404|409).*\[https:\/\/app\.may-be\.localhost\/api\/profile\]$/);
  const suffix = randomBytes(3).toString("hex");
  const a = await account(page, `cross-a-${suffix}`);
  const initialA = await state(context);
  const switcher = await context.newPage();
  await context.request.post(`${app}/api/auth/sign-out`, { headers: { origin: app }, data: {} });
  const b = await account(switcher, `cross-b-${suffix}`);
  const initialB = await state(context); expect(initialB.editVersion).toBe(initialA.editVersion);
  await page.getByLabel("Bio", { exact: true }).fill(`Private draft belonging to ${a.username}`);
  await expect(page.getByText("Your input is still here", { exact: true })).toBeVisible();
  // This assertion deliberately fails if the backend accepted A's retained
  // document for B at the coincidentally equal editVersion.
  expect((await state(context)).document, `Cross-account overwrite of ${b.username}`).toEqual(initialB.document);
  expect((await state(context)).editVersion).toBe(initialB.editVersion);
  for (const path of ["publish", "unpublish", "revisions/11111111-1111-4111-8111-111111111111/restore"]) {
    const denied = await context.request.post(`${app}/api/profile/${path}`, { headers: { origin: app, "x-editor-profile": initialA.profileId }, data: path === "unpublish" ? {} : { expectedVersion: initialA.editVersion } });
    expect(denied.status()).toBe(409); expect((await denied.json()).error.code).toBe("ACCOUNT_CHANGED");
  }
  for (const identity of [undefined, "not-a-profile"]) {
    const denied = await context.request.put(`${app}/api/profile`, { headers: { origin: app, ...(identity ? { "x-editor-profile": identity } : {}) }, data: { expectedVersion: initialB.editVersion, document: initialA.document } });
    expect(denied.status()).toBe(400); expect((await denied.json()).error.code).toBe("EDITOR_IDENTITY_REQUIRED");
  }
  expect((await state(context)).document).toEqual(initialB.document);
  await switcher.close();
});
