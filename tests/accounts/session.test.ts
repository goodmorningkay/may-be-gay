import { inspect } from "node:util";
import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/server/http";
import { getSession, requireAdmin, requireUser } from "@/server/auth/session";

const mocks = vi.hoisted(() => ({ library: vi.fn(), configure: vi.fn(), rows: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/server/auth/config", () => ({ createAccountAuth: () => { mocks.configure(); return { api: { getSession: mocks.library } }; } }));
vi.mock("@/server/rate-limit", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/server/db", () => ({ getDatabase: () => ({ select: () => {
  const chain = { from: () => chain, innerJoin: () => chain, leftJoin: () => chain, where: mocks.rows };
  return chain;
} }) }));

const secret = "PRIVATE_SESSION_BEARER_9c734";
const record = { userId: "owner", sessionId: "session", email: "owner@example.invalid", emailVerified: true, role: "admin", createdAt: new Date(), reauthenticatedAt: null };
function headers() { return new Headers({ host: "app.may-be.localhost", cookie: `__Host-mbg.session_token=${secret}` }); }
function libraryFailure() {
  const query = Object.assign(new Error(`Failed query: select session where token=$1; params: ${secret}`), { query: "select session where token=$1", params: [secret], cause: new Error(`driver ${secret}`) });
  const error = new APIError("INTERNAL_SERVER_ERROR", { message: "Session lookup failed" });
  Object.defineProperty(error, "cause", { value: query });
  return error;
}
async function safeOutage(read: () => Promise<unknown>) {
  const error = await read().then(() => { throw new Error("Expected rejection"); }, error => error);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({ status: 503, code: "AUTH_UNAVAILABLE" });
  expect(error.cause).toBeUndefined();
  for (const rendered of [inspect(error, { depth: null, showHidden: true }), JSON.stringify(error), String(error), error.stack]) {
    expect(rendered).not.toContain(secret);
    expect(rendered).not.toContain("select session");
    expect(rendered).not.toContain("params");
  }
}
describe("server session error boundary", () => {
  beforeEach(() => {
    vi.stubEnv("SITE_DOMAIN", "may-be.localhost");
    mocks.configure.mockReset(); mocks.library.mockReset().mockResolvedValue({ session: { id: "session" }, user: { id: "owner" } });
    mocks.rows.mockReset().mockResolvedValue([record]); mocks.rateLimit.mockReset().mockResolvedValue(undefined);
  });
  it.each(["configuration", "library", "rate", "session query", "admin query"])("discards token-bearing causes from %s failures before SSR can log them", async failure => {
    const error = libraryFailure();
    if (failure === "configuration") mocks.configure.mockImplementation(() => { throw error; });
    if (failure === "library") mocks.library.mockRejectedValue(error);
    if (failure === "rate") mocks.rateLimit.mockRejectedValue(error);
    if (failure === "session query") mocks.rows.mockRejectedValue(error);
    if (failure === "admin query") mocks.rows.mockResolvedValueOnce([record]).mockRejectedValueOnce(error);
    const logger = vi.spyOn(console, "error").mockImplementation(() => {});
    await safeOutage(() => failure === "admin query" ? requireAdmin(headers()) : getSession(headers()));
    expect(logger).not.toHaveBeenCalled();
  });
  it("preserves expected rate, sign-in, origin, stale identity and administrator errors", async () => {
    const limited = Object.assign(new AppError(429, "RATE_LIMITED", "Please try again later."), { cause: libraryFailure(), params: [secret] });
    mocks.rateLimit.mockRejectedValueOnce(limited);
    const rejection = await getSession(headers()).catch(error => error);
    expect(rejection).toMatchObject({ status: 429, code: "RATE_LIMITED" });
    expect(inspect(rejection, { depth: null, showHidden: true })).not.toContain(secret);
    mocks.library.mockResolvedValueOnce(null);
    await expect(requireUser(headers())).rejects.toMatchObject({ status: 401, code: "SIGN_IN_REQUIRED" });
    const foreign = headers(); foreign.set("origin", "https://foreign.invalid");
    await expect(getSession(foreign)).rejects.toMatchObject({ status: 403, code: "ORIGIN_REJECTED" });
    const stale = headers(); stale.set("x-account-id", "other");
    await expect(requireUser(stale)).rejects.toMatchObject({ status: 409, code: "ACCOUNT_CHANGED" });
    mocks.rows.mockResolvedValueOnce([record]).mockResolvedValueOnce([]);
    await expect(requireAdmin(headers())).rejects.toMatchObject({ status: 403, code: "ADMIN_2FA_REQUIRED" });
  });
  it("returns null for absent sessions and inactive owners", async () => {
    mocks.library.mockResolvedValueOnce(null);
    expect(await getSession(headers())).toBeNull();
    mocks.rows.mockResolvedValueOnce([]);
    expect(await getSession(headers())).toBeNull();
  });
});
