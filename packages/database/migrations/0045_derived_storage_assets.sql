CREATE TABLE "derived_storage_asset" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "asset_key" text NOT NULL,
  "byte_size" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "derived_storage_asset_org_key_unique"
ON "derived_storage_asset" USING btree ("organization_id", "asset_key");
--> statement-breakpoint
CREATE INDEX "derived_storage_asset_org_idx"
ON "derived_storage_asset" USING btree ("organization_id");
