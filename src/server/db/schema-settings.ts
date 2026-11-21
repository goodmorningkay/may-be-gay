import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { defaultRegistrationMode, registrationModes } from "../../domain/registration";
import { user } from "./schema";

export const serviceSettings = pgTable("service_settings", {
  id: boolean("id").primaryKey().default(true),
  registrationMode: text("registration_mode", { enum: registrationModes }).notNull().default(defaultRegistrationMode),
  uploadsPaused: boolean("uploads_paused").notNull().default(false),
  accountLimit: integer("account_limit").notNull().default(50),
  totalMediaLimitBytes: bigint("total_media_limit_bytes", { mode: "number" }).notNull().default(5 * 1024 ** 3),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("service_settings_singleton", sql`${t.id} = true`),
  check("service_settings_registration_mode", sql`${t.registrationMode} IN ('closed','invite','public')`),
  check("service_settings_account_limit", sql`${t.accountLimit} BETWEEN 1 AND 100000`),
  check("service_settings_storage_limit", sql`${t.totalMediaLimitBytes} BETWEEN 0 AND 1099511627776`),
]);

export const accountQuotas = pgTable("account_quotas", {
  userId: text("user_id").primaryKey().references(() => user.id, { onDelete: "cascade" }),
  mediaLimitBytes: bigint("media_limit_bytes", { mode: "number" }).notNull().default(100 * 1024 ** 2),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("account_quota_limit", sql`${t.mediaLimitBytes} BETWEEN 0 AND 1099511627776`)]);
