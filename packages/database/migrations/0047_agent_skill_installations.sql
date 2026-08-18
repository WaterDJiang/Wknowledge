CREATE TABLE "agent_skill_installation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
	"skill_name" text NOT NULL,
	"version" text NOT NULL,
	"digest" text NOT NULL,
	"source_format" text NOT NULL,
	"source_version" text,
	"source_digest" text,
	"publisher" text NOT NULL,
	"installed_at" timestamp with time zone NOT NULL DEFAULT now(),
	"enabled" boolean DEFAULT true NOT NULL,
	"executable" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_skill_installation_enabled_unique"
ON "agent_skill_installation" USING btree ("organization_id", "skill_name")
WHERE enabled;
--> statement-breakpoint
CREATE INDEX "agent_skill_installation_history_idx"
ON "agent_skill_installation" USING btree ("organization_id", "skill_name", "installed_at");
