CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_provider_identity_unique" UNIQUE("provider_id","account_id")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" text,
	"subject_user_id" text,
	"profile_id" uuid,
	"report_id" uuid,
	"action" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_metadata_check" CHECK (jsonb_typeof("audit_events"."metadata") = 'object')
);
--> statement-breakpoint
CREATE TABLE "daily_link_metrics" (
	"profile_id" uuid NOT NULL,
	"link_id" text NOT NULL,
	"day" date NOT NULL,
	"clicks" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_link_metrics_profile_id_link_id_day_pk" PRIMARY KEY("profile_id","link_id","day"),
	CONSTRAINT "daily_clicks_check" CHECK ("daily_link_metrics"."clicks" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "daily_profile_metrics" (
	"profile_id" uuid NOT NULL,
	"day" date NOT NULL,
	"views" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "daily_profile_metrics_profile_id_day_pk" PRIMARY KEY("profile_id","day"),
	CONSTRAINT "daily_views_check" CHECK ("daily_profile_metrics"."views" BETWEEN 0 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "draft_media" (
	"profile_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"media_id" uuid NOT NULL,
	CONSTRAINT "draft_media_profile_id_media_id_pk" PRIMARY KEY("profile_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"email" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"redeemed_by" text,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "invites_hash_check" CHECK ("invites"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "invites_email_normalized_check" CHECK ("invites"."email" = lower(btrim("invites"."email")) AND "invites"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+$'),
	CONSTRAINT "invites_expiry_check" CHECK ("invites"."expires_at" > "invites"."created_at"),
	CONSTRAINT "invites_redemption_check" CHECK (("invites"."redeemed_at" IS NULL AND "invites"."redeemed_by" IS NULL) OR ("invites"."redeemed_at" IS NOT NULL AND "invites"."redeemed_at" >= "invites"."created_at" AND "invites"."redeemed_at" < "invites"."expires_at" AND "invites"."revoked_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"owner_id" text,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"finished_at" timestamp with time zone,
	"last_error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "jobs_kind_check" CHECK ("jobs"."kind" IN ('email','media','account_deletion','media_deletion','cache_purge')),
	CONSTRAINT "jobs_payload_check" CHECK ("jobs"."payload_version" = 1 AND jsonb_typeof("jobs"."payload") = 'object'),
	CONSTRAINT "jobs_state_check" CHECK ("jobs"."state" IN ('pending','running','succeeded','failed')),
	CONSTRAINT "jobs_attempts_check" CHECK ("jobs"."max_attempts" BETWEEN 1 AND 20 AND "jobs"."attempts" BETWEEN 0 AND "jobs"."max_attempts"),
	CONSTRAINT "jobs_lock_check" CHECK (("jobs"."state" = 'running' AND "jobs"."locked_at" IS NOT NULL AND "jobs"."locked_by" IS NOT NULL AND "jobs"."attempts" > 0) OR ("jobs"."state" <> 'running' AND "jobs"."locked_at" IS NULL AND "jobs"."locked_by" IS NULL)),
	CONSTRAINT "jobs_finished_check" CHECK (("jobs"."state" IN ('succeeded','failed')) = ("jobs"."finished_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"object_key" text NOT NULL,
	"kind" text NOT NULL,
	"content_type" text,
	"actual_bytes" bigint,
	"state" text DEFAULT 'quarantined' NOT NULL,
	"width" integer,
	"height" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "media_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "media_id_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "media_kind_check" CHECK ("media"."kind" IN ('image', 'audio')),
	CONSTRAINT "media_state_check" CHECK ("media"."state" IN ('quarantined','processing','ready','rejected','deleted')),
	CONSTRAINT "media_bytes_check" CHECK ("media"."actual_bytes" >= 0 AND "media"."actual_bytes" <= 9007199254740991),
	CONSTRAINT "media_dimensions_check" CHECK (("media"."width" IS NULL OR "media"."width" > 0) AND ("media"."height" IS NULL OR "media"."height" > 0) AND ("media"."duration_ms" IS NULL OR "media"."duration_ms" > 0)),
	CONSTRAINT "media_ready_check" CHECK ("media"."state" <> 'ready' OR ("media"."actual_bytes" IS NOT NULL AND "media"."actual_bytes" > 0 AND "media"."content_type" IS NOT NULL AND (("media"."kind" = 'image' AND "media"."content_type" IN ('image/jpeg','image/png','image/webp') AND "media"."width" IS NOT NULL AND "media"."height" IS NOT NULL) OR ("media"."kind" = 'audio' AND "media"."content_type" = 'audio/mpeg' AND "media"."duration_ms" IS NOT NULL)))),
	CONSTRAINT "media_deletion_check" CHECK (("media"."state" = 'deleted') = ("media"."deleted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "profile_drafts" (
	"profile_id" uuid PRIMARY KEY NOT NULL,
	"edit_version" integer DEFAULT 1 NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"document" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "draft_edit_version_check" CHECK ("profile_drafts"."edit_version" > 0),
	CONSTRAINT "draft_schema_version_check" CHECK ("profile_drafts"."schema_version" = 1),
	CONSTRAINT "draft_document_check" CHECK (jsonb_typeof("profile_drafts"."document") = 'object' AND ("profile_drafts"."document"->'schemaVersion') IS NOT DISTINCT FROM to_jsonb("profile_drafts"."schema_version"))
);
--> statement-breakpoint
CREATE TABLE "profile_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"document" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revisions_profile_id_unique" UNIQUE("profile_id","id"),
	CONSTRAINT "revisions_number_unique" UNIQUE("profile_id","revision_number"),
	CONSTRAINT "revisions_number_check" CHECK ("profile_revisions"."revision_number" > 0),
	CONSTRAINT "revisions_schema_version_check" CHECK ("profile_revisions"."schema_version" = 1),
	CONSTRAINT "revisions_document_check" CHECK (jsonb_typeof("profile_revisions"."document") = 'object' AND ("profile_revisions"."document"->'schemaVersion') IS NOT DISTINCT FROM to_jsonb("profile_revisions"."schema_version"))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"current_revision_id" uuid,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_owner_id_unique" UNIQUE("owner_id"),
	CONSTRAINT "profiles_id_owner_unique" UNIQUE("id","owner_id")
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid,
	"media_id" uuid,
	"target_username" text NOT NULL,
	"link_id" text,
	"reason" text NOT NULL,
	"details" text,
	"reporter_email" text,
	"state" text DEFAULT 'open' NOT NULL,
	"assigned_to" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "reports_state_check" CHECK ("reports"."state" IN ('open','reviewing','resolved','dismissed')),
	CONSTRAINT "reports_resolution_check" CHECK (("reports"."state" IN ('resolved','dismissed')) = ("reports"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "revision_media" (
	"revision_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"media_id" uuid NOT NULL,
	CONSTRAINT "revision_media_revision_id_media_id_pk" PRIMARY KEY("revision_id","media_id")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	CONSTRAINT "two_factor_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"suspended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_role_check" CHECK ("user"."role" IN ('user', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "username_claims" (
	"username" text PRIMARY KEY NOT NULL,
	"owner_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "username_claims_owner_id_unique" UNIQUE("owner_id"),
	CONSTRAINT "username_format_check" CHECK ("username_claims"."username" COLLATE "C" ~ '^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$' AND "username_claims"."username" NOT LIKE 'xn--%'),
	CONSTRAINT "username_reserved_check" CHECK ("username_claims"."username" NOT IN ('www','app','api','auth','admin','media','cdn','assets','mail','support','abuse','status','staging','localhost','static','dev','test','beta','www2','email','smtp','imap','pop','ftp','sftp','ssh','ns1','ns2','dns','webmail','autoconfig','autodiscover','mta-sts','account','accounts','login','logout','signup','register','settings','help','privacy','terms','legal','security','billing','dashboard','editor','preview')),
	CONSTRAINT "username_retirement_check" CHECK (("username_claims"."owner_id" IS NOT NULL AND "username_claims"."retired_at" IS NULL) OR ("username_claims"."owner_id" IS NULL AND "username_claims"."retired_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_subject_user_id_user_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_link_metrics" ADD CONSTRAINT "daily_link_metrics_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_profile_metrics" ADD CONSTRAINT "daily_profile_metrics_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_media" ADD CONSTRAINT "draft_media_profile_id_profile_drafts_profile_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profile_drafts"("profile_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_media" ADD CONSTRAINT "draft_media_profile_id_owner_id_profiles_id_owner_id_fk" FOREIGN KEY ("profile_id","owner_id") REFERENCES "public"."profiles"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "draft_media" ADD CONSTRAINT "draft_media_media_id_owner_id_media_id_owner_id_fk" FOREIGN KEY ("media_id","owner_id") REFERENCES "public"."media"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_redeemed_by_user_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_drafts" ADD CONSTRAINT "profile_drafts_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_revisions" ADD CONSTRAINT "profile_revisions_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_current_revision_fk" FOREIGN KEY ("id","current_revision_id") REFERENCES "public"."profile_revisions"("profile_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_media_id_media_id_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_assigned_to_user_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_profile_id_revision_id_profile_revisions_profile_id_id_fk" FOREIGN KEY ("profile_id","revision_id") REFERENCES "public"."profile_revisions"("profile_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_profile_id_owner_id_profiles_id_owner_id_fk" FOREIGN KEY ("profile_id","owner_id") REFERENCES "public"."profiles"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revision_media" ADD CONSTRAINT "revision_media_media_id_owner_id_media_id_owner_id_fk" FOREIGN KEY ("media_id","owner_id") REFERENCES "public"."media"("id","owner_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "username_claims" ADD CONSTRAINT "username_claims_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_subject_idx" ON "audit_events" USING btree ("subject_user_id");--> statement-breakpoint
CREATE INDEX "audit_profile_idx" ON "audit_events" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "audit_report_idx" ON "audit_events" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "daily_link_metrics_retention_idx" ON "daily_link_metrics" USING btree ("day");--> statement-breakpoint
CREATE INDEX "daily_profile_metrics_retention_idx" ON "daily_profile_metrics" USING btree ("day");--> statement-breakpoint
CREATE INDEX "draft_media_asset_idx" ON "draft_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "invites_email_idx" ON "invites" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invites_pending_expiry_idx" ON "invites" USING btree ("expires_at") WHERE "invites"."redeemed_at" IS NULL AND "invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "jobs_pending_idx" ON "jobs" USING btree ("available_at","created_at") WHERE "jobs"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_running_idx" ON "jobs" USING btree ("locked_at") WHERE "jobs"."state" = 'running';--> statement-breakpoint
CREATE INDEX "jobs_owner_idx" ON "jobs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "media_owner_state_idx" ON "media" USING btree ("owner_id","state");--> statement-breakpoint
CREATE INDEX "reports_queue_idx" ON "reports" USING btree ("state","created_at");--> statement-breakpoint
CREATE INDEX "reports_profile_idx" ON "reports" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "reports_media_idx" ON "reports" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "reports_assignee_idx" ON "reports" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "revision_media_asset_idx" ON "revision_media" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "session_user_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expiry_idx" ON "session" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "two_factor_secret_idx" ON "two_factor" USING btree ("secret");--> statement-breakpoint
CREATE UNIQUE INDEX "user_email_normalized_unique" ON "user" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verification_expiry_idx" ON "verification" USING btree ("expires_at");