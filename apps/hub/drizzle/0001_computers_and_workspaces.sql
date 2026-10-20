CREATE TABLE "computers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"team_id" uuid,
	"workspace_id" uuid NOT NULL,
	"status" text DEFAULT 'stopped' NOT NULL,
	"status_detail" text,
	"container_id" text,
	"agent_token_sealed" text NOT NULL,
	"control_device_id" uuid,
	"control_since" timestamp with time zone,
	"last_activity_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"mission" text,
	"is_main" boolean DEFAULT false NOT NULL,
	"isolated" boolean DEFAULT false NOT NULL,
	"lead_bot_id" uuid,
	"workspace_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_type" text NOT NULL,
	"quota_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computers" ADD CONSTRAINT "computers_control_device_id_devices_id_fk" FOREIGN KEY ("control_device_id") REFERENCES "public"."devices"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "computers_team_pc_unique" ON "computers" USING btree ("team_id") WHERE "computers"."kind" = 'team';--> statement-breakpoint
CREATE UNIQUE INDEX "teams_main_unique" ON "teams" USING btree ("is_main") WHERE "teams"."is_main";