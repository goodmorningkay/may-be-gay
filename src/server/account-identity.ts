import "server-only";
import { AppError } from "@/server/http";

/** Comparison only: resolve and lock the owner from the session first. */
export function requireAccountIdentity(input: Request | Headers): string {
  const headers = input instanceof Headers ? input : input.headers;
  const id = headers.get("x-account-id");
  if (!id || id.length > 128 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new AppError(400, "ACCOUNT_IDENTITY_REQUIRED", "Reload your account page before trying again.");
  }
  return id;
}
export function checkAccountIdentity(ownerId: string, expectedAccountId: string) {
  if (ownerId !== expectedAccountId) throw new AppError(409, "ACCOUNT_CHANGED", "Sign in to the account that opened this page before trying again. No account action was performed.");
}
