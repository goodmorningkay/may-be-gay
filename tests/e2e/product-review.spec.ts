import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { test, expect, account, app, apex, confirmPassword, fixture, observeContext, state, password } from "./helpers";

// Read-only evidence from exactly the disposable browser database. No fixture
// backdoors, schema changes or synthetic successes replace any HTTP/UI action.
async function evidence<T>(read: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (process.env.E2E_FIXTURE !== "isolated-browser-acceptance" || process.env.SITE_DOMAIN !== "may-be.localhost" ||
      !url || new URL(url).hostname !== "db" || new URL(url).pathname !== "/browser_acceptance_test") throw new Error("Isolated browser evidence database required");
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 5 });
  try { return await read(sql); } finally { await sql.end({ timeout: 2 }); }
}
async function accountEvidence(email: string) {
  return evidence(async sql => {
    const [row] = await sql`select u.id,u.deleted_at,u.suspended_at,p.id as profile_id,p.current_revision_id,p.publication_number,d.edit_version,d.document,
      (select count(*)::int from jobs j where j.kind='account_deletion' and j.payload->>'ownerId'=u.id) as deletion_jobs,
      (select count(*)::int from recovery_events r where r.payload->>'ownerId'=u.id and r.payload->>'action'='delete-account') as deletion_events,
      (select count(*)::int from session s where s.user_id=u.id) as sessions
      from "user" u join profiles p on p.owner_id=u.id join profile_drafts d on d.profile_id=p.id where u.email=${email}`;
    return row;
  });
}

