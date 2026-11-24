import { sql } from "drizzle-orm";
import { bigserial, boolean, check, jsonb, pgTable, timestamp, bigint } from "drizzle-orm/pg-core";

// No FKs: required after the owner and all private records have been deleted.
// Parent adds append-only UPDATE/DELETE/TRUNCATE guard and app role grants.
export const recoveryEvents = pgTable("recovery_events", {
  sequence: bigserial("sequence", { mode: "number" }).primaryKey(),
  version: bigint("version", { mode: "number" }).notNull().default(1),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  check("recovery_event_version", sql`${t.version} = 1 AND jsonb_typeof(${t.payload}) = 'object' AND octet_length(${t.payload}::text) <= 1024`),
  check("recovery_event_sequence", sql`${t.sequence} BETWEEN 1 AND 9007199254740991`),
]);
export const recoveryReplay = pgTable("recovery_replay", {
  id: boolean("id").primaryKey().default(true),
  lastSequence: bigint("last_sequence", { mode: "number" }).notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [check("recovery_replay_singleton", sql`${t.id} = true AND ${t.lastSequence} >= 0`)]);
