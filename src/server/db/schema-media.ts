import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export type MediaObject = {
  area: "private" | "public";
  key: string;
  bytes: number;
  contentType: "image/webp" | "audio/mpeg";
  width?: number;
  height?: number;
  durationMs?: number;
};
// Deliberately no cascading FK: cleanup and quota accounting must survive hard
// deletion of user/media rows. Only delete this ledger after all objects + CDN do.
export const mediaStorage = pgTable("media_storage", {
  assetId: uuid("asset_id").primaryKey(),
  ownerId: text("owner_id").notNull(),
  token: uuid("token").notNull(),
  state: text("state").notNull().default("uploading"),
  kind: text("kind").notNull(),
  chargedBytes: bigint("charged_bytes", { mode: "number" }).notNull(),
  privateBytes: bigint("private_bytes", { mode: "number" }).notNull().default(0),
  publicBudgetBytes: bigint("public_budget_bytes", { mode: "number" }).notNull().default(0),
  receivedBytes: bigint("received_bytes", { mode: "number" }).notNull().default(0),
  original: jsonb("original").$type<MediaObject>(),
  display: jsonb("display").$type<MediaObject>(),
  publicKey: text("public_key").notNull().unique(),
  revokingKey: text("revoking_key"),
  publicGeneration: integer("public_generation").notNull().default(1),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  index("media_storage_owner_idx").on(t.ownerId),
  index("media_storage_expiry_idx").on(t.state, t.expiresAt),
  check("media_storage_state", sql`${t.state} IN ('uploading','queued','ready','deleting','rejected')`),
  check("media_storage_kind", sql`${t.kind} IN ('image','audio')`),
  check("media_storage_bytes", sql`${t.chargedBytes} BETWEEN 0 AND 9007199254740991 AND ${t.privateBytes} >= 0 AND ${t.publicBudgetBytes} >= 0 AND ${t.receivedBytes} >= 0 AND ${t.chargedBytes} >= ${t.privateBytes} + ${t.publicBudgetBytes}`),
  check("media_storage_generation", sql`${t.publicGeneration} > 0`),
]);
