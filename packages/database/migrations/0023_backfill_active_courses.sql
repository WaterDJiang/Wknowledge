INSERT INTO "course" ("learning_plan_id", "status", "title", "goal")
SELECT
  "id",
  'active',
  "title",
  "plan" ->> 'goal'
FROM "learning_plan"
WHERE "status" = 'active'
  AND jsonb_typeof("plan" -> 'units') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements("plan" -> 'units') AS "unit"("value")
    LEFT JOIN "resource_version" ON "resource_version"."id"::text = "unit"."value" ->> 'resourceVersionId'
    WHERE COALESCE("unit"."value" ->> 'resourceVersionId', '') = ''
       OR COALESCE("unit"."value" ->> 'sourceRef', '') = ''
       OR "resource_version"."id" IS NULL
  )
ON CONFLICT ("learning_plan_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "course_module" ("course_id", "ordinal", "title", "objective")
SELECT
  "course"."id",
  1,
  '原文学习',
  '按计划顺序学习每份固定版本资料，并保留可追溯的完成记录。'
FROM "course"
JOIN "learning_plan" ON "learning_plan"."id" = "course"."learning_plan_id"
WHERE "learning_plan"."status" = 'active'
  AND jsonb_typeof("learning_plan"."plan" -> 'units') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements("learning_plan"."plan" -> 'units') AS "unit"("value")
    LEFT JOIN "resource_version" ON "resource_version"."id"::text = "unit"."value" ->> 'resourceVersionId'
    WHERE COALESCE("unit"."value" ->> 'resourceVersionId', '') = ''
       OR COALESCE("unit"."value" ->> 'sourceRef', '') = ''
       OR "resource_version"."id" IS NULL
  )
ON CONFLICT ("course_id", "ordinal") DO NOTHING;
--> statement-breakpoint
INSERT INTO "course_unit" (
  "course_module_id",
  "plan_unit_id",
  "ordinal",
  "title",
  "objective",
  "completion_rule",
  "resource_version_id",
  "source_ref"
)
SELECT
  "course_module"."id",
  "unit"."value" ->> 'id',
  "unit"."ordinality"::integer,
  "unit"."value" ->> 'title',
  "unit"."value" ->> 'objective',
  "unit"."value" ->> 'completionRule',
  ("unit"."value" ->> 'resourceVersionId')::uuid,
  "unit"."value" ->> 'sourceRef'
FROM "course_module"
JOIN "course" ON "course"."id" = "course_module"."course_id"
JOIN "learning_plan" ON "learning_plan"."id" = "course"."learning_plan_id"
CROSS JOIN LATERAL jsonb_array_elements("learning_plan"."plan" -> 'units') WITH ORDINALITY AS "unit"("value", "ordinality")
JOIN "resource_version" ON "resource_version"."id"::text = "unit"."value" ->> 'resourceVersionId'
WHERE "learning_plan"."status" = 'active'
  AND jsonb_typeof("learning_plan"."plan" -> 'units') = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements("learning_plan"."plan" -> 'units') AS "candidate"("value")
    LEFT JOIN "resource_version" ON "resource_version"."id"::text = "candidate"."value" ->> 'resourceVersionId'
    WHERE COALESCE("candidate"."value" ->> 'resourceVersionId', '') = ''
       OR COALESCE("candidate"."value" ->> 'sourceRef', '') = ''
       OR "resource_version"."id" IS NULL
  )
ON CONFLICT ("course_module_id", "plan_unit_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "course_knowledge_point" (
  "course_unit_id",
  "ordinal",
  "title",
  "statement",
  "resource_version_id",
  "source_ref"
)
SELECT
  "course_unit"."id",
  1,
  '原文学习重点：' || "course_unit"."title",
  '本重点是课程结构锚点；正式知识拆分与练习依据仍需回查该固定版本原文。',
  "course_unit"."resource_version_id",
  "course_unit"."source_ref"
FROM "course_unit"
JOIN "course_module" ON "course_module"."id" = "course_unit"."course_module_id"
JOIN "course" ON "course"."id" = "course_module"."course_id"
JOIN "learning_plan" ON "learning_plan"."id" = "course"."learning_plan_id"
WHERE "learning_plan"."status" = 'active'
ON CONFLICT ("course_unit_id", "ordinal") DO NOTHING;
