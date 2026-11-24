CREATE TABLE "recovery_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"version" bigint DEFAULT 1 NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_event_version" CHECK ("recovery_events"."version" = 1 AND jsonb_typeof("recovery_events"."payload") = 'object' AND octet_length("recovery_events"."payload"::text) <= 1024),
	CONSTRAINT "recovery_event_sequence" CHECK ("recovery_events"."sequence" BETWEEN 1 AND 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "recovery_replay" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"last_sequence" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_replay_singleton" CHECK ("recovery_replay"."id" = true AND "recovery_replay"."last_sequence" >= 0)
);
