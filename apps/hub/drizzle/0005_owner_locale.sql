ALTER TABLE "messages" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "owner" ADD COLUMN "locale" text DEFAULT 'fr' NOT NULL;