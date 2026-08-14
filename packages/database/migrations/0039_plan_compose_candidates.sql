CREATE TABLE "plan_compose_candidate" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_run_id" uuid NOT NULL REFERENCES "skill_run"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "candidate" jsonb NOT NULL,
  "materialized_learning_plan_id" uuid REFERENCES "learning_plan"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "plan_compose_candidate_skill_run_unique"
ON "plan_compose_candidate" USING btree ("skill_run_id");
--> statement-breakpoint
CREATE INDEX "plan_compose_candidate_user_created_idx"
ON "plan_compose_candidate" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "plan_compose_candidate_materialized_plan_unique"
ON "plan_compose_candidate" USING btree ("materialized_learning_plan_id");
