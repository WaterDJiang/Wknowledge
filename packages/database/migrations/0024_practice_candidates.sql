CREATE TYPE "practice_set_status" AS ENUM('candidate', 'archived');
--> statement-breakpoint
CREATE TYPE "practice_difficulty" AS ENUM('easy', 'standard', 'challenge');
--> statement-breakpoint
CREATE TABLE "practice_set" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "course_id" uuid NOT NULL REFERENCES "course"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "status" "practice_set_status" NOT NULL DEFAULT 'candidate',
  "difficulty" "practice_difficulty" NOT NULL,
  "generation" text NOT NULL DEFAULT 'deterministic_template',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "practice_set_user_course_created_idx" ON "practice_set" USING btree ("user_id", "course_id", "created_at");
--> statement-breakpoint
CREATE TABLE "practice_question" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "practice_set_id" uuid NOT NULL REFERENCES "practice_set"("id") ON DELETE cascade,
  "course_unit_id" uuid NOT NULL REFERENCES "course_unit"("id") ON DELETE cascade,
  "knowledge_point_id" uuid NOT NULL REFERENCES "course_knowledge_point"("id") ON DELETE restrict,
  "resource_version_id" uuid NOT NULL REFERENCES "resource_version"("id") ON DELETE cascade,
  "source_ref" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "answer_type" text NOT NULL DEFAULT 'free_response',
  "prompt" text NOT NULL,
  "rubric" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "practice_question_set_created_idx" ON "practice_question" USING btree ("practice_set_id", "created_at");
--> statement-breakpoint
CREATE INDEX "practice_question_knowledge_point_idx" ON "practice_question" USING btree ("knowledge_point_id");
