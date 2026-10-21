CREATE TABLE "connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"hostname" text,
	"os" text,
	"shell" text,
	"version" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"bot_id" uuid NOT NULL,
	"command" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connector_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"path" text NOT NULL,
	"mode" text DEFAULT 'ask' NOT NULL,
	"scope" jsonb DEFAULT '{"kind":"all","ids":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "questions" ADD COLUMN "project_command" jsonb;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_grants" ADD CONSTRAINT "project_grants_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_token_hash_unique" ON "connectors" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_connector_key_unique" ON "projects" USING btree ("connector_id","key");