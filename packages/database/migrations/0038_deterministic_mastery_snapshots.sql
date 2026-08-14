ALTER TABLE "mastery_snapshot" ADD COLUMN "grade_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "mastery_grade_unique" ON "mastery_snapshot" USING btree ("grade_id");
--> statement-breakpoint
INSERT INTO "mastery_snapshot" ("user_id", "knowledge_point_id", "grade_id", "score", "evidence", "created_at")
SELECT
  attempt."user_id",
  attempt."knowledge_point_id"::text,
  grade."id",
  grade."score"::real / grade."maximum_score"::real,
  jsonb_build_object(
    'schemaVersion', 1,
    'courseId', practice_set."course_id",
    'courseUnitId', attempt."course_unit_id",
    'knowledgePointId', attempt."knowledge_point_id",
    'attemptType', 'practice',
    'attemptId', attempt."id",
    'gradeId', grade."id",
    'grader', grade."grader",
    'ruleVersion', grade."rule_version",
    'score', grade."score",
    'maximumScore', grade."maximum_score",
    'correct', grade."correct",
    'resourceVersionId', attempt."resource_version_id",
    'sourceRef', attempt."source_ref"
  ),
  grade."created_at"
FROM "practice_grade" AS grade
INNER JOIN "practice_attempt" AS attempt ON attempt."id" = grade."attempt_id"
INNER JOIN "practice_question" AS question ON question."id" = attempt."practice_question_id"
INNER JOIN "practice_set" AS practice_set ON practice_set."id" = question."practice_set_id"
ON CONFLICT ("grade_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "mastery_snapshot" ("user_id", "knowledge_point_id", "grade_id", "score", "evidence", "created_at")
SELECT
  attempt."user_id",
  attempt."knowledge_point_id"::text,
  grade."id",
  grade."score"::real / grade."maximum_score"::real,
  jsonb_build_object(
    'schemaVersion', 1,
    'courseId', assessment."course_id",
    'courseUnitId', attempt."course_unit_id",
    'knowledgePointId', attempt."knowledge_point_id",
    'attemptType', 'assessment',
    'attemptId', attempt."id",
    'gradeId', grade."id",
    'grader', grade."grader",
    'ruleVersion', grade."rule_version",
    'score', grade."score",
    'maximumScore', grade."maximum_score",
    'correct', grade."correct",
    'resourceVersionId', attempt."resource_version_id",
    'sourceRef', attempt."source_ref"
  ),
  grade."created_at"
FROM "assessment_grade" AS grade
INNER JOIN "assessment_attempt" AS attempt ON attempt."id" = grade."attempt_id"
INNER JOIN "assessment" AS assessment ON assessment."id" = attempt."assessment_id"
ON CONFLICT ("grade_id") DO NOTHING;
