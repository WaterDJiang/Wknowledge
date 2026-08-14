CREATE TABLE "agent_run_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE cascade,
  "sequence" integer NOT NULL,
  "type" text NOT NULL,
  "tool" text,
  "input_summary" text,
  "output_summary" text,
  "status" "agent_run_status",
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_run_event_type_check" CHECK (
    "type" IN ('run.started', 'tool.requested', 'tool.completed', 'run.completed', 'run.failed', 'run.stopped')
  ),
  CONSTRAINT "agent_run_event_shape_check" CHECK (
    ("type" = 'run.started' AND "tool" IS NULL AND "input_summary" IS NULL AND "output_summary" IS NULL AND "status" = 'running')
    OR ("type" = 'tool.requested' AND "tool" IS NOT NULL AND "input_summary" IS NOT NULL AND "output_summary" IS NULL AND "status" IS NULL)
    OR ("type" = 'tool.completed' AND "tool" IS NOT NULL AND "input_summary" IS NULL AND "output_summary" IS NOT NULL AND "status" IS NULL)
    OR ("type" = 'run.completed' AND "tool" IS NULL AND "input_summary" IS NULL AND "output_summary" IS NULL AND "status" = 'completed')
    OR ("type" = 'run.failed' AND "tool" IS NULL AND "input_summary" IS NULL AND "output_summary" IS NULL AND "status" = 'failed')
    OR ("type" = 'run.stopped' AND "tool" IS NULL AND "input_summary" IS NULL AND "output_summary" IS NULL AND "status" = 'stopped')
  ),
  CONSTRAINT "agent_run_event_summary_size_check" CHECK (
    ("input_summary" IS NULL OR char_length("input_summary") <= 300)
    AND ("output_summary" IS NULL OR char_length("output_summary") <= 300)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_run_event_sequence_unique"
ON "agent_run_event" USING btree ("agent_run_id", "sequence");
--> statement-breakpoint
CREATE INDEX "agent_run_event_run_created_idx"
ON "agent_run_event" USING btree ("agent_run_id", "created_at");
