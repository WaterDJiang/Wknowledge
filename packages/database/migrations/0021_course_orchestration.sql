CREATE TYPE "course_status" AS ENUM('active', 'archived');
--> statement-breakpoint
CREATE TABLE "course" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "learning_plan_id" uuid NOT NULL REFERENCES "learning_plan"("id") ON DELETE cascade,
  "status" "course_status" NOT NULL DEFAULT 'active',
  "title" text NOT NULL,
  "goal" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "course_learning_plan_id_unique" UNIQUE("learning_plan_id")
);
--> statement-breakpoint
CREATE INDEX "course_status_created_idx" ON "course" USING btree ("status", "created_at");
--> statement-breakpoint
CREATE TABLE "course_module" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "course_id" uuid NOT NULL REFERENCES "course"("id") ON DELETE cascade,
  "ordinal" integer NOT NULL,
  "title" text NOT NULL,
  "objective" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "course_module_ordinal_unique" ON "course_module" USING btree ("course_id", "ordinal");
--> statement-breakpoint
CREATE TABLE "course_unit" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "course_module_id" uuid NOT NULL REFERENCES "course_module"("id") ON DELETE cascade,
  "plan_unit_id" text NOT NULL,
  "ordinal" integer NOT NULL,
  "title" text NOT NULL,
  "objective" text NOT NULL,
  "completion_rule" text NOT NULL,
  "resource_version_id" uuid NOT NULL REFERENCES "resource_version"("id") ON DELETE restrict,
  "source_ref" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "course_unit_plan_unit_unique" ON "course_unit" USING btree ("course_module_id", "plan_unit_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "course_unit_ordinal_unique" ON "course_unit" USING btree ("course_module_id", "ordinal");
--> statement-breakpoint
CREATE TABLE "course_knowledge_point" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "course_unit_id" uuid NOT NULL REFERENCES "course_unit"("id") ON DELETE cascade,
  "ordinal" integer NOT NULL,
  "title" text NOT NULL,
  "statement" text NOT NULL,
  "resource_version_id" uuid NOT NULL REFERENCES "resource_version"("id") ON DELETE restrict,
  "source_ref" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "course_kp_ordinal_unique" ON "course_knowledge_point" USING btree ("course_unit_id", "ordinal");
