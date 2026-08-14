CREATE TYPE "skill_approval_status" AS ENUM('pending', 'approved', 'rejected', 'expired');
--> statement-breakpoint
CREATE TABLE "skill_approval" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "agent_session"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "skill_id" text NOT NULL,
  "skill_version" text NOT NULL,
  "skill_digest" text NOT NULL,
  "binding_ids" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "input_summary" text NOT NULL,
  "status" "skill_approval_status" NOT NULL DEFAULT 'pending',
  "expires_at" timestamp with time zone NOT NULL,
  "decided_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "skill_approval_session_created_idx" ON "skill_approval" USING btree ("session_id", "created_at");
--> statement-breakpoint
CREATE INDEX "skill_approval_user_status_idx" ON "skill_approval" USING btree ("user_id", "status");
