ALTER TABLE "provider_profiles" ADD COLUMN "oauth_sealed" text;--> statement-breakpoint
ALTER TABLE "provider_profiles" ADD COLUMN "oauth_account" jsonb;