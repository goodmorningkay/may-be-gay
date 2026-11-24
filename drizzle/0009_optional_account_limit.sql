ALTER TABLE "service_settings" ALTER COLUMN "account_limit" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "service_settings" ALTER COLUMN "account_limit" DROP NOT NULL;