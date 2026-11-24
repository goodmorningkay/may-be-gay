CREATE TABLE "auth_rate_limits" (
	"key_hash" text PRIMARY KEY NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_rate_key_check" CHECK ("auth_rate_limits"."key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "auth_rate_count_check" CHECK ("auth_rate_limits"."count" BETWEEN 1 AND 1000000)
);
--> statement-breakpoint
CREATE TABLE "bootstrap_invites" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"designated_user_id" text
);
--> statement-breakpoint
CREATE TABLE "session_assurance" (
	"session_id" text PRIMARY KEY NOT NULL,
	"reauthenticated_at" timestamp with time zone,
	"second_factor_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "media_storage" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"token" uuid NOT NULL,
	"state" text DEFAULT 'uploading' NOT NULL,
	"kind" text NOT NULL,
	"charged_bytes" bigint NOT NULL,
	"private_bytes" bigint DEFAULT 0 NOT NULL,
	"public_budget_bytes" bigint DEFAULT 0 NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"original" jsonb,
	"display" jsonb,
	"public_key" text NOT NULL,
	"revoking_key" text,
	"public_generation" integer DEFAULT 1 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_storage_public_key_unique" UNIQUE("public_key"),
	CONSTRAINT "media_storage_state" CHECK ("media_storage"."state" IN ('uploading','queued','ready','deleting','rejected')),
	CONSTRAINT "media_storage_kind" CHECK ("media_storage"."kind" IN ('image','audio')),
	CONSTRAINT "media_storage_bytes" CHECK ("media_storage"."charged_bytes" BETWEEN 0 AND 9007199254740991 AND "media_storage"."private_bytes" >= 0 AND "media_storage"."public_budget_bytes" >= 0 AND "media_storage"."received_bytes" >= 0 AND "media_storage"."charged_bytes" >= "media_storage"."private_bytes" + "media_storage"."public_budget_bytes"),
	CONSTRAINT "media_storage_generation" CHECK ("media_storage"."public_generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "account_quotas" (
	"user_id" text PRIMARY KEY NOT NULL,
	"media_limit_bytes" bigint DEFAULT 104857600 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_quota_limit" CHECK ("account_quotas"."media_limit_bytes" BETWEEN 0 AND 1099511627776)
);
--> statement-breakpoint
CREATE TABLE "service_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"registration_mode" text DEFAULT 'invite' NOT NULL,
	"uploads_paused" boolean DEFAULT false NOT NULL,
	"account_limit" integer DEFAULT 50 NOT NULL,
	"total_media_limit_bytes" bigint DEFAULT 5368709120 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_settings_singleton" CHECK ("service_settings"."id" = true),
	CONSTRAINT "service_settings_registration_mode" CHECK ("service_settings"."registration_mode" IN ('closed','invite','public')),
	CONSTRAINT "service_settings_account_limit" CHECK ("service_settings"."account_limit" BETWEEN 1 AND 100000),
	CONSTRAINT "service_settings_storage_limit" CHECK ("service_settings"."total_media_limit_bytes" BETWEEN 0 AND 1099511627776)
);
--> statement-breakpoint
ALTER TABLE "bootstrap_invites" ADD CONSTRAINT "bootstrap_invites_designated_user_id_user_id_fk" FOREIGN KEY ("designated_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_assurance" ADD CONSTRAINT "session_assurance_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_quotas" ADD CONSTRAINT "account_quotas_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_rate_expiry_idx" ON "auth_rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "media_storage_owner_idx" ON "media_storage" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "media_storage_expiry_idx" ON "media_storage" USING btree ("state","expires_at");