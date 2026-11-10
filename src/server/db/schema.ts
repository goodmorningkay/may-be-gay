import { sql } from "drizzle-orm";
import {
  bigint, boolean, check, date, foreignKey, index, integer, jsonb, pgTable,
  primaryKey, text, timestamp, unique, uniqueIndex, uuid,
  type PgTableExtraConfigValue,
} from "drizzle-orm/pg-core";

const time = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => time("created_at").notNull().defaultNow();
const updatedAt = () => time("updated_at").notNull().defaultNow();

// Better Auth model names and field names are intentional. No auth handler is enabled.
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  role: text("role").notNull().default("user"),
  suspendedAt: time("suspended_at"),
  deletedAt: time("deleted_at"),
}, (t) => [
  uniqueIndex("user_email_normalized_unique").on(sql`lower(${t.email})`),
  check("user_role_check", sql`${t.role} IN ('user', 'admin')`),
]);

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: time("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
}, (t) => [index("session_user_idx").on(t.userId), index("session_expiry_idx").on(t.expiresAt)]);

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: time("access_token_expires_at"),
  refreshTokenExpiresAt: time("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("account_user_idx").on(t.userId), unique("account_provider_identity_unique").on(t.providerId, t.accountId)]);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: time("expires_at").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("verification_identifier_idx").on(t.identifier), index("verification_expiry_idx").on(t.expiresAt)]);

export const twoFactor = pgTable("two_factor", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }).unique(),
  secret: text("secret").notNull(),
  backupCodes: text("backup_codes").notNull(),
  verified: boolean("verified").notNull().default(true),
  failedVerificationCount: integer("failed_verification_count").notNull().default(0),
  lockedUntil: time("locked_until"),
}, (t) => [index("two_factor_secret_idx").on(t.secret)]);

export const invites = pgTable("invites", {
  id: uuid("id").defaultRandom().primaryKey(),
  tokenHash: text("token_hash").notNull().unique(),
  email: text("email").notNull(),
  createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  expiresAt: time("expires_at").notNull(),
  revokedAt: time("revoked_at"),
  redeemedAt: time("redeemed_at"),
  redeemedBy: text("redeemed_by").references(() => user.id, { onDelete: "set null" }),
}, (t) => [
  check("invites_hash_check", sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
  check("invites_email_normalized_check", sql`${t.email} = lower(btrim(${t.email})) AND ${t.email} ~ '^[^[:space:]@]+@[^[:space:]@]+$'`),
  check("invites_expiry_check", sql`${t.expiresAt} > ${t.createdAt}`),
  check("invites_redemption_check", sql`(${t.redeemedAt} IS NULL AND ${t.redeemedBy} IS NULL) OR (${t.redeemedAt} IS NOT NULL AND ${t.redeemedAt} >= ${t.createdAt} AND ${t.redeemedAt} < ${t.expiresAt} AND ${t.revokedAt} IS NULL)`),
  index("invites_email_idx").on(t.email),
  index("invites_pending_expiry_idx").on(t.expiresAt).where(sql`${t.redeemedAt} IS NULL AND ${t.revokedAt} IS NULL`),
]);

export const usernameClaims = pgTable("username_claims", {
  username: text("username").primaryKey(),
  ownerId: text("owner_id").unique().references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  retiredAt: time("retired_at"),
}, (t) => [
  check("username_format_check", sql`${t.username} COLLATE "C" ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' AND ${t.username} NOT LIKE 'xn--%'`),
  check("username_reserved_check", sql`${t.username} NOT IN ('www','app','api','auth','admin','media','cdn','assets','mail','support','abuse','status','staging','localhost','static','dev','test','beta','www2','email','smtp','imap','pop','ftp','sftp','ssh','ns1','ns2','dns','webmail','autoconfig','autodiscover','mta-sts','account','accounts','login','logout','signup','register','settings','help','privacy','terms','legal','security','billing','dashboard','editor','preview')`),
  check("username_retirement_check", sql`(${t.ownerId} IS NOT NULL AND ${t.retiredAt} IS NULL) OR (${t.ownerId} IS NULL AND ${t.retiredAt} IS NOT NULL)`),
]);

export const profiles = pgTable("profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull().unique().references(() => user.id, { onDelete: "cascade" }),
  currentRevisionId: uuid("current_revision_id"),
  suspendedAt: time("suspended_at"),
  deletedAt: time("deleted_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t): PgTableExtraConfigValue[] => [
  unique("profiles_id_owner_unique").on(t.id, t.ownerId),
  foreignKey({ name: "profiles_current_revision_fk", columns: [t.id, t.currentRevisionId], foreignColumns: [profileRevisions.profileId, profileRevisions.id] }),
]);

export const profileDrafts = pgTable("profile_drafts", {
  profileId: uuid("profile_id").primaryKey().references(() => profiles.id, { onDelete: "cascade" }),
  editVersion: integer("edit_version").notNull().default(1),
  schemaVersion: integer("schema_version").notNull().default(1),
  document: jsonb("document").notNull().$type<unknown>(),
  updatedAt: updatedAt(),
}, (t) => [
  check("draft_edit_version_check", sql`${t.editVersion} > 0`),
  check("draft_schema_version_check", sql`${t.schemaVersion} = 1`),
  check("draft_document_check", sql`jsonb_typeof(${t.document}) = 'object' AND (${t.document}->'schemaVersion') IS NOT DISTINCT FROM to_jsonb(${t.schemaVersion})`),
]);

export const profileRevisions = pgTable("profile_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  revisionNumber: integer("revision_number").notNull(),
  schemaVersion: integer("schema_version").notNull().default(1),
  document: jsonb("document").notNull().$type<unknown>(),
  createdAt: createdAt(),
}, (t) => [
  unique("revisions_profile_id_unique").on(t.profileId, t.id),
  unique("revisions_number_unique").on(t.profileId, t.revisionNumber),
  check("revisions_number_check", sql`${t.revisionNumber} > 0`),
  check("revisions_schema_version_check", sql`${t.schemaVersion} = 1`),
  check("revisions_document_check", sql`jsonb_typeof(${t.document}) = 'object' AND (${t.document}->'schemaVersion') IS NOT DISTINCT FROM to_jsonb(${t.schemaVersion})`),
]);

