CREATE TABLE "plan_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'todo' NOT NULL,
	"owner_bot_id" uuid,
	"task_id" uuid
);
--> statement-breakpoint
CREATE TABLE "team_plans" (
	"team_id" uuid PRIMARY KEY NOT NULL,
	"goal" text NOT NULL,
	"project_id" uuid,
	"author_bot_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_team_id_team_plans_team_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."team_plans"("team_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_owner_bot_id_bots_id_fk" FOREIGN KEY ("owner_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_steps" ADD CONSTRAINT "plan_steps_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_plans" ADD CONSTRAINT "team_plans_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_plans" ADD CONSTRAINT "team_plans_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_plans" ADD CONSTRAINT "team_plans_author_bot_id_bots_id_fk" FOREIGN KEY ("author_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_steps_team_idx" ON "plan_steps" USING btree ("team_id","position");--> statement-breakpoint
CREATE INDEX "plan_steps_task_idx" ON "plan_steps" USING btree ("task_id");