ALTER TYPE "resource_status" ADD VALUE IF NOT EXISTS 'cancelled';
--> statement-breakpoint
ALTER TYPE "job_status" ADD VALUE IF NOT EXISTS 'cancel_requested';
--> statement-breakpoint
ALTER TYPE "job_status" ADD VALUE IF NOT EXISTS 'cancelled';
--> statement-breakpoint
ALTER TABLE "processing_job" ADD COLUMN IF NOT EXISTS "queue_job_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "processing_job_queue_job_idx" ON "processing_job" USING btree ("queue_job_id");
