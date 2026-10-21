ALTER TABLE "automations" ADD COLUMN "last_outcome" jsonb;--> statement-breakpoint
ALTER TABLE "automations" ADD COLUMN "stop" jsonb;--> statement-breakpoint
ALTER TABLE "routine_runs" ADD COLUMN "reason" text;