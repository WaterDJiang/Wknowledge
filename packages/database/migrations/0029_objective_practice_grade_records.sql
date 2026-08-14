ALTER TABLE "practice_question" ADD COLUMN "answer_key" text;
--> statement-breakpoint
ALTER TABLE "practice_question"
ADD CONSTRAINT "practice_question_answer_type_check" CHECK (
  ("answer_type" = 'free_response' AND "answer_key" IS NULL)
  OR ("answer_type" = 'exact_response' AND length("answer_key") > 0)
);
--> statement-breakpoint
ALTER TABLE "practice_attempt" ADD COLUMN "answer_key" text;
--> statement-breakpoint
ALTER TABLE "practice_attempt"
ADD CONSTRAINT "practice_attempt_answer_key_check" CHECK (
  "answer_key" IS NULL OR length("answer_key") > 0
);
--> statement-breakpoint
CREATE TABLE "practice_grade" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_id" uuid NOT NULL REFERENCES "practice_attempt"("id") ON DELETE cascade,
  "grader" text NOT NULL,
  "rule_version" text NOT NULL,
  "score" integer NOT NULL,
  "maximum_score" integer NOT NULL,
  "correct" boolean NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "practice_grade_attempt_unique" UNIQUE("attempt_id"),
  CONSTRAINT "practice_grade_grader_check" CHECK ("grader" = 'objective_rule'),
  CONSTRAINT "practice_grade_score_check" CHECK (
    "score" >= 0 AND "maximum_score" > 0 AND "score" <= "maximum_score"
  ),
  CONSTRAINT "practice_grade_correct_score_check" CHECK (
    ("correct" = true AND "score" = "maximum_score")
    OR ("correct" = false AND "score" = 0)
  )
);
--> statement-breakpoint
CREATE INDEX "practice_grade_created_idx" ON "practice_grade" USING btree ("created_at");
