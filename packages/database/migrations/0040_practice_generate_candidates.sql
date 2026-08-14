ALTER TABLE "practice_set"
ADD COLUMN "skill_run_id" uuid REFERENCES "skill_run"("id") ON DELETE set null;
--> statement-breakpoint
CREATE TABLE "practice_generate_candidate" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_run_id" uuid NOT NULL REFERENCES "skill_run"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "candidate" jsonb NOT NULL,
  "materialized_practice_set_id" uuid REFERENCES "practice_set"("id") ON DELETE set null,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_generate_candidate_skill_run_unique"
ON "practice_generate_candidate" USING btree ("skill_run_id");
--> statement-breakpoint
CREATE INDEX "practice_generate_candidate_user_created_idx"
ON "practice_generate_candidate" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_generate_candidate_materialized_set_unique"
ON "practice_generate_candidate" USING btree ("materialized_practice_set_id");
