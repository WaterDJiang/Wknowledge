CREATE TYPE "learning_report_status" AS ENUM('queued', 'rendering', 'completed', 'failed');
--> statement-breakpoint
CREATE TYPE "learning_report_artifact_format" AS ENUM('png', 'pdf');
--> statement-breakpoint
CREATE TABLE "learning_report_snapshot" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "learning_plan_id" uuid NOT NULL REFERENCES "learning_plan"("id") ON DELETE cascade,
  "course_id" uuid NOT NULL REFERENCES "course"("id") ON DELETE cascade,
  "report" jsonb NOT NULL,
  "status" "learning_report_status" NOT NULL DEFAULT 'queued',
  "execution_token" text,
  "execution_lease_expires_at" timestamp with time zone,
  "error_code" text,
  "error_message" text,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "learning_report_user_course_created_idx"
ON "learning_report_snapshot" USING btree ("user_id", "course_id", "created_at");
--> statement-breakpoint
CREATE INDEX "learning_report_status_lease_idx"
ON "learning_report_snapshot" USING btree ("status", "execution_lease_expires_at");
--> statement-breakpoint
CREATE TABLE "learning_report_artifact" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "snapshot_id" uuid NOT NULL REFERENCES "learning_report_snapshot"("id") ON DELETE cascade,
  "format" "learning_report_artifact_format" NOT NULL,
  "blob_uri" text NOT NULL,
  "sha256" text NOT NULL,
  "byte_size" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "learning_report_artifact_byte_size_check" CHECK ("byte_size" > 0),
  CONSTRAINT "learning_report_artifact_sha256_check" CHECK ("sha256" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "learning_report_artifact_snapshot_format_unique"
ON "learning_report_artifact" USING btree ("snapshot_id", "format");
--> statement-breakpoint
CREATE INDEX "learning_report_artifact_snapshot_idx"
ON "learning_report_artifact" USING btree ("snapshot_id");
--> statement-breakpoint
CREATE TABLE "learning_report_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "snapshot_id" uuid NOT NULL REFERENCES "learning_report_snapshot"("id") ON DELETE cascade,
  "status" "job_outbox_status" NOT NULL DEFAULT 'pending',
  "attempt_count" integer NOT NULL DEFAULT 0,
  "dispatch_token" text,
  "dispatch_lease_expires_at" timestamp with time zone,
  "queue_job_id" uuid,
  "last_error_code" text,
  "last_error_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "learning_report_outbox_snapshot_unique"
ON "learning_report_outbox" USING btree ("snapshot_id");
--> statement-breakpoint
CREATE INDEX "learning_report_outbox_dispatch_idx"
ON "learning_report_outbox" USING btree ("status", "dispatch_lease_expires_at", "created_at");
