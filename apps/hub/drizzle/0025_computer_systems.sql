ALTER TABLE "computers" ADD COLUMN "system" text DEFAULT 'desktop' NOT NULL;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "gpus" jsonb;--> statement-breakpoint
ALTER TABLE "computers" ADD COLUMN "applied_setup" text;