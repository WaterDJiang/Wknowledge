CREATE TYPE "practice_attempt_status" AS ENUM('pending_review');
--> statement-breakpoint
CREATE TABLE "practice_attempt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "practice_question_id" uuid NOT NULL REFERENCES "practice_question"("id") ON DELETE cascade,
  "course_unit_id" uuid NOT NULL,
  "knowledge_point_id" uuid NOT NULL,
  "resource_version_id" uuid NOT NULL,
  "source_ref" text NOT NULL,
  "question_version" integer NOT NULL,
  "prompt" text NOT NULL,
  "rubric" jsonb NOT NULL,
  "response" text NOT NULL,
  "status" "practice_attempt_status" NOT NULL DEFAULT 'pending_review',
  "submitted_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "practice_attempt_user_question_submitted_idx" ON "practice_attempt" USING btree ("user_id", "practice_question_id", "submitted_at");
--> statement-breakpoint
CREATE INDEX "practice_attempt_user_course_submitted_idx" ON "practice_attempt" USING btree ("user_id", "submitted_at");
