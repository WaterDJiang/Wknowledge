CREATE TABLE "skill_run_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_run_id" uuid NOT NULL REFERENCES "skill_run"("id") ON DELETE cascade,
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
CREATE UNIQUE INDEX "skill_run_outbox_run_unique" ON "skill_run_outbox" USING btree ("skill_run_id");
--> statement-breakpoint
CREATE INDEX "skill_run_outbox_dispatch_idx" ON "skill_run_outbox" USING btree ("status", "dispatch_lease_expires_at", "created_at");
