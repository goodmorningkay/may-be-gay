import "server-only";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDatabase } from "@/server/db";
import { AppError } from "./http";

export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<void> {
  if (!key || Buffer.byteLength(key) > 2048 || !Number.isInteger(limit) || limit < 1 || limit > 100000 || !Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > 86400) throw new Error("Invalid rate limit configuration");
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) throw new Error("BETTER_AUTH_SECRET is required");
  const hash = createHmac("sha256", secret).update(key).digest("hex");
  const db = getDatabase();
  // Bound storage even under arbitrary submitted identifiers. No raw IP/email/token.
  await db.execute(sql`DELETE FROM auth_rate_limits WHERE key_hash IN (SELECT key_hash FROM auth_rate_limits WHERE expires_at < now() LIMIT 100)`);
  const rows = await db.execute(sql`INSERT INTO auth_rate_limits (key_hash, count, expires_at)
    VALUES (${hash}, 1, now() + ${windowSeconds} * interval '1 second')
    ON CONFLICT (key_hash) DO UPDATE SET
      count = CASE WHEN auth_rate_limits.expires_at <= now() THEN 1 ELSE least(auth_rate_limits.count + 1, 1000000) END,
      expires_at = CASE WHEN auth_rate_limits.expires_at <= now() THEN now() + ${windowSeconds} * interval '1 second' ELSE auth_rate_limits.expires_at END
    RETURNING count`);
  if (Number(rows[0]?.count) > limit) throw new AppError(429, "RATE_LIMITED", "Please try again later.");
}
// No forwarded address is trusted. A conservative shared budget protects unknown peers.
export async function authRequestLimit(path: string, email?: string) {
  await rateLimit(`auth:global:${path}`, 120, 60);
  if (email) await rateLimit(`auth:email:${path}:${email.toLowerCase().trim()}`, 8, 900);
}
