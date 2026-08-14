CREATE TYPE "assessment_status" AS ENUM('draft', 'active', 'submitted');
--> statement-breakpoint
CREATE TABLE "assessment" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "course_id" uuid NOT NULL REFERENCES "course"("id") ON DELETE cascade,
  "practice_set_id" uuid NOT NULL REFERENCES "practice_set"("id") ON DELETE restrict,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "status" "assessment_status" NOT NULL DEFAULT 'draft',
  "title" text NOT NULL,
  "started_at" timestamp with time zone,
  "submitted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_practice_set_unique" ON "assessment" USING btree ("practice_set_id");
--> statement-breakpoint
CREATE INDEX "assessment_user_course_created_idx" ON "assessment" USING btree ("user_id", "course_id", "created_at");
--> statement-breakpoint
CREATE TABLE "assessment_question" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assessment_id" uuid NOT NULL REFERENCES "assessment"("id") ON DELETE cascade,
  "source_practice_question_id" uuid NOT NULL,
  "ordinal" integer NOT NULL,
  "course_unit_id" uuid NOT NULL,
  "knowledge_point_id" uuid NOT NULL,
  "resource_version_id" uuid NOT NULL,
  "source_ref" text NOT NULL,
  "question_version" integer NOT NULL,
  "answer_type" text NOT NULL,
  "answer_key" text,
  "prompt" text NOT NULL,
  "rubric" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_question_ordinal_unique" ON "assessment_question" USING btree ("assessment_id", "ordinal");
--> statement-breakpoint
CREATE INDEX "assessment_question_assessment_idx" ON "assessment_question" USING btree ("assessment_id");
--> statement-breakpoint
CREATE TABLE "assessment_attempt" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "assessment_id" uuid NOT NULL REFERENCES "assessment"("id") ON DELETE cascade,
  "assessment_question_id" uuid NOT NULL REFERENCES "assessment_question"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "course_unit_id" uuid NOT NULL,
  "knowledge_point_id" uuid NOT NULL,
  "resource_version_id" uuid NOT NULL,
  "source_ref" text NOT NULL,
  "question_version" integer NOT NULL,
  "prompt" text NOT NULL,
  "rubric" jsonb NOT NULL,
  "response" text NOT NULL,
  "answer_key" text,
  "status" "practice_attempt_status" NOT NULL DEFAULT 'pending_review',
  "submitted_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_attempt_question_unique" ON "assessment_attempt" USING btree ("assessment_question_id");
--> statement-breakpoint
CREATE INDEX "assessment_attempt_user_assessment_idx" ON "assessment_attempt" USING btree ("user_id", "assessment_id");
--> statement-breakpoint
CREATE TABLE "assessment_grade" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_id" uuid NOT NULL REFERENCES "assessment_attempt"("id") ON DELETE cascade,
  "grader" text NOT NULL,
  "rule_version" text NOT NULL,
  "score" integer NOT NULL,
  "maximum_score" integer NOT NULL,
  "correct" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "assessment_grade_attempt_unique" UNIQUE("attempt_id"),
  CONSTRAINT "assessment_grade_grader_check" CHECK ("grader" = 'objective_rule'),
  CONSTRAINT "assessment_grade_score_check" CHECK ("score" >= 0 AND "maximum_score" > 0 AND "score" <= "maximum_score"),
  CONSTRAINT "assessment_grade_correct_score_check" CHECK (("correct" = true AND "score" = "maximum_score") OR ("correct" = false AND "score" = 0))
);
--> statement-breakpoint
CREATE INDEX "assessment_grade_created_idx" ON "assessment_grade" USING btree ("created_at");
