CREATE TABLE "learning_generation_request" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_run_id" uuid NOT NULL REFERENCES "skill_run"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "input" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "learning_generation_request_skill_run_unique"
ON "learning_generation_request" USING btree ("skill_run_id");
--> statement-breakpoint
CREATE INDEX "learning_generation_request_kind_created_idx"
ON "learning_generation_request" USING btree ("kind", "created_at");
