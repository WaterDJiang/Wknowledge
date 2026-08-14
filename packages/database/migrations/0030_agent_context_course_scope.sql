ALTER TABLE "agent_context_binding" DROP CONSTRAINT "agent_context_binding_scope_target_check";
--> statement-breakpoint
ALTER TABLE "agent_context_binding" DROP CONSTRAINT "agent_context_binding_virtual_path_check";
--> statement-breakpoint
ALTER TABLE "agent_context_binding"
ADD CONSTRAINT "agent_context_binding_scope_target_check" CHECK (
  ("scope" = 'space' AND "target_id" IS NULL)
  OR ("scope" = 'wiki_page' AND "target_id" ~ '^[a-z0-9][a-z0-9_-]*$')
  OR ("scope" IN ('resource_version', 'course') AND "target_id" ~ '^[0-9a-f-]{36}$')
);
--> statement-breakpoint
ALTER TABLE "agent_context_binding"
ADD CONSTRAINT "agent_context_binding_virtual_path_check" CHECK (
  ("scope" = 'space' AND "virtual_path" = '/knowledge/' || "space_id"::text)
  OR ("scope" = 'wiki_page' AND "virtual_path" = '/knowledge/' || "space_id"::text || '/wiki/pages/' || "target_id")
  OR ("scope" = 'resource_version' AND "virtual_path" = '/knowledge/' || "space_id"::text || '/resources/' || "target_id")
  OR ("scope" = 'course' AND "virtual_path" = '/knowledge/' || "space_id"::text || '/courses/' || "target_id")
);
