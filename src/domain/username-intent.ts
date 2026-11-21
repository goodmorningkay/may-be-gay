import { isValidUsername } from "./hosts";

export function readClaimUsername(value: unknown): string | undefined {
  return typeof value === "string" && isValidUsername(value) ? value : undefined;
}

export function withClaimUsername(path: string, username?: string): string {
  if (!username) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}username=${encodeURIComponent(username)}`;
}
