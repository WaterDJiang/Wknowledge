ALTER TABLE "practice_grade"
  ADD COLUMN "reviewer_user_id" uuid,
  ADD COLUMN "rationale" text;
--> statement-breakpoint
ALTER TABLE "assessment_grade"
  ADD COLUMN "reviewer_user_id" uuid,
  ADD COLUMN "rationale" text;
--> statement-breakpoint
ALTER TABLE "practice_grade"
  DROP CONSTRAINT IF EXISTS "practice_grade_grader_check",
  DROP CONSTRAINT IF EXISTS "practice_grade_score_check",
  DROP CONSTRAINT IF EXISTS "practice_grade_correct_score_check";
--> statement-breakpoint
ALTER TABLE "practice_grade"
  ADD CONSTRAINT "practice_grade_grader_check" CHECK (
    ("grader" = 'objective_rule' AND "rule_version" = 'exact_response.v1' AND "maximum_score" = 1 AND "reviewer_user_id" IS NULL AND "rationale" IS NULL)
    OR
    ("grader" = 'human_review' AND "rule_version" = 'manual_rubric.v1' AND "reviewer_user_id" IS NOT NULL AND length("rationale") BETWEEN 1 AND 1000)
  ),
  ADD CONSTRAINT "practice_grade_score_check" CHECK ("score" >= 0 AND "maximum_score" > 0 AND "score" <= "maximum_score"),
  ADD CONSTRAINT "practice_grade_correct_score_check" CHECK (
    ("correct" = true AND "score" = "maximum_score") OR ("correct" = false AND "score" < "maximum_score")
  );
--> statement-breakpoint
ALTER TABLE "assessment_grade"
  DROP CONSTRAINT IF EXISTS "assessment_grade_grader_check",
  DROP CONSTRAINT IF EXISTS "assessment_grade_score_check",
  DROP CONSTRAINT IF EXISTS "assessment_grade_correct_score_check";
--> statement-breakpoint
ALTER TABLE "assessment_grade"
  ADD CONSTRAINT "assessment_grade_grader_check" CHECK (
    ("grader" = 'objective_rule' AND "rule_version" = 'exact_response.v1' AND "maximum_score" = 1 AND "reviewer_user_id" IS NULL AND "rationale" IS NULL)
    OR
    ("grader" = 'human_review' AND "rule_version" = 'manual_rubric.v1' AND "reviewer_user_id" IS NOT NULL AND length("rationale") BETWEEN 1 AND 1000)
  ),
  ADD CONSTRAINT "assessment_grade_score_check" CHECK ("score" >= 0 AND "maximum_score" > 0 AND "score" <= "maximum_score"),
  ADD CONSTRAINT "assessment_grade_correct_score_check" CHECK (
    ("correct" = true AND "score" = "maximum_score") OR ("correct" = false AND "score" < "maximum_score")
  );