test("A account screen with a fresh B session cannot export or delete B", async ({ page, context, expectedErrors }) => {
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of (404|409).*\[https:\/\/app\.may-be\.localhost\/api\/(profile|account\/(export|delete|reauthenticate|session)|auth\/sign-out)\]$/);
  const suffix = randomBytes(3).toString("hex");
  const a = await account(page, `review-a-${suffix}`);
  await confirmPassword(page); await page.goto(`${app}/account`);
  await expect(page.getByText(`Signed in as ${a.email}`, { exact: true })).toBeVisible();
  const security = await context.newPage(); await security.goto(`${app}/account/security`);
  const switcher = await context.newPage();
  expect((await context.request.post(`${app}/api/auth/sign-out`, { headers: { origin: app }, data: {} })).status()).toBe(200);
  const b = await account(switcher, `review-b-${suffix}`);
  // Password confirmation belongs to B. A's controls must retain A's identity.
  await confirmPassword(switcher);
  const beforeB = await accountEvidence(b.email), beforeA = await accountEvidence(a.email);
  // The adjacent security screen also retains A across a shared-cookie switch.
  const confirm = security.getByRole("button", { name: "Confirm password", exact: true });
  await confirm.locator("..").getByLabel("Password", { exact: true }).fill(password);
  for (const [button, endpoint] of [["Confirm password", "account/reauthenticate"], ["Sign out all sessions", "account/session"], ["Sign out", "auth/sign-out"]]) {
    const response = security.waitForResponse(r => r.url().endsWith(`/api/${endpoint}`) && r.request().method() !== "GET");
    await security.getByRole("button", { name: button, exact: true }).click();
    const denied = await response;
    expect(denied.status()).toBe(409); expect((await denied.json()).error.code).toBe("ACCOUNT_CHANGED");
    expect(denied.request().headers()["x-account-id"]).toBe(beforeA.id);
  }
  const downloads: string[] = []; page.on("download", d => downloads.push(d.suggestedFilename()));
  const archiveResponse = page.waitForResponse(r => r.url().endsWith("/api/account/export") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Download account archive (.tar)", exact: true }).click();
  const archive = await archiveResponse;
  expect(archive.status()).toBe(409); expect((await archive.json()).error.code).toBe("ACCOUNT_CHANGED");
  expect(archive.headers()["content-type"]).not.toContain("application/x-tar");
  expect(archive.request().postData()).toBeNull();
  expect(archive.request().headers()["x-account-id"]).toBe(beforeA.id);
  await expect(page.getByRole("status")).toContainText("Sign in to the account that opened this page");
  await page.getByLabel("Type DELETE MY ACCOUNT", { exact: true }).fill("DELETE MY ACCOUNT");
  const deletionResponse = page.waitForResponse(r => r.url().endsWith("/api/account/delete") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Delete my account", exact: true }).click();
  const deletion = await deletionResponse;
  expect(deletion.status()).toBe(409); expect((await deletion.json()).error.code).toBe("ACCOUNT_CHANGED");
  expect(deletion.request().headers()["x-account-id"]).toBe(beforeA.id);
  await expect(page.getByRole("status")).toContainText("No account action was performed");
  expect(downloads).toEqual([]);
  expect(await accountEvidence(b.email)).toEqual(beforeB);
  expect(await accountEvidence(a.email)).toEqual(beforeA);
  expect(beforeB.deletion_jobs).toBe(0); expect(beforeB.deletion_events).toBe(0);
  expect((await context.request.get(`${app}/api/account/session`)).status()).toBe(200);
  await security.close(); await switcher.close();
});

test("native auth and security submissions keep every credential out of URLs with JavaScript disabled", async ({ page, browser, context, expectedErrors }) => {
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of (400|404).*\[https:\/\/app\.may-be\.localhost\/api\/(profile|account\/form-help)\]$/);
  await account(page, `review-nojs-${randomBytes(3).toString("hex")}`);
  const anonNativeContext = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false });
  const checkAnon = await observeContext(anonNativeContext, expectedErrors);
  const nativeContext = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false, storageState: await context.storageState() });
  const check = await observeContext(nativeContext, expectedErrors);
  const dummy: Record<string, string> = {
    name: "nojs-private-name", email: "nojs-private-email@example.invalid", password: "dummy-private-password-57",
    currentPassword: "dummy-private-current-password-58", newPassword: "dummy-private-new-password-59",
    inviteToken: "dummy-private-invitation-token-60", code: "846291", username: "nojs-private-username",
  };
  const urls: string[] = [];
  anonNativeContext.on("request", request => urls.push(request.url()));
  nativeContext.on("request", request => urls.push(request.url()));
  const anonNative = await anonNativeContext.newPage();
  const native = await nativeContext.newPage();
  async function submitForm(target: typeof native, index: number) {
    const form = target.locator("form").nth(index);
    expect(await form.getAttribute("method")).toBe("post");
    for (const input of await form.locator("input[name]").all()) {
      const name = (await input.getAttribute("name"))!;
      expect(dummy[name], `Unexpected credential form field ${name}`).toBeTruthy();
      await input.fill(dummy[name]);
    }
    const submitted = target.waitForResponse(r => r.url() === `${app}/api/account/form-help` && r.request().method() === "POST");
    await form.getByRole("button").filter({ hasNotText: /Use a recovery code/ }).last().click();
    const response = await submitted;
    expect(response.status()).toBe(400);
    await expect(target.getByRole("heading", { name: "JavaScript required", exact: true })).toBeVisible();
    expect(await response.text()).not.toContain("dummy-private");
    expect(target.url()).toBe(`${app}/api/account/form-help`);
  }
  try {
    for (const path of ["sign-in", "sign-up", "reset-password", "two-factor", "verify-email", "forgot-password"]) {
      await anonNative.goto(`${app}/${path}`);
      // Playwright's text matcher deliberately skips noscript elements even
      // when scripting is disabled. Check the rendered fallback directly.
      await expect(anonNative.locator("noscript")).toBeVisible();
      expect(await anonNative.locator("noscript").textContent()).toContain("Enable JavaScript");
      await submitForm(anonNative, 0);
    }
    await native.goto(`${app}/account/security`);
    const count = await native.locator("form").count(); expect(count).toBe(3);
    for (let i = 0; i < count; i++) {
      await native.goto(`${app}/account/security`); await submitForm(native, i);
    }
    for (const secret of Object.values(dummy)) {
      expect(urls.some(url => url.includes(secret) || url.includes(encodeURIComponent(secret)))).toBe(false);
      expect(anonNative.url()).not.toContain(secret);
      expect(native.url()).not.toContain(secret);
    }
  } finally { await anonNativeContext.close(); checkAnon(); await nativeContext.close(); check(); }
});

