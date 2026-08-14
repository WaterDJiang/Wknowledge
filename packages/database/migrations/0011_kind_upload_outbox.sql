ALTER TYPE "resource_upload_status" ADD VALUE IF NOT EXISTS 'finalizing';
--> statement-breakpoint
ALTER TABLE "job_outbox" ALTER COLUMN "resource_version_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_outbox" ADD COLUMN "kind" text DEFAULT 'resource.process' NOT NULL;
--> statement-breakpoint
ALTER TABLE "job_outbox" ADD COLUMN "upload_id" uuid REFERENCES "resource_upload"("id") ON DELETE cascade;
