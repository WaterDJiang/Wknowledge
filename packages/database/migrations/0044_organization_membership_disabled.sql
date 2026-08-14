ALTER TABLE "organization_membership" ADD COLUMN "disabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE INDEX "organization_membership_active_user_idx"
ON "organization_membership" USING btree ("user_id", "disabled");
