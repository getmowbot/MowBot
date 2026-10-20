CREATE TABLE "canvases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bot_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"size" text DEFAULT 's' NOT NULL,
	"content" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "canvases" ADD CONSTRAINT "canvases_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canvases_bot_key_unique" ON "canvases" USING btree ("bot_id","key");