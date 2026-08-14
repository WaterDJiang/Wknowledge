ALTER TABLE "agent_tool_call" DROP CONSTRAINT "agent_tool_call_name_check";
--> statement-breakpoint
ALTER TABLE "agent_tool_call"
ADD CONSTRAINT "agent_tool_call_name_check" CHECK ("name" IN ('knowledge.search', 'knowledge.read'));
