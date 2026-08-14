import { and, eq, inArray } from "drizzle-orm";
import type { LearningPlanSnapshot } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";

export function learningPlanResourceVersionIds(plan: LearningPlanSnapshot): string[] {
  return [
    ...new Set([
      ...plan.selections.map(({ resourceVersionId }) => resourceVersionId),
      ...plan.units.map(({ resourceVersionId }) => resourceVersionId)
    ])
  ];
}

export async function assertLearningResourceVersionsReadable(input: {
  userId: string;
  resourceVersionIds: readonly string[];
  errorCode: string;
}): Promise<void> {
  const resourceVersionIds = [...new Set(input.resourceVersionIds)];
  if (!resourceVersionIds.length) return;
  const authorized = await getDatabase()
    .select({ id: schema.resourceVersions.id })
    .from(schema.resourceVersions)
    .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
    .innerJoin(
      schema.spaceMemberships,
      eq(schema.resources.spaceId, schema.spaceMemberships.spaceId)
    )
    .innerJoin(schema.knowledgeSpaces, eq(schema.resources.spaceId, schema.knowledgeSpaces.id))
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.knowledgeSpaces.organizationId),
        eq(schema.organizationMemberships.userId, input.userId)
      )
    )
    .where(
      and(
        eq(schema.spaceMemberships.userId, input.userId),
        eq(schema.organizationMemberships.disabled, false),
        inArray(schema.resourceVersions.id, resourceVersionIds)
      )
    );
  if (new Set(authorized.map(({ id }) => id)).size !== resourceVersionIds.length)
    throw new Error(input.errorCode);
}

export async function assertLearningPlanSourcesReadable(
  userId: string,
  plan: LearningPlanSnapshot,
  errorCode = "LEARNING_PLAN_SOURCE_REVOKED"
): Promise<void> {
  await assertLearningResourceVersionsReadable({
    userId,
    resourceVersionIds: learningPlanResourceVersionIds(plan),
    errorCode
  });
}
