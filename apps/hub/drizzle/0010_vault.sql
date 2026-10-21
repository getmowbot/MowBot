CREATE TABLE "vault_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"action" text NOT NULL,
	"bot_id" uuid,
	"computer_id" uuid,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_grants" (
	"item_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vault_grants_item_bot_unique" UNIQUE("item_id","bot_id")
);
--> statement-breakpoint
CREATE TABLE "vault_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"service" text NOT NULL,
	"account" text,
	"sites" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notes" text,
	"policy" text DEFAULT 'auto' NOT NULL,
	"fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"computer_id" uuid,
	"created_by_bot_id" uuid,
	"session" jsonb,
	"dek_sealed" text NOT NULL,
	"payload_sealed" text NOT NULL,
	"captured_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "vault_item_id" uuid;--> statement-breakpoint
ALTER TABLE "vault_events" ADD CONSTRAINT "vault_events_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vault_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_events" ADD CONSTRAINT "vault_events_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_events" ADD CONSTRAINT "vault_events_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_grants" ADD CONSTRAINT "vault_grants_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vault_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_grants" ADD CONSTRAINT "vault_grants_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_created_by_bot_id_bots_id_fk" FOREIGN KEY ("created_by_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vault_events_item_created_idx" ON "vault_events" USING btree ("item_id","created_at");--> statement-breakpoint
CREATE INDEX "vault_items_computer_idx" ON "vault_items" USING btree ("computer_id");--> statement-breakpoint
ALTER TABLE "questions" ADD CONSTRAINT "questions_vault_item_id_vault_items_id_fk" FOREIGN KEY ("vault_item_id") REFERENCES "public"."vault_items"("id") ON DELETE cascade ON UPDATE no action;