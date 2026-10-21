CREATE TABLE "previews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"computer_id" uuid NOT NULL,
	"bot_id" uuid,
	"title" text NOT NULL,
	"port" integer NOT NULL,
	"public_port" integer NOT NULL,
	"path" text DEFAULT '/' NOT NULL,
	"token_sealed" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "previews" ADD CONSTRAINT "previews_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "previews_public_port_unique" ON "previews" USING btree ("public_port");--> statement-breakpoint
CREATE UNIQUE INDEX "previews_computer_port_unique" ON "previews" USING btree ("computer_id","port");