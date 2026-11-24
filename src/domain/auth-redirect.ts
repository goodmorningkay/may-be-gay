import { readClaimUsername, withClaimUsername } from "./username-intent";

const signedInDestinations = new Set([
  "/editor",
  "/preview",
  "/account",
  "/account/security",
  "/account/analytics",
  "/admin",
]);

export function readReturnTo(value: unknown): string | undefined {
  return typeof value === "string" && signedInDestinations.has(value) ? value : undefined;
}

export function resolveSignedInPath(params: {
  returnTo?: unknown;
  username?: unknown;
  emailVerified?: boolean;
}): string {
  const username = readClaimUsername(params.username);
  if (params.emailVerified === false) return withClaimUsername("/verify-email", username);
  const returnTo = readReturnTo(params.returnTo);
  if (returnTo) return returnTo === "/editor" ? withClaimUsername(returnTo, username) : returnTo;
  return withClaimUsername("/editor", username);
}
