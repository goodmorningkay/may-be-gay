import "server-only";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { APIError } from "better-auth/api";
import { getCurrentAdapter } from "@better-auth/core/context";
import { getDatabase } from "../db";
import type { Transaction } from "../db/types";
import * as schema from "../db/schema";
import { appOrigin } from "../http";
import { enqueueMail } from "../mail";

export type Admission = { email: string; created: boolean };
/** Never export an unguarded HTTP handler. Admission is supplied only within signup's transaction. */
export function createAccountAuth() { return configureAccountAuth(getDatabase(), true); }
/** The caller owns commit/rollback and must withhold responses until commit. */
export function createAccountAuthInTransaction(tx: Transaction, admission?: Admission) { return configureAccountAuth(tx, false, admission); }
function configureAccountAuth(db: ReturnType<typeof getDatabase> | Transaction, transactions: boolean, admission?: Admission) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("Explicit BETTER_AUTH_SECRET of at least 32 characters required");
  return betterAuth({
    appName: "may-be.gay", baseURL: appOrigin(), basePath: "/api/auth", secret,
    trustedOrigins: [appOrigin()],
    logger: { disabled: true },
    // Better Call otherwise logs raw non-API failures, including SQL bind values,
    // even when Better Auth's logger is disabled. Our HTTP facade redacts errors.
    onAPIError: { throw: true },
    // Signup is already inside the admission transaction. Ordinary
    // credential operations need the adapter transaction for complete rollback.
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: transactions }),
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, autoSignIn: false,
      minPasswordLength: 12, maxPasswordLength: 128, revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => { await enqueueMail({ template: "recovery", to: user.email, url }, user.id, db as Transaction); },
    },
    emailVerification: {
      sendOnSignUp: true, sendOnSignIn: false, autoSignInAfterVerification: false, expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) => { await enqueueMail({ template: "verification", to: user.email, url }, user.id, db as Transaction); },
    },
    session: { expiresIn: 604800, updateAge: 86400, freshAge: 600, cookieCache: { enabled: false } },
    account: { accountLinking: { enabled: false } },
    user: { additionalFields: {
      role: { type: "string", defaultValue: "user", input: false },
      // Register these explicitly so adapter predicates use current stored flags.
      suspendedAt: { type: "date", required: false, input: false, returned: false },
      deletedAt: { type: "date", required: false, input: false, returned: false },
    } },
    advanced: {
      // The library prepends __Secure- when true; our prefix supplies __Host-
      // while attributes below enforce Secure on every dynamically created cookie.
      useSecureCookies: false, cookiePrefix: "__Host-mbg",
      defaultCookieAttributes: { secure: true, httpOnly: true, sameSite: "lax", path: "/" },
      crossSubDomainCookies: { enabled: false },
      ipAddress: { disableIpTracking: true },
    },
    rateLimit: { enabled: true, window: 60, max: 100 },
    plugins: [twoFactor({ issuer: "may-be.gay", skipVerificationOnEnable: false, totpOptions: { digits: 6, period: 30 } })],
    databaseHooks: {
      user: { create: { before: async data => {
        if (!admission || admission.created || data.email !== admission.email) throw new APIError("FORBIDDEN", { message: "Registration unavailable" });
        admission.created = true;
        return { data: { ...data, role: "user", emailVerified: false } };
      } } },
      session: { create: { before: async (data, context) => {
        if (!context) throw new APIError("FORBIDDEN", { message: "Authentication unavailable" });
        // Credential rotation already holds a pool connection. Join its active
        // adapter rather than requesting a second connection from the root DB.
        const adapter = await getCurrentAdapter(context.context.adapter);
        const owner = await adapter.findOne({ model: "user", where: [
          { field: "id", value: data.userId },
          { field: "emailVerified", value: true },
          { field: "suspendedAt", value: null },
          { field: "deletedAt", value: null },
        ] });
        if (!owner) throw new APIError("FORBIDDEN", { message: "Authentication unavailable" });
      } } },
    },
  });
}
