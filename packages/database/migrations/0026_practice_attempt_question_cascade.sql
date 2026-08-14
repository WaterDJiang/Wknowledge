ALTER TABLE "practice_attempt" DROP CONSTRAINT "practice_attempt_practice_question_id_fkey";
--> statement-breakpoint
ALTER TABLE "practice_attempt"
  ADD CONSTRAINT "practice_attempt_practice_question_id_fkey"
  FOREIGN KEY ("practice_question_id") REFERENCES "practice_question"("id") ON DELETE cascade;
