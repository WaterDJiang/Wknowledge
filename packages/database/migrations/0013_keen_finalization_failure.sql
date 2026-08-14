ALTER TYPE "resource_upload_status" ADD VALUE IF NOT EXISTS 'failed';
--> statement-breakpoint
ALTER TABLE "resource_upload" ADD COLUMN "error_code" text;
--> statement-breakpoint
ALTER TABLE "resource_upload" ADD COLUMN "error_message" text;
