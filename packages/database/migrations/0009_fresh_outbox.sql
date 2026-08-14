CREATE TYPE "job_outbox_status" AS ENUM('pending', 'dispatching', 'sent', 'discarded');
--> statement-breakpoint
CREATE TABLE "job_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "processing_job_id" uuid NOT NULL REFERENCES "processing_job"("id") ON DELETE cascade,
  "resource_version_id" uuid NOT NULL REFERENCES "resource_version"("id") ON DELETE cascade,
  "status" "job_outbox_status" DEFAULT 'pending' NOT NULL,
  "attempt_count" integer DEFAULT 0 NOT NULL,
  "dispatch_token" text,
  "dispatch_lease_expires_at" timestamp with time zone,
  "queue_job_id" uuid,
  "last_error_code" text,
  "last_error_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "job_outbox_processing_job_unique" ON "job_outbox" USING btree ("processing_job_id");
--> statement-breakpoint
CREATE INDEX "job_outbox_dispatch_idx"
  ON "job_outbox" USING btree ("status", "dispatch_lease_expires_at", "created_at");
