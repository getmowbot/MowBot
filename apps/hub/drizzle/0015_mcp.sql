CREATE TABLE "mcp_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"bot_id" uuid,
	"tool" text NOT NULL,
	"ok" boolean NOT NULL,
	"duration_ms" integer NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"transport" text NOT NULL,
	"url" text,
	"command" text,
	"auth" text DEFAULT 'none' NOT NULL,
	"secrets_sealed" text,
	"secret_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"oauth_sealed" text,
	"scope" jsonb DEFAULT '{"kind":"all","ids":[]}'::jsonb NOT NULL,
	"computer_id" uuid,
	"created_by_bot_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'unknown' NOT NULL,
	"status_detail" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_server_id_mcp_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_calls" ADD CONSTRAINT "mcp_calls_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_computer_id_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_bot_id_bots_id_fk" FOREIGN KEY ("created_by_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_calls_server_created_idx" ON "mcp_calls" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_slug_unique" ON "mcp_servers" USING btree ("slug");