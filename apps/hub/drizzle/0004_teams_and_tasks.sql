CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"result" text,
	"assignee_bot_id" uuid NOT NULL,
	"creator_bot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "manager_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "from_bot_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "kind" text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "meta" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_bot_id_bots_id_fk" FOREIGN KEY ("assignee_bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creator_bot_id_bots_id_fk" FOREIGN KEY ("creator_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_bot_id","status");--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_manager_id_bots_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_from_bot_id_bots_id_fk" FOREIGN KEY ("from_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_lead_bot_id_bots_id_fk" FOREIGN KEY ("lead_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bots_name_unique" ON "bots" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "messages_from_bot_created_idx" ON "messages" USING btree ("created_at") WHERE "messages"."from_bot_id" is not null;