export const media = pgTable("media", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: text("owner_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  objectKey: text("object_key").notNull().unique(),
  kind: text("kind").notNull(),
  contentType: text("content_type"),
  actualBytes: bigint("actual_bytes", { mode: "number" }),
  state: text("state").notNull().default("quarantined"),
  width: integer("width"),
  height: integer("height"),
  durationMs: integer("duration_ms"),
  createdAt: createdAt(),
  deletedAt: time("deleted_at"),
}, (t) => [
  unique("media_id_owner_unique").on(t.id, t.ownerId),
  index("media_owner_state_idx").on(t.ownerId, t.state),
  check("media_kind_check", sql`${t.kind} IN ('image', 'audio')`),
  check("media_state_check", sql`${t.state} IN ('quarantined','processing','ready','rejected','deleted')`),
  check("media_bytes_check", sql`${t.actualBytes} >= 0 AND ${t.actualBytes} <= 9007199254740991`),
  check("media_dimensions_check", sql`(${t.width} IS NULL OR ${t.width} > 0) AND (${t.height} IS NULL OR ${t.height} > 0) AND (${t.durationMs} IS NULL OR ${t.durationMs} > 0)`),
  check("media_ready_check", sql`${t.state} <> 'ready' OR (${t.actualBytes} IS NOT NULL AND ${t.actualBytes} > 0 AND ${t.contentType} IS NOT NULL AND ((${t.kind} = 'image' AND ${t.contentType} IN ('image/jpeg','image/png','image/webp') AND ${t.width} IS NOT NULL AND ${t.height} IS NOT NULL) OR (${t.kind} = 'audio' AND ${t.contentType} = 'audio/mpeg' AND ${t.durationMs} IS NOT NULL)))`),
  check("media_deletion_check", sql`(${t.state} = 'deleted') = (${t.deletedAt} IS NOT NULL)`),
]);

// Composite FKs ensure an asset reference and its profile have the same owner.
export const revisionMedia = pgTable("revision_media", {
  revisionId: uuid("revision_id").notNull(),
  profileId: uuid("profile_id").notNull(),
  ownerId: text("owner_id").notNull(),
  mediaId: uuid("media_id").notNull(),
}, (t) => [
  primaryKey({ columns: [t.revisionId, t.mediaId] }),
  foreignKey({ columns: [t.profileId, t.revisionId], foreignColumns: [profileRevisions.profileId, profileRevisions.id] }).onDelete("cascade"),
  foreignKey({ columns: [t.profileId, t.ownerId], foreignColumns: [profiles.id, profiles.ownerId] }).onDelete("cascade"),
  foreignKey({ columns: [t.mediaId, t.ownerId], foreignColumns: [media.id, media.ownerId] }),
  index("revision_media_asset_idx").on(t.mediaId),
]);

export const draftMedia = pgTable("draft_media", {
  profileId: uuid("profile_id").notNull().references(() => profileDrafts.profileId, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull(),
  mediaId: uuid("media_id").notNull(),
}, (t) => [
  primaryKey({ columns: [t.profileId, t.mediaId] }),
  foreignKey({ columns: [t.profileId, t.ownerId], foreignColumns: [profiles.id, profiles.ownerId] }).onDelete("cascade"),
  foreignKey({ columns: [t.mediaId, t.ownerId], foreignColumns: [media.id, media.ownerId] }).onDelete("cascade"),
  index("draft_media_asset_idx").on(t.mediaId),
]);

export const reports = pgTable("reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  profileId: uuid("profile_id").references(() => profiles.id, { onDelete: "set null" }),
  mediaId: uuid("media_id").references(() => media.id, { onDelete: "set null" }),
  // Snapshot of the public name remains useful when its target is deleted.
  targetUsername: text("target_username").notNull(),
  linkId: text("link_id"),
  reason: text("reason").notNull(),
  details: text("details"),
  reporterEmail: text("reporter_email"),
  state: text("state").notNull().default("open"),
  assignedTo: text("assigned_to").references(() => user.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  resolvedAt: time("resolved_at"),
}, (t) => [
  check("reports_state_check", sql`${t.state} IN ('open','reviewing','resolved','dismissed')`),
  check("reports_resolution_check", sql`(${t.state} IN ('resolved','dismissed')) = (${t.resolvedAt} IS NOT NULL)`),
  index("reports_queue_idx").on(t.state, t.createdAt),
  index("reports_profile_idx").on(t.profileId),
  index("reports_media_idx").on(t.mediaId),
  index("reports_assignee_idx").on(t.assignedTo),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  actorId: text("actor_id").references(() => user.id, { onDelete: "set null" }),
  subjectUserId: text("subject_user_id").references(() => user.id, { onDelete: "set null" }),
  profileId: uuid("profile_id").references(() => profiles.id, { onDelete: "set null" }),
  reportId: uuid("report_id").references(() => reports.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  metadata: jsonb("metadata").notNull().default({}).$type<Record<string, unknown>>(),
  createdAt: createdAt(),
}, (t) => [
  check("audit_metadata_check", sql`jsonb_typeof(${t.metadata}) = 'object'`),
  index("audit_actor_idx").on(t.actorId),
  index("audit_subject_idx").on(t.subjectUserId),
  index("audit_profile_idx").on(t.profileId),
  index("audit_report_idx").on(t.reportId),
  index("audit_created_idx").on(t.createdAt),
]);

export const dailyProfileMetrics = pgTable("daily_profile_metrics", {
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  views: bigint("views", { mode: "number" }).notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.profileId, t.day] }),
  check("daily_views_check", sql`${t.views} BETWEEN 0 AND 9007199254740991`),
  index("daily_profile_metrics_retention_idx").on(t.day),
]);

export const dailyLinkMetrics = pgTable("daily_link_metrics", {
  profileId: uuid("profile_id").notNull().references(() => profiles.id, { onDelete: "cascade" }),
  linkId: text("link_id").notNull(),
  day: date("day").notNull(),
  clicks: bigint("clicks", { mode: "number" }).notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.profileId, t.linkId, t.day] }),
  check("daily_clicks_check", sql`${t.clicks} BETWEEN 0 AND 9007199254740991`),
  index("daily_link_metrics_retention_idx").on(t.day),
]);

export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: text("kind").notNull(),
  idempotencyKey: text("idempotency_key").notNull().unique(),
  ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
  payloadVersion: integer("payload_version").notNull().default(1),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5),
  availableAt: time("available_at").notNull().defaultNow(),
  lockedAt: time("locked_at"),
  lockedBy: text("locked_by"),
  finishedAt: time("finished_at"),
  // Store a redacted code, never a raw exception containing credentials/payloads.
  lastErrorCode: text("last_error_code"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [
  check("jobs_kind_check", sql`${t.kind} IN ('email','media','account_deletion','media_deletion','cache_purge')`),
  check("jobs_payload_check", sql`${t.payloadVersion} = 1 AND jsonb_typeof(${t.payload}) = 'object'`),
  check("jobs_state_check", sql`${t.state} IN ('pending','running','succeeded','failed')`),
  check("jobs_attempts_check", sql`${t.maxAttempts} BETWEEN 1 AND 20 AND ${t.attempts} BETWEEN 0 AND ${t.maxAttempts}`),
  check("jobs_lock_check", sql`(${t.state} = 'running' AND ${t.lockedAt} IS NOT NULL AND ${t.lockedBy} IS NOT NULL AND ${t.attempts} > 0) OR (${t.state} <> 'running' AND ${t.lockedAt} IS NULL AND ${t.lockedBy} IS NULL)`),
  check("jobs_finished_check", sql`(${t.state} IN ('succeeded','failed')) = (${t.finishedAt} IS NOT NULL)`),
  index("jobs_pending_idx").on(t.availableAt, t.createdAt).where(sql`${t.state} = 'pending'`),
  index("jobs_running_idx").on(t.lockedAt).where(sql`${t.state} = 'running'`),
  index("jobs_owner_idx").on(t.ownerId),
]);
