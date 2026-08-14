CREATE TABLE "organization_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"organization_role" "role" NOT NULL,
	"space_id" uuid,
	"space_role" "role",
	"token_hash" text NOT NULL,
	"invited_by" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitation_token_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_space_id_knowledge_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."knowledge_space"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_invited_by_app_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."app_user"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "organization_invitation_org_idx" ON "organization_invitation" USING btree ("organization_id", "created_at");
