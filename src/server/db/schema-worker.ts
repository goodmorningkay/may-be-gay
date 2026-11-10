import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, jsonb, check } from "drizzle-orm/pg-core";
export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  status: jsonb("status").notNull().$type<Record<string, unknown>>().default({}),
});
export const workerSchedules = pgTable("worker_schedules", {
  name: text("name").primaryKey(),
  nextAt: timestamp("next_at", { withTimezone: true }).notNull().defaultNow(),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastErrorCode: text("last_error_code"),
});
export const recoveryStatus = pgTable("recovery_status", {
  id: text("id").primaryKey(),
  state: text("state").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  details: jsonb("details").notNull().$type<Record<string, unknown>>().default({}),
}, t => [check("recovery_status_state", sql`${t.state} in ('running','succeeded','failed','closed','validated')`)]);
