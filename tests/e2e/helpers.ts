import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export const app = "https://app.may-be.localhost";
export const apex = "https://may-be.localhost";
export const password = "local-browser-acceptance-password-42";
const exec = promisify(execFile);
export async function fixture(command: string, ...args: string[]) {
  const { stdout } = await exec(process.execPath, ["--conditions=react-server", "--import", "tsx", "infra/testing/e2e/fixture.ts", command, ...args], { timeout: 60_000 });
  return JSON.parse(stdout);
}
type Observed = { expectedErrors: RegExp[] };
export const test = base.extend<Observed>({
  expectedErrors: async ({}, provide) => { await provide([]); },
  context: async ({ context, expectedErrors }, provide) => {
    const check = await observeContext(context, expectedErrors);
    await provide(context);
    check();
  },
});
export async function observeContext(context: BrowserContext, expectedErrors: RegExp[]) {
    const errors: string[] = [];
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      if ((url.protocol === "https:" || url.protocol === "blob:") && /^https:\/\/([a-z0-9-]+\.)?may-be\.localhost$/.test(url.origin)) return route.continue();
      errors.push(`Unexpected network request: ${url.origin}${url.pathname}`); await route.abort();
    });
    await context.exposeBinding("recordCsp", (_source, value: string) => { errors.push(`CSP: ${value}`); });
    await context.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", event => {
        (window as unknown as { recordCsp: (value: string) => void }).recordCsp(`${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    context.on("page", page => {
      page.on("pageerror", error => errors.push(`Page error: ${error.message}`));
      page.on("console", message => { if (message.type() === "error") errors.push(`Console: ${message.text()} [${message.location().url}]`); });
      page.on("dialog", dialog => { void dialog.accept(); });
    });
  return () => {
    expect(errors.filter(error => !expectedErrors.some(pattern => pattern.test(error))), "Unexpected console errors, CSP violations or outbound requests").toEqual([]);
  };
}
export { expect };
export async function signIn(page: Page, email: string) {
  await page.goto(`${app}/sign-in`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL(/\/(account\/security|two-factor)$/);
}
export async function confirmPassword(page: Page) {
  await page.goto(`${app}/account/security`);
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Confirm password", exact: true }) });
  await form.getByLabel("Password", { exact: true }).fill(password); await form.getByRole("button").click();
  await expect(page.getByRole("status")).toHaveText("Password confirmed.");
}
export async function account(page: Page, username: string, admin = false) {
  const email = `${username}@example.invalid`;
  const invite = await fixture("invite", email, ...(admin ? ["admin"] : []));
  await page.goto(`${app}/sign-up#invite=${invite.token}`);
  await expect(page).toHaveURL(`${app}/sign-up`);
  await page.getByLabel("Your name", { exact: true }).fill(`Private auth ${username}`);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  const signup = page.waitForResponse(r => r.url().endsWith("/api/auth/sign-up/email") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Create your account", exact: true }).click();
  expect((await signup).status()).toBe(202);
  expect((await page.context().cookies()).filter(c => /session_token/.test(c.name))).toHaveLength(0);
  await fixture("drain");
  const mail = await fixture("mail", email);
  expect(mail).toHaveLength(1);
  await page.goto(mail[0].url);
  await expect(page.getByRole("status")).toContainText("Email verified");
  await signIn(page, email);
  await page.goto(`${app}/editor`);
  await page.getByLabel("Username", { exact: true }).fill(username);
  await page.getByRole("button", { name: /Claim/ }).click();
  await expect(page.getByLabel("Display name", { exact: true })).toBeVisible();
  return { email, username };
}
export async function saved(page: Page) { await expect(page.getByRole("status").filter({ hasText: /^Draft saved · version/ })).toBeVisible(); }
export async function state(context: BrowserContext) {
  const response = await context.request.get(`${app}/api/profile`); expect(response.status()).toBe(200); return response.json();
}
export async function publish(page: Page) {
  await page.getByRole("button", { name: /^Publish (page|changes)$/ }).click();
  const response = page.waitForResponse(r => r.url().endsWith("/api/profile/publish") && r.request().method() === "POST");
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  expect((await response).status()).toBe(200);
  await saved(page);
}
export async function action(page: Page, button: string) {
  await page.getByRole("button", { name: button, exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Confirm", exact: true }).click();
  await saved(page);
}
