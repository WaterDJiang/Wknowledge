ALTER TABLE "agent_context_binding" ADD COLUMN "target_id" text;
--> statement-breakpoint
ALTER TABLE "agent_context_binding" DROP CONSTRAINT "agent_context_binding_scope_check";
--> statement-breakpoint
ALTER TABLE "agent_context_binding" DROP CONSTRAINT "agent_context_binding_virtual_path_check";
--> statement-breakpoint
ALTER TABLE "agent_context_binding"
ADD CONSTRAINT "agent_context_binding_scope_target_check" CHECK (
  ("scope" = 'space' AND "target_id" IS NULL)
  OR ("scope" = 'wiki_page' AND "target_id" ~ '^[a-z0-9][a-z0-9_-]*$')
  OR ("scope" = 'resource_version' AND "target_id" ~ '^[0-9a-f-]{36}$')
);
--> statement-breakpoint
ALTER TABLE "agent_context_binding"
ADD CONSTRAINT "agent_context_binding_virtual_path_check" CHECK (
  ("scope" = 'space' AND "virtual_path" = '/knowledge/' || "space_id"::text)
  OR ("scope" = 'wiki_page' AND "virtual_path" = '/knowledge/' || "space_id"::text || '/wiki/pages/' || "target_id")
  OR ("scope" = 'resource_version' AND "virtual_path" = '/knowledge/' || "space_id"::text || '/resources/' || "target_id")
);
--> statement-breakpoint
DROP INDEX "agent_context_session_space_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_context_session_space_scope_unique"
ON "agent_context_binding" USING btree ("session_id", "space_id")
WHERE "scope" = 'space';
--> statement-breakpoint
CREATE UNIQUE INDEX "agent_context_session_scope_target_unique"
ON "agent_context_binding" USING btree ("session_id", "space_id", "scope", "target_id")
WHERE "target_id" IS NOT NULL;
