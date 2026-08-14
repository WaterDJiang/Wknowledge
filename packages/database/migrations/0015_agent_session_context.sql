CREATE TYPE "agent_session_status" AS ENUM('active', 'archived');
--> statement-breakpoint
CREATE TYPE "agent_context_binding_status" AS ENUM('active', 'removed', 'revoked');
--> statement-breakpoint
CREATE TYPE "agent_message_role" AS ENUM('user', 'assistant');
--> statement-breakpoint
CREATE TYPE "agent_run_status" AS ENUM('completed', 'failed');
--> statement-breakpoint
CREATE TABLE "agent_session" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "status" "agent_session_status" DEFAULT 'active' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_session_user_updated_idx" ON "agent_session" USING btree ("user_id", "updated_at");
--> statement-breakpoint
CREATE INDEX "agent_session_org_created_idx" ON "agent_session" USING btree ("organization_id", "created_at");
--> statement-breakpoint
CREATE TABLE "agent_context_binding" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "agent_session"("id") ON DELETE cascade,
  "space_id" uuid NOT NULL REFERENCES "knowledge_space"("id") ON DELETE cascade,
  "scope" text DEFAULT 'space' NOT NULL,
  "virtual_path" text NOT NULL,
  "label" text NOT NULL,
  "status" "agent_context_binding_status" DEFAULT 'active' NOT NULL,
  "created_by" uuid NOT NULL REFERENCES "app_user"("id"),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "agent_context_binding_scope_check" CHECK ("scope" = 'space'),
  CONSTRAINT "agent_context_binding_virtual_path_check" CHECK ("virtual_path" = '/knowledge/' || "space_id"::text)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_context_session_space_unique" ON "agent_context_binding" USING btree ("session_id", "space_id");
--> statement-breakpoint
CREATE INDEX "agent_context_session_status_idx" ON "agent_context_binding" USING btree ("session_id", "status");
--> statement-breakpoint
CREATE TABLE "agent_message" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "agent_session"("id") ON DELETE cascade,
  "role" "agent_message_role" NOT NULL,
  "content" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_message_session_created_idx" ON "agent_message" USING btree ("session_id", "created_at");
--> statement-breakpoint
CREATE TABLE "agent_run" (
  "id" uuid PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL REFERENCES "agent_session"("id") ON DELETE cascade,
  "user_message_id" uuid NOT NULL REFERENCES "agent_message"("id") ON DELETE cascade,
  "assistant_message_id" uuid REFERENCES "agent_message"("id") ON DELETE set null,
  "status" "agent_run_status" NOT NULL,
  "answer_mode" text,
  "insufficient_evidence" boolean,
  "searched_pages" integer DEFAULT 0 NOT NULL,
  "embedding_calls" integer DEFAULT 0 NOT NULL,
  "duration_ms" integer DEFAULT 0 NOT NULL,
  "error_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  CONSTRAINT "agent_run_embedding_calls_check" CHECK ("embedding_calls" = 0)
);
--> statement-breakpoint
CREATE INDEX "agent_run_session_created_idx" ON "agent_run" USING btree ("session_id", "created_at");
--> statement-breakpoint
CREATE TABLE "agent_evidence_snapshot" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_run_id" uuid NOT NULL REFERENCES "agent_run"("id") ON DELETE cascade,
  "evidence_id" text NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "knowledge_space"("id") ON DELETE cascade,
  "page_id" text NOT NULL,
  "page_title" text NOT NULL,
  "page_type" text NOT NULL,
  "rank" integer NOT NULL,
  "source_count" integer NOT NULL,
  "cited" boolean NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_evidence_run_rank_unique" ON "agent_evidence_snapshot" USING btree ("agent_run_id", "rank");
--> statement-breakpoint
CREATE INDEX "agent_evidence_run_idx" ON "agent_evidence_snapshot" USING btree ("agent_run_id");
