CREATE TABLE "wiki_publication_lock" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"owner_token" text NOT NULL,
	"operation" text NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "wiki_publication_lock" ADD CONSTRAINT "wiki_publication_lock_space_id_knowledge_space_id_fk" FOREIGN KEY ("space_id") REFERENCES "public"."knowledge_space"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "wiki_publication_lock_expires_idx" ON "wiki_publication_lock" USING btree ("expires_at");
