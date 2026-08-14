ALTER TABLE "model_provider"
ADD COLUMN "capabilities" jsonb NOT NULL DEFAULT '["chat"]'::jsonb;
