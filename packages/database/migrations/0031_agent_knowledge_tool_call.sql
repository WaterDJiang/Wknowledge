CREATE TABLE "agent_tool_call" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "binding_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "input_summary" text NOT NULL,
  "output_summary" text NOT NULL,
  "result_count" integer NOT NULL,
  "searched_pages" integer NOT NULL,
  "duration_ms" integer NOT NULL,
  "completed_at" timestamp with time zone NOT NULL,
  CONSTRAINT "agent_tool_call_name_check" CHECK ("name" = 'knowledge.search'),
  CONSTRAINT "agent_tool_call_counts_check" CHECK (
    "result_count" >= 0 AND "searched_pages" >= 0 AND "duration_ms" >= 0
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_call_run_name_unique"
ON "agent_tool_call" USING btree ("agent_run_id", "name");
--> statement-breakpoint
CREATE INDEX "agent_tool_call_run_completed_idx"
ON "agent_tool_call" USING btree ("agent_run_id", "completed_at");
