CREATE TABLE "model_call" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_run_id" uuid NOT NULL,
	"provider_id" text,
	"model" text,
	"capability" text NOT NULL,
	"status" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_call_query_run_id_unique" UNIQUE("query_run_id")
);
--> statement-breakpoint
CREATE TABLE "query_evidence_candidate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"query_run_id" uuid NOT NULL,
	"evidence_id" text NOT NULL,
	"page_id" text NOT NULL,
	"page_title" text NOT NULL,
	"page_type" text NOT NULL,
	"rank" integer NOT NULL,
	"source_count" integer NOT NULL,
	"cited" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"user_id" uuid,
	"question_sha256" text NOT NULL,
	"question_length" integer NOT NULL,
	"answer_mode" text NOT NULL,
	"insufficient_evidence" boolean NOT NULL,
	"searched_pages" integer NOT NULL,
	"embedding_calls" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer NOT NULL,
	"candidate_count" integer NOT NULL,
	"cited_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_call" ADD CONSTRAINT "model_call_query_run_id_query_run_id_fk" FOREIGN KEY ("query_run_id") REFERENCES "public"."query_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_evidence_candidate" ADD CONSTRAINT "query_evidence_candidate_query_run_id_query_run_id_fk" FOREIGN KEY ("query_run_id") REFERENCES "public"."query_run"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_run" ADD CONSTRAINT "query_run_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_run" ADD CONSTRAINT "query_run_space_id_knowledge_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."knowledge_space"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_run" ADD CONSTRAINT "query_run_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_call_query_run_idx" ON "model_call" USING btree ("query_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "query_evidence_run_rank_unique" ON "query_evidence_candidate" USING btree ("query_run_id","rank");--> statement-breakpoint
CREATE INDEX "query_evidence_run_idx" ON "query_evidence_candidate" USING btree ("query_run_id");--> statement-breakpoint
CREATE INDEX "query_run_org_created_idx" ON "query_run" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "query_run_space_created_idx" ON "query_run" USING btree ("space_id","created_at");