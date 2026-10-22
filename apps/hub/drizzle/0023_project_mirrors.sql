CREATE TABLE "project_mirrors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"folder" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"pending" integer DEFAULT 0 NOT NULL,
	"conflicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "mirror" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "project_mirrors" ADD CONSTRAINT "project_mirrors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mirrors" ADD CONSTRAINT "project_mirrors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_mirrors_project_workspace_unique" ON "project_mirrors" USING btree ("project_id","workspace_id");