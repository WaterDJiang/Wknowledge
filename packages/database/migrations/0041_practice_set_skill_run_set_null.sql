ALTER TABLE "practice_set"
DROP CONSTRAINT "practice_set_skill_run_id_fkey";
--> statement-breakpoint
ALTER TABLE "practice_set"
ADD CONSTRAINT "practice_set_skill_run_id_fkey"
FOREIGN KEY ("skill_run_id") REFERENCES "skill_run"("id") ON DELETE set null;
