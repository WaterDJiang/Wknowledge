CREATE TYPE "skill_run_status" AS ENUM('queued', 'running', 'completed', 'failed', 'stopped');
--> statement-breakpoint
CREATE TABLE "skill_run" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "agent_session"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "skill_id" text NOT NULL,
  "skill_version" text NOT NULL,
  "skill_digest" text NOT NULL,
  "binding_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "approval_id" uuid REFERENCES "skill_approval"("id") ON DELETE set null,
  "input_summary" text NOT NULL,
  "status" "skill_run_status" NOT NULL DEFAULT 'queued',
  "error_code" text,
  "queued_at" timestamp with time zone NOT NULL DEFAULT now(),
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "skill_run_session_created_idx" ON "skill_run" USING btree ("session_id", "queued_at");
--> statement-breakpoint
CREATE INDEX "skill_run_user_status_idx" ON "skill_run" USING btree ("user_id", "status");
