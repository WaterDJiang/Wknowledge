import { desc, eq } from "drizzle-orm";
import {
  managedQueryRunSchema,
  queryRunAuditSchema,
  type ManagedQueryRun,
  type QueryRunAudit
} from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";

export async function persistQueryRun(input: {
  organizationId: string;
  spaceId: string;
  userId: string;
  audit: QueryRunAudit;
}): Promise<void> {
  const audit = queryRunAuditSchema.parse(input.audit);
  await getDatabase().transaction(async (transaction) => {
    await transaction.insert(schema.queryRuns).values({
      id: audit.id,
      organizationId: input.organizationId,
      spaceId: input.spaceId,
      userId: input.userId,
      questionSha256: audit.questionSha256,
      questionLength: audit.questionLength,
      answerMode: audit.answerMode,
      insufficientEvidence: audit.insufficientEvidence,
      searchedPages: audit.searchedPages,
      embeddingCalls: audit.embeddingCalls,
      durationMs: audit.durationMs,
      candidateCount: audit.candidates.length,
      citedCount: audit.candidates.filter(({ cited }) => cited).length
    });
    if (audit.candidates.length)
      await transaction.insert(schema.queryEvidenceCandidates).values(
        audit.candidates.map((candidate) => ({
          queryRunId: audit.id,
          ...candidate
        }))
      );
    if (audit.modelCall)
      await transaction.insert(schema.modelCalls).values({
        queryRunId: audit.id,
        ...audit.modelCall
      });
  });
}

export async function listManagedQueryRuns(
  organizationId: string,
  limit: number
): Promise<ManagedQueryRun[]> {
  const rows = await getDatabase()
    .select({
      run: schema.queryRuns,
      spaceName: schema.knowledgeSpaces.name,
      modelCall: schema.modelCalls
    })
    .from(schema.queryRuns)
    .innerJoin(schema.knowledgeSpaces, eq(schema.queryRuns.spaceId, schema.knowledgeSpaces.id))
    .leftJoin(schema.modelCalls, eq(schema.modelCalls.queryRunId, schema.queryRuns.id))
    .where(eq(schema.queryRuns.organizationId, organizationId))
    .orderBy(desc(schema.queryRuns.createdAt))
    .limit(limit);

  return rows.map(({ run, spaceName, modelCall }) =>
    managedQueryRunSchema.parse({
      id: run.id,
      organizationId: run.organizationId,
      spaceId: run.spaceId,
      spaceName,
      userId: run.userId,
      questionSha256: run.questionSha256,
      questionLength: run.questionLength,
      answerMode: run.answerMode,
      insufficientEvidence: run.insufficientEvidence,
      searchedPages: run.searchedPages,
      embeddingCalls: run.embeddingCalls,
      durationMs: run.durationMs,
      candidateCount: run.candidateCount,
      citedCount: run.citedCount,
      modelCall: modelCall
        ? {
            status: modelCall.status,
            providerId: modelCall.providerId,
            model: modelCall.model,
            capability: modelCall.capability,
            durationMs: modelCall.durationMs,
            errorCode: modelCall.errorCode
          }
        : null,
      createdAt: run.createdAt.toISOString()
    })
  );
}
