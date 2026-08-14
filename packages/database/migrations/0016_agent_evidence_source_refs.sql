ALTER TABLE "agent_evidence_snapshot"
ADD COLUMN "source_refs" jsonb NOT NULL DEFAULT '[]'::jsonb;
