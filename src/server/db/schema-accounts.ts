import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, integer, index, check } from "drizzle-orm/pg-core";
import { session, user } from "./schema";

export const sessionAssurance = pgTable("session_assurance", {
  sessionId: text("session_id").primaryKey().references(() => session.id, { onDelete: "cascade" }),
  reauthenticatedAt: timestamp("reauthenticated_at", { withTimezone: true }),
  secondFactorAt: timestamp("second_factor_at", { withTimezone: true }),
});
export const authRateLimits = pgTable("auth_rate_limits", {
  keyHash: text("key_hash").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, t => [index("auth_rate_expiry_idx").on(t.expiresAt), check("auth_rate_key_check", sql`${t.keyHash} ~ '^[0-9a-f]{64}$'`), check("auth_rate_count_check", sql`${t.count} BETWEEN 1 AND 1000000`)]);
// A bootstrap invite grants a role only upon verified, completed redemption.
export const bootstrapInvites = pgTable("bootstrap_invites", {
  tokenHash: text("token_hash").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  designatedUserId: text("designated_user_id").references(() => user.id, { onDelete: "set null" }),
});