test("native support selects only published targets and stores a private link/media report through Caddy", async ({ page, context, browser, expectedErrors }) => {
  expectedErrors.push(/^Console: Failed to load resource: the server responded with a status of (400|404).*\[https:\/\/(app\.)?may-be\.localhost\/api\/(profile|reports)\]$/);
  const owner = await account(page, `review-target-${randomBytes(3).toString("hex")}`);
  const current = await state(context), files = await fixture("fixtures");
  const ids: string[] = [];
  // Genuine uploads/worker processing; the third asset remains draft-only.
  for (const [kind, file] of [["image", files.image], ["audio", files.audio], ["image", files.image]]) {
    const response = await context.request.post(`${app}/api/media?kind=${kind}`, { headers: { origin: app, "content-type": "application/octet-stream", "x-editor-profile": current.profileId }, data: await readFile(file) });
    expect(response.status()).toBe(202); ids.push((await response.json()).id); await fixture("drain");
  }
  const visible = randomUUID(), hidden = randomUUID(), draftOnly = randomUUID();
  const publishedDocument = { ...current.document, avatarAssetId: ids[0], backgroundAssetId: ids[0], music: { assetId: ids[1], attribution: "Original local test tone" }, links: [
    { id: visible, label: "Visible report choice", url: "https://example.invalid/visible", visible: true },
    { id: hidden, label: "Hidden report secret", url: "https://example.invalid/hidden-secret", visible: false },
  ] };
  let saved = await context.request.put(`${app}/api/profile`, { headers: { origin: app, "x-editor-profile": current.profileId }, data: { expectedVersion: current.editVersion, document: publishedDocument } });
  expect(saved.status()).toBe(200);
  const published = await context.request.post(`${app}/api/profile/publish`, { headers: { origin: app, "x-editor-profile": current.profileId }, data: { expectedVersion: (await saved.json()).editVersion } }); expect(published.status()).toBe(200);
  const live = await published.json();
  saved = await context.request.put(`${app}/api/profile`, { headers: { origin: app, "x-editor-profile": current.profileId }, data: { expectedVersion: live.editVersion, document: { ...publishedDocument, avatarAssetId: ids[2], links: [{ id: draftOnly, label: "Draft report secret", url: "https://example.invalid/draft-secret", visible: true }] } } }); expect(saved.status()).toBe(200);
  const nativeContext = await browser.newContext({ ignoreHTTPSErrors: true, javaScriptEnabled: false });
  const check = await observeContext(nativeContext, expectedErrors);
  try {
    const visitor = await nativeContext.newPage();
    await visitor.goto(`https://${owner.username}.may-be.localhost`);
    await visitor.getByRole("link", { name: "Report this page or get support", exact: true }).click();
    await expect(visitor).toHaveURL(`${apex}/support?username=${owner.username}`);
    const support = await visitor.content();
    for (const privateValue of [hidden, draftOnly, ids[2], "Hidden report secret", "Draft report secret", "hidden-secret", "draft-secret"]) expect(support).not.toContain(privateValue);
    await expect(visitor.getByLabel("Report target", { exact: true }).locator("option")).toHaveText(["Whole profile", "Link: Visible report choice", "Avatar", "Background", "Music"]);
    for (const [target, label] of [[`link:${visible}`, "Link: Visible report choice"], [`media:${ids[0]}`, "Avatar"], [`media:${ids[0]}`, "Background"], [`media:${ids[1]}`, "Music"]]) {
      await visitor.goto(`${apex}/support?username=${owner.username}`);
      // Select by accessible text, never ask visitors to discover an asset UUID.
      await visitor.getByLabel("Report target", { exact: true }).selectOption({ label });
      const details = `Private native review ${randomUUID()}`, contact = "private-native-reporter@example.invalid";
      await visitor.getByLabel("Report details (optional)", { exact: true }).fill(details);
      await visitor.getByLabel("Private reply email (optional)", { exact: true }).fill(contact);
      const receipt = visitor.waitForResponse(r => r.url() === `${apex}/api/reports` && r.request().method() === "POST");
      await visitor.getByRole("button", { name: "Submit report", exact: true }).click();
      const response = await receipt; expect(response.status()).toBe(202);
      expect(response.request().headers()["origin"]).toBe(apex);
      await expect(visitor.getByRole("heading", { name: "Submission received", exact: true })).toBeVisible();
      expect(await visitor.content()).not.toContain(details); expect(await visitor.content()).not.toContain(contact);
      expect(visitor.url()).toBe(`${apex}/api/reports`);
      const records = await evidence(sql => sql`select link_id,media_id,reporter_email,details from reports where target_username=${owner.username} and details=${details}`);
      expect(records).toHaveLength(1);
      const [kind, id] = target.split(":");
      expect(records[0]).toEqual({ link_id: kind === "link" ? id : null, media_id: kind === "media" ? id : null, reporter_email: contact, details });
    }
    const countReports = () => evidence(async sql => (await sql`select count(*)::int as n from reports where target_username=${owner.username}`)[0].n);
    const before = await countReports();
    for (const origin of ["null", "https://forged.invalid"]) {
      const denied = await nativeContext.request.post(`${apex}/api/reports`, { headers: { origin }, form: { username: owner.username, reason: "other", target: `link:${visible}` } }); expect(denied.status()).toBe(400);
    }
    // Forged/stale target IDs receive the uniform receipt but create no record.
    for (const target of [`link:${hidden}`, `link:${draftOnly}`, `media:${ids[2]}`]) {
      expect((await nativeContext.request.post(`${apex}/api/reports`, { headers: { origin: apex }, form: { username: owner.username, reason: "other", target } })).status()).toBe(202);
    }
    expect(await countReports()).toBe(before);
  } finally { await nativeContext.close(); check(); }
});
