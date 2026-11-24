CREATE TABLE "recovery_status" (
	"id" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "recovery_status_state" CHECK ("recovery_status"."state" in ('running','succeeded','failed','closed','validated'))
);
--> statement-breakpoint
CREATE TABLE "worker_heartbeats" (
	"id" text PRIMARY KEY NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_schedules" (
	"name" text PRIMARY KEY NOT NULL,
	"next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_error_code" text
);
