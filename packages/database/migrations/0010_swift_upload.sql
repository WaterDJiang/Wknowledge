CREATE TYPE "resource_upload_status" AS ENUM('open', 'completed', 'expired', 'aborted');
--> statement-breakpoint
CREATE TABLE "resource_upload" (
  "id" uuid PRIMARY KEY NOT NULL,
  "space_id" uuid NOT NULL REFERENCES "knowledge_space"("id") ON DELETE cascade,
  "user_id" uuid NOT NULL REFERENCES "app_user"("id") ON DELETE cascade,
  "original_name" text NOT NULL,
  "mime_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" text NOT NULL,
  "compile_profile" text DEFAULT 'reference' NOT NULL,
  "part_size" integer NOT NULL,
  "total_parts" integer NOT NULL,
  "status" "resource_upload_status" DEFAULT 'open' NOT NULL,
  "duplicate" boolean DEFAULT false NOT NULL,
  "resource_version_id" uuid REFERENCES "resource_version"("id") ON DELETE set null,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_upload_part" (
  "upload_id" uuid NOT NULL REFERENCES "resource_upload"("id") ON DELETE cascade,
  "part_number" integer NOT NULL,
  "byte_size" integer NOT NULL,
  "sha256" text NOT NULL,
  "blob_uri" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "resource_upload_part_upload_id_part_number_pk" PRIMARY KEY("upload_id", "part_number")
);
--> statement-breakpoint
CREATE INDEX "resource_upload_user_idx" ON "resource_upload" USING btree ("user_id", "created_at");
--> statement-breakpoint
CREATE INDEX "resource_upload_space_status_idx" ON "resource_upload" USING btree ("space_id", "status", "expires_at");
--> statement-breakpoint
CREATE INDEX "resource_upload_part_upload_idx" ON "resource_upload_part" USING btree ("upload_id");
