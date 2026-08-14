ALTER TABLE "course_unit"
  DROP CONSTRAINT "course_unit_resource_version_id_fkey";
--> statement-breakpoint
ALTER TABLE "course_unit"
  ADD CONSTRAINT "course_unit_resource_version_id_fkey"
  FOREIGN KEY ("resource_version_id") REFERENCES "resource_version"("id") ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE "course_knowledge_point"
  DROP CONSTRAINT "course_knowledge_point_resource_version_id_fkey";
--> statement-breakpoint
ALTER TABLE "course_knowledge_point"
  ADD CONSTRAINT "course_knowledge_point_resource_version_id_fkey"
  FOREIGN KEY ("resource_version_id") REFERENCES "resource_version"("id") ON DELETE cascade;
