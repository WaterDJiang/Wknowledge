CREATE TYPE "public"."provider_health" AS ENUM('unknown', 'healthy', 'unhealthy');--> statement-breakpoint
CREATE TYPE "public"."provider_location" AS ENUM('local', 'cloud');--> statement-breakpoint
CREATE TABLE "model_provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'openai_compatible' NOT NULL,
	"location" "provider_location" NOT NULL,
	"base_url" text NOT NULL,
	"model" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"encrypted_api_key" text,
	"credential_iv" text,
	"credential_tag" text,
	"timeout_ms" integer DEFAULT 20000 NOT NULL,
	"health" "provider_health" DEFAULT 'unknown' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_installation" (
	"organization_id" uuid NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"digest" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_installation_organization_id_skill_id_pk" PRIMARY KEY("organization_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider" ADD CONSTRAINT "model_provider_created_by_app_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installation" ADD CONSTRAINT "skill_installation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installation" ADD CONSTRAINT "skill_installation_updated_by_app_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."app_user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_provider_org_idx" ON "model_provider" USING btree ("organization_id","updated_at");--> statement-breakpoint
CREATE INDEX "skill_installation_org_idx" ON "skill_installation" USING btree ("organization_id");