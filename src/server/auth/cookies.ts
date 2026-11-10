import "server-only";
import { AppError } from "../http";

/** Different cookie parsers can select different occurrences. Authentication
 * accepts one value per library cookie, before either parser sees the request. */
export function assertUnambiguousAuthCookies(headers: Headers) {
  const seen = new Set<string>();
  for (const part of (headers.get("cookie") ?? "").split(";")) {
    const equals = part.indexOf("=");
    if (equals < 0) continue;
    const name = part.slice(0, equals).trim();
    if (!name.startsWith("__Host-mbg.")) continue;
    if (seen.has(name)) throw new AppError(400, "AMBIGUOUS_AUTH_COOKIES", "Sign in again using a single account session.");
    seen.add(name);
  }
}
