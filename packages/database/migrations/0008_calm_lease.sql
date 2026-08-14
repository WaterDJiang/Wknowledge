ALTER TABLE "processing_job" ADD COLUMN IF NOT EXISTS "execution_token" text;
--> statement-breakpoint
ALTER TABLE "processing_job" ADD COLUMN IF NOT EXISTS "execution_lease_expires_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processing_job_execution_lease_idx"
  ON "processing_job" USING btree ("status", "execution_lease_expires_at");
