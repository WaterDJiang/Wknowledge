ALTER TABLE "organization" ADD COLUMN "storage_quota_bytes" integer DEFAULT 1073741824 NOT NULL;
--> statement-breakpoint
CREATE TABLE "storage_reservation" (
  "id" uuid PRIMARY KEY NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organization"("id") ON DELETE cascade,
  "byte_size" integer NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "storage_reservation_org_expiry_idx" ON "storage_reservation" USING btree ("organization_id", "expires_at");
--> statement-breakpoint
ALTER TABLE "resource_upload" ADD COLUMN "storage_reservation_id" uuid REFERENCES "storage_reservation"("id") ON DELETE set null;
