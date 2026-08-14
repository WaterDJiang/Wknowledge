import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type {
  AgentContextScope,
  AgentContextBindingStatus,
  CreateAgentContextBindingInput,
  AgentKnowledgeToolCall,
  AgentRunEvent,
  AgentMessage,
  AgentRun,
  CreateAgentSessionInput,
  GroundedQueryResult,
  UpdateAgentSessionInput
} from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";

const MAX_CONTEXT_BINDINGS = 8;
const MAX_AGENT_CONVERSATION_MESSAGES = 12;

type WikiPageResolver = (input: {
  spaceId: string;
  pageId: string;
}) => Promise<{ title: string } | null>;

type AgentKnowledgeToolCallInput = Omit<
  AgentKnowledgeToolCall,
  "id" | "agentRunId" | "completedAt"
>;

function validateKnowledgeToolCall(input: AgentKnowledgeToolCallInput): void {
  if (input.name !== "knowledge.search" && input.name !== "knowledge.read")
    throw new Error("AGENT_TOOL_CALL_INVALID");
  if (
    input.bindingIds.length === 0 ||
    input.bindingIds.length > MAX_CONTEXT_BINDINGS ||
    new Set(input.bindingIds).size !== input.bindingIds.length
  )
    throw new Error("AGENT_TOOL_CALL_INVALID");
  if (
    input.resultCount < 0 ||
    input.searchedPages < 0 ||
    input.durationMs < 0 ||
    input.inputSummary.length > 500 ||
    input.outputSummary.length > 500
  )
    throw new Error("AGENT_TOOL_CALL_INVALID");
}

function validateKnowledgeToolCalls(inputs: AgentKnowledgeToolCallInput[]): void {
  if (inputs.length === 0 || inputs.length > 2) throw new Error("AGENT_TOOL_CALL_INVALID");
  if (inputs[0]?.name !== "knowledge.search") throw new Error("AGENT_TOOL_CALL_INVALID");
  if (inputs.slice(1).some(({ name }) => name !== "knowledge.read"))
    throw new Error("AGENT_TOOL_CALL_INVALID");
  if (new Set(inputs.map(({ name }) => name)).size !== inputs.length)
    throw new Error("AGENT_TOOL_CALL_INVALID");
  for (const input of inputs) validateKnowledgeToolCall(input);
}

function presentAgentRunEvent(input: typeof schema.agentRunEvents.$inferSelect): AgentRunEvent {
  return {
    id: input.id,
    agentRunId: input.agentRunId,
    sequence: input.sequence,
    type: input.type,
    tool: input.tool,
    inputSummary: input.inputSummary,
    outputSummary: input.outputSummary,
    status: input.status,
    createdAt: input.createdAt.toISOString()
  };
}

export type ResolvedAgentSessionContext = {
  session: typeof schema.agentSessions.$inferSelect;
  bindings: Array<{
    id: string;
    spaceId: string;
    scope: AgentContextScope;
    targetId: string | null;
    label: string;
    virtualPath: string;
    dataPolicy: typeof schema.knowledgeSpaces.$inferSelect.dataPolicy;
    courseResourceVersionIds?: string[];
  }>;
  revokedBindingIds: string[];
};

function virtualPathForSpace(spaceId: string): string {
  return `/knowledge/${spaceId}`;
}

function virtualPathForContext(input: {
  spaceId: string;
  scope: AgentContextScope;
  targetId: string | null;
}): string {
  if (input.scope === "space") return virtualPathForSpace(input.spaceId);
  if (!input.targetId) throw new Error("AGENT_CONTEXT_TARGET_REQUIRED");
  if (input.scope === "wiki_page")
    return `/knowledge/${input.spaceId}/wiki/pages/${input.targetId}`;
  if (input.scope === "resource_version")
    return `/knowledge/${input.spaceId}/resources/${input.targetId}`;
  return `/knowledge/${input.spaceId}/courses/${input.targetId}`;
}

async function ownedSession(sessionId: string, userId: string) {
  const [session] = await getDatabase()
    .select()
    .from(schema.agentSessions)
    .where(and(eq(schema.agentSessions.id, sessionId), eq(schema.agentSessions.userId, userId)))
    .limit(1);
  if (!session) throw new Error("AGENT_SESSION_NOT_FOUND");
  return session;
}

export async function assertAgentSessionBindingsReadable(
  sessionId: string,
  userId: string
): Promise<void> {
  const db = getDatabase();
  const bindings = await db
    .select({
      spaceId: schema.agentContextBindings.spaceId,
      status: schema.agentContextBindings.status
    })
    .from(schema.agentContextBindings)
    .where(eq(schema.agentContextBindings.sessionId, sessionId));
  if (bindings.some(({ status }) => status !== "active"))
    throw new Error("AGENT_SESSION_ACCESS_REVOKED");
  const spaceIds = [...new Set(bindings.map(({ spaceId }) => spaceId))];
  if (!spaceIds.length) return;
  const memberships = await db
    .select({ spaceId: schema.spaceMemberships.spaceId })
    .from(schema.spaceMemberships)
    .innerJoin(
      schema.knowledgeSpaces,
      eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
    )
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.knowledgeSpaces.organizationId),
        eq(schema.organizationMemberships.userId, userId)
      )
    )
    .where(
      and(
        eq(schema.spaceMemberships.userId, userId),
        inArray(schema.spaceMemberships.spaceId, spaceIds),
        eq(schema.organizationMemberships.disabled, false)
      )
    );
  if (memberships.length !== spaceIds.length) throw new Error("AGENT_SESSION_ACCESS_REVOKED");
}

type LegacyCreateAgentSessionInput = {
  title: string;
  spaceIds: string[];
};

function initialBindingsFor(
  input: CreateAgentSessionInput | LegacyCreateAgentSessionInput
): CreateAgentContextBindingInput[] {
  if ("bindings" in input) return input.bindings;
  return input.spaceIds.map((spaceId) => ({ spaceId, scope: "space" }));
}

export async function createAgentSession(
  input: (CreateAgentSessionInput | LegacyCreateAgentSessionInput) & {
    userId: string;
    resolveWikiPage?: WikiPageResolver;
  }
) {
  const db = getDatabase();
  const bindings = initialBindingsFor(input);
  if (!bindings.length || bindings.length > MAX_CONTEXT_BINDINGS)
    throw new Error("AGENT_CONTEXT_LIMIT_EXCEEDED");
  const bindingKeys = bindings.map(
    (binding) =>
      `${binding.spaceId}:${binding.scope}:${binding.scope === "space" ? "" : binding.targetId}`
  );
  if (new Set(bindingKeys).size !== bindingKeys.length)
    throw new Error("AGENT_CONTEXT_ALREADY_BOUND");
  const spaceIds = [...new Set(bindings.map(({ spaceId }) => spaceId))];
  const memberships = await db
    .select({
      spaceId: schema.knowledgeSpaces.id,
      spaceName: schema.knowledgeSpaces.name,
      organizationId: schema.knowledgeSpaces.organizationId
    })
    .from(schema.spaceMemberships)
    .innerJoin(
      schema.knowledgeSpaces,
      eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
    )
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
        inArray(schema.spaceMemberships.spaceId, spaceIds),
        eq(schema.organizationMemberships.disabled, false)
      )
    );
  if (memberships.length !== spaceIds.length) throw new Error("AGENT_CONTEXT_SPACE_DENIED");
  const organizationId = memberships[0]?.organizationId;
  if (
    !organizationId ||
    memberships.some((membership) => membership.organizationId !== organizationId)
  ) {
    throw new Error("AGENT_CONTEXT_ORGANIZATION_MISMATCH");
  }
  const bySpaceId = new Map(memberships.map((membership) => [membership.spaceId, membership]));
  const preparedBindings: Array<{
    spaceId: string;
    scope: AgentContextScope;
    targetId: string | null;
    label: string;
    virtualPath: string;
  }> = [];
  for (const binding of bindings) {
    const space = bySpaceId.get(binding.spaceId);
    if (!space) throw new Error("AGENT_CONTEXT_SPACE_DENIED");
    let label = space.spaceName;
    const targetId = binding.scope === "space" ? null : binding.targetId;
    if (binding.scope === "wiki_page") {
      const page = await input.resolveWikiPage?.({
        spaceId: binding.spaceId,
        pageId: binding.targetId
      });
      if (!page) throw new Error("AGENT_CONTEXT_TARGET_NOT_FOUND");
      label = page.title;
    }
    if (binding.scope === "resource_version") {
      const [version] = await db
        .select({
          id: schema.resourceVersions.id,
          version: schema.resourceVersions.version,
          name: schema.resources.name
        })
        .from(schema.resourceVersions)
        .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
        .where(
          and(
            eq(schema.resourceVersions.id, binding.targetId),
            eq(schema.resources.spaceId, binding.spaceId),
            eq(schema.resources.status, "ready")
          )
        )
        .limit(1);
      if (!version) throw new Error("AGENT_CONTEXT_TARGET_NOT_FOUND");
      label = `${version.name} · v${version.version}`;
    }
    if (binding.scope === "course") {
      const [course] = await db
        .select({ id: schema.courses.id, title: schema.courses.title })
        .from(schema.courses)
        .innerJoin(schema.learningPlans, eq(schema.courses.learningPlanId, schema.learningPlans.id))
        .innerJoin(
          schema.learnerProfiles,
          eq(schema.learningPlans.learnerProfileId, schema.learnerProfiles.id)
        )
        .innerJoin(schema.courseModules, eq(schema.courseModules.courseId, schema.courses.id))
        .innerJoin(
          schema.courseUnits,
          eq(schema.courseUnits.courseModuleId, schema.courseModules.id)
        )
        .innerJoin(
          schema.resourceVersions,
          eq(schema.courseUnits.resourceVersionId, schema.resourceVersions.id)
        )
        .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
        .where(
          and(
            eq(schema.courses.id, binding.targetId),
            eq(schema.courses.status, "active"),
            eq(schema.learningPlans.status, "active"),
            eq(schema.learnerProfiles.userId, input.userId),
            eq(schema.resources.spaceId, binding.spaceId)
          )
        )
        .limit(1);
      if (!course) throw new Error("AGENT_CONTEXT_TARGET_NOT_FOUND");
      label = course.title;
    }
    preparedBindings.push({
      spaceId: binding.spaceId,
      scope: binding.scope,
      targetId,
      label,
      virtualPath: virtualPathForContext({
        spaceId: binding.spaceId,
        scope: binding.scope,
        targetId
      })
    });
  }
  const [session] = await db.transaction(async (tx) => {
    const created = await tx
      .insert(schema.agentSessions)
      .values({ organizationId, userId: input.userId, title: input.title })
      .returning();
    const value = created[0];
    if (!value) throw new Error("AGENT_SESSION_CREATE_FAILED");
    await tx.insert(schema.agentContextBindings).values(
      preparedBindings.map((binding) => {
        return {
          sessionId: value.id,
          spaceId: binding.spaceId,
          scope: binding.scope,
          targetId: binding.targetId,
          label: binding.label,
          virtualPath: binding.virtualPath,
          createdBy: input.userId
        };
      })
    );
    await tx.insert(schema.auditEvents).values({
      organizationId,
      actorUserId: input.userId,
      action: "agent_session.created",
      targetType: "agent_session",
      targetId: value.id,
      metadata: { contextCount: preparedBindings.length }
    });
    return created;
  });
  if (!session) throw new Error("AGENT_SESSION_CREATE_FAILED");
  return session;
}

export async function listAgentSessions(userId: string) {
  const db = getDatabase();
  const sessions = await db
    .select()
    .from(schema.agentSessions)
    .where(eq(schema.agentSessions.userId, userId))
    .orderBy(desc(schema.agentSessions.updatedAt));
  if (!sessions.length) return [];
  const sessionIds = sessions.map(({ id }) => id);
  const [bindings, messages] = await Promise.all([
    db
      .select({ sessionId: schema.agentContextBindings.sessionId })
      .from(schema.agentContextBindings)
      .where(eq(schema.agentContextBindings.status, "active")),
    db
      .select({
        sessionId: schema.agentMessages.sessionId,
        createdAt: schema.agentMessages.createdAt
      })
      .from(schema.agentMessages)
      .where(inArray(schema.agentMessages.sessionId, sessionIds))
  ]);
  const bindingCount = new Map<string, number>();
  for (const binding of bindings) {
    if (!sessionIds.includes(binding.sessionId)) continue;
    bindingCount.set(binding.sessionId, (bindingCount.get(binding.sessionId) ?? 0) + 1);
  }
  const lastMessageAt = new Map<string, Date>();
  for (const message of messages) {
    const current = lastMessageAt.get(message.sessionId);
    if (!current || message.createdAt > current)
      lastMessageAt.set(message.sessionId, message.createdAt);
  }
  return sessions.map((session) => ({
    ...session,
    bindingCount: bindingCount.get(session.id) ?? 0,
    lastMessageAt: lastMessageAt.get(session.id) ?? null
  }));
}

export async function updateAgentSession(
  sessionId: string,
  userId: string,
  input: UpdateAgentSessionInput
) {
  await ownedSession(sessionId, userId);
  const [session] = await getDatabase()
    .update(schema.agentSessions)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(schema.agentSessions.id, sessionId), eq(schema.agentSessions.userId, userId)))
    .returning();
  if (!session) throw new Error("AGENT_SESSION_NOT_FOUND");
  return session;
}

export async function addAgentSessionSpaceBinding(input: {
  sessionId: string;
  userId: string;
  spaceId: string;
}) {
  return addAgentSessionContextBinding({ ...input, scope: "space" });
}

export async function addAgentSessionContextBinding(input: {
  sessionId: string;
  userId: string;
  spaceId: string;
  scope: AgentContextScope;
  targetId?: string;
  resolveWikiPage?: WikiPageResolver;
}) {
  const session = await ownedSession(input.sessionId, input.userId);
  if (session.status !== "active") throw new Error("AGENT_SESSION_ARCHIVED");
  const [space] = await getDatabase()
    .select({
      id: schema.knowledgeSpaces.id,
      name: schema.knowledgeSpaces.name,
      organizationId: schema.knowledgeSpaces.organizationId
    })
    .from(schema.spaceMemberships)
    .innerJoin(
      schema.knowledgeSpaces,
      eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
    )
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
        eq(schema.spaceMemberships.spaceId, input.spaceId),
        eq(schema.organizationMemberships.disabled, false)
      )
    )
    .limit(1);
  if (!space) throw new Error("AGENT_CONTEXT_SPACE_DENIED");
  if (space.organizationId !== session.organizationId)
    throw new Error("AGENT_CONTEXT_ORGANIZATION_MISMATCH");
  const targetId: string | null = input.scope === "space" ? null : (input.targetId ?? null);
  if (input.scope !== "space" && !targetId) throw new Error("AGENT_CONTEXT_TARGET_REQUIRED");
  let label = space.name;
  if (input.scope === "wiki_page") {
    if (!input.resolveWikiPage) throw new Error("AGENT_CONTEXT_TARGET_UNAVAILABLE");
    const page = await input.resolveWikiPage({ spaceId: input.spaceId, pageId: targetId! });
    if (!page) throw new Error("AGENT_CONTEXT_TARGET_NOT_FOUND");
    label = page.title;
  }
  if (input.scope === "resource_version") {
    const [version] = await getDatabase()
      .select({
        id: schema.resourceVersions.id,
        version: schema.resourceVersions.version,
        name: schema.resources.name
      })
      .from(schema.resourceVersions)
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .where(
        and(
          eq(schema.resourceVersions.id, targetId!),
          eq(schema.resources.spaceId, input.spaceId),
          eq(schema.resources.status, "ready")
        )
      )
      .limit(1);
    if (!version) throw new Error("AGENT_CONTEXT_TARGET_NOT_FOUND");
    label = `${version.name} · v${version.version}`;
  }
  if (input.scope === "course") {
    const courseRows = await getDatabase()
      .select({
        courseId: schema.courses.id,
        title: schema.courses.title,
        resourceVersionId: schema.courseUnits.resourceVersionId
      })
      .from(schema.courses)
      .innerJoin(schema.learningPlans, eq(schema.courses.learningPlanId, schema.learningPlans.id))
      .innerJoin(
        schema.learnerProfiles,
        eq(schema.learningPlans.learnerProfileId, schema.learnerProfiles.id)
      )
      .innerJoin(schema.courseModules, eq(schema.courseModules.courseId, schema.courses.id))
      .innerJoin(schema.courseUnits, eq(schema.courseUnits.courseModuleId, schema.courseModules.id))
      .innerJoin(
        schema.resourceVersions,
        eq(schema.courseUnits.resourceVersionId, schema.resourceVersions.id)
      )
      .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
      .where(
        and(
          eq(schema.courses.id, targetId!),
          eq(schema.courses.status, "active"),
          eq(schema.learningPlans.status, "active"),
          eq(schema.learnerProfiles.userId, input.userId),
          eq(schema.resources.spaceId, input.spaceId)
        )
      )
      .limit(1);
    const course = courseRows[0];
    if (!course) throw new Error("AGENT_CONTEXT_TARGET_NOT_FOUND");
    label = course.title;
  }
  const existing = await getDatabase()
    .select({ id: schema.agentContextBindings.id })
    .from(schema.agentContextBindings)
    .where(
      and(
        eq(schema.agentContextBindings.sessionId, input.sessionId),
        eq(schema.agentContextBindings.spaceId, input.spaceId),
        eq(schema.agentContextBindings.scope, input.scope),
        targetId === null
          ? isNull(schema.agentContextBindings.targetId)
          : eq(schema.agentContextBindings.targetId, targetId)
      )
    )
    .limit(1);
  if (existing[0]) throw new Error("AGENT_CONTEXT_ALREADY_BOUND");
  const activeBindings = await getDatabase()
    .select({ id: schema.agentContextBindings.id })
    .from(schema.agentContextBindings)
    .where(
      and(
        eq(schema.agentContextBindings.sessionId, input.sessionId),
        eq(schema.agentContextBindings.status, "active")
      )
    );
  if (activeBindings.length >= MAX_CONTEXT_BINDINGS)
    throw new Error("AGENT_CONTEXT_LIMIT_EXCEEDED");
  const [binding] = await getDatabase()
    .insert(schema.agentContextBindings)
    .values({
      sessionId: input.sessionId,
      spaceId: input.spaceId,
      scope: input.scope,
      targetId,
      label,
      virtualPath: virtualPathForContext({ spaceId: input.spaceId, scope: input.scope, targetId }),
      createdBy: input.userId
    })
    .returning();
  if (!binding) throw new Error("AGENT_CONTEXT_CREATE_FAILED");
  return binding;
}

export async function removeAgentSessionSpaceBinding(input: {
  sessionId: string;
  userId: string;
  bindingId: string;
}) {
  await ownedSession(input.sessionId, input.userId);
  const [binding] = await getDatabase()
    .update(schema.agentContextBindings)
    .set({ status: "removed", updatedAt: new Date() })
    .where(
      and(
        eq(schema.agentContextBindings.id, input.bindingId),
        eq(schema.agentContextBindings.sessionId, input.sessionId),
        eq(schema.agentContextBindings.status, "active")
      )
    )
    .returning();
  if (!binding) throw new Error("AGENT_CONTEXT_BINDING_NOT_FOUND");
  return binding;
}

export async function resolveAgentSessionContext(
  sessionId: string,
  userId: string,
  options: { resolveWikiPage?: WikiPageResolver } = {}
): Promise<ResolvedAgentSessionContext> {
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(schema.agentSessions)
      .where(and(eq(schema.agentSessions.id, sessionId), eq(schema.agentSessions.userId, userId)))
      .for("update")
      .limit(1);
    if (!session) throw new Error("AGENT_SESSION_NOT_FOUND");
    if (session.status !== "active") throw new Error("AGENT_SESSION_ARCHIVED");
    const bindings = await tx
      .select({ binding: schema.agentContextBindings, space: schema.knowledgeSpaces })
      .from(schema.agentContextBindings)
      .innerJoin(
        schema.knowledgeSpaces,
        eq(schema.agentContextBindings.spaceId, schema.knowledgeSpaces.id)
      )
      .where(
        and(
          eq(schema.agentContextBindings.sessionId, sessionId),
          eq(schema.agentContextBindings.status, "active")
        )
      );
    if (!bindings.length) return { session, bindings: [], revokedBindingIds: [] };
    const membershipRows = await tx
      .select({ spaceId: schema.spaceMemberships.spaceId })
      .from(schema.spaceMemberships)
      .innerJoin(
        schema.knowledgeSpaces,
        eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
      )
      .innerJoin(
        schema.organizationMemberships,
        and(
          eq(schema.organizationMemberships.organizationId, schema.knowledgeSpaces.organizationId),
          eq(schema.organizationMemberships.userId, userId)
        )
      )
      .where(
        and(
          eq(schema.spaceMemberships.userId, userId),
          inArray(
            schema.spaceMemberships.spaceId,
            bindings.map(({ binding }) => binding.spaceId)
          ),
          eq(schema.organizationMemberships.disabled, false)
        )
      );
    const allowedSpaceIds = new Set(membershipRows.map(({ spaceId }) => spaceId));
    const resourceVersionBindings = bindings.filter(
      ({ binding }) =>
        allowedSpaceIds.has(binding.spaceId) &&
        binding.scope === "resource_version" &&
        binding.targetId !== null
    );
    const availableResourceVersionIds = resourceVersionBindings.length
      ? new Set(
          (
            await tx
              .select({ id: schema.resourceVersions.id })
              .from(schema.resourceVersions)
              .innerJoin(
                schema.resources,
                eq(schema.resourceVersions.resourceId, schema.resources.id)
              )
              .where(
                and(
                  inArray(
                    schema.resourceVersions.id,
                    resourceVersionBindings.map(({ binding }) => binding.targetId!)
                  )
                )
              )
          ).map(({ id }) => id)
        )
      : new Set<string>();
    const invalidResourceBindingIds = resourceVersionBindings
      .filter(({ binding }) => !availableResourceVersionIds.has(binding.targetId!))
      .map(({ binding }) => binding.id);
    const courseBindings = bindings.filter(
      ({ binding }) =>
        allowedSpaceIds.has(binding.spaceId) &&
        binding.scope === "course" &&
        binding.targetId !== null
    );
    const courseVersionIdsByBinding = new Map<string, string[]>();
    if (courseBindings.length) {
      const courseRows = await tx
        .select({
          courseId: schema.courses.id,
          spaceId: schema.resources.spaceId,
          resourceVersionId: schema.courseUnits.resourceVersionId
        })
        .from(schema.courses)
        .innerJoin(schema.learningPlans, eq(schema.courses.learningPlanId, schema.learningPlans.id))
        .innerJoin(
          schema.learnerProfiles,
          eq(schema.learningPlans.learnerProfileId, schema.learnerProfiles.id)
        )
        .innerJoin(schema.courseModules, eq(schema.courseModules.courseId, schema.courses.id))
        .innerJoin(
          schema.courseUnits,
          eq(schema.courseUnits.courseModuleId, schema.courseModules.id)
        )
        .innerJoin(
          schema.resourceVersions,
          eq(schema.courseUnits.resourceVersionId, schema.resourceVersions.id)
        )
        .innerJoin(schema.resources, eq(schema.resourceVersions.resourceId, schema.resources.id))
        .where(
          and(
            inArray(
              schema.courses.id,
              courseBindings.map(({ binding }) => binding.targetId!)
            ),
            eq(schema.courses.status, "active"),
            eq(schema.learningPlans.status, "active"),
            eq(schema.learnerProfiles.userId, userId)
          )
        );
      for (const row of courseRows) {
        const key = `${row.courseId}:${row.spaceId}`;
        courseVersionIdsByBinding.set(key, [
          ...new Set([...(courseVersionIdsByBinding.get(key) ?? []), row.resourceVersionId])
        ]);
      }
    }
    const invalidCourseBindingIds = courseBindings
      .filter(
        ({ binding }) => !courseVersionIdsByBinding.has(`${binding.targetId}:${binding.spaceId}`)
      )
      .map(({ binding }) => binding.id);
    const resolveWikiPage = options.resolveWikiPage;
    const invalidPageBindingIds = resolveWikiPage
      ? (
          await Promise.all(
            bindings
              .filter(
                ({ binding }) =>
                  allowedSpaceIds.has(binding.spaceId) && binding.scope === "wiki_page"
              )
              .map(async ({ binding }) => {
                if (!binding.targetId) return binding.id;
                const page = await resolveWikiPage({
                  spaceId: binding.spaceId,
                  pageId: binding.targetId
                });
                return page ? null : binding.id;
              })
          )
        ).filter((bindingId): bindingId is string => bindingId !== null)
      : [];
    const revokedBindingIds = bindings
      .filter(({ binding }) => !allowedSpaceIds.has(binding.spaceId))
      .map(({ binding }) => binding.id);
    const unavailableBindingIds = [
      ...new Set([
        ...revokedBindingIds,
        ...invalidPageBindingIds,
        ...invalidResourceBindingIds,
        ...invalidCourseBindingIds
      ])
    ];
    if (unavailableBindingIds.length)
      await tx
        .update(schema.agentContextBindings)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(inArray(schema.agentContextBindings.id, unavailableBindingIds));
    return {
      session,
      bindings: bindings
        .filter(
          ({ binding }) =>
            allowedSpaceIds.has(binding.spaceId) && !unavailableBindingIds.includes(binding.id)
        )
        .map(({ binding, space }) => {
          const courseResourceVersionIds =
            binding.scope === "course" && binding.targetId
              ? courseVersionIdsByBinding.get(`${binding.targetId}:${binding.spaceId}`)
              : undefined;
          return {
            id: binding.id,
            spaceId: binding.spaceId,
            scope: binding.scope,
            targetId: binding.targetId,
            label: binding.label,
            virtualPath: binding.virtualPath,
            dataPolicy: space.dataPolicy,
            ...(courseResourceVersionIds ? { courseResourceVersionIds } : {})
          };
        }),
      revokedBindingIds: unavailableBindingIds
    };
  });
}

export async function getAgentSessionDetail(sessionId: string, userId: string) {
  const session = await ownedSession(sessionId, userId);
  await assertAgentSessionBindingsReadable(sessionId, userId);
  const db = getDatabase();
  const [bindings, messages, runs] = await Promise.all([
    db
      .select()
      .from(schema.agentContextBindings)
      .where(eq(schema.agentContextBindings.sessionId, sessionId))
      .orderBy(asc(schema.agentContextBindings.createdAt)),
    db
      .select()
      .from(schema.agentMessages)
      .where(eq(schema.agentMessages.sessionId, sessionId))
      .orderBy(asc(schema.agentMessages.createdAt)),
    db
      .select()
      .from(schema.agentRuns)
      .where(eq(schema.agentRuns.sessionId, sessionId))
      .orderBy(asc(schema.agentRuns.createdAt))
  ]);
  const runIds = runs.map(({ id }) => id);
  const snapshots = runIds.length
    ? await db
        .select()
        .from(schema.agentEvidenceSnapshots)
        .where(inArray(schema.agentEvidenceSnapshots.agentRunId, runIds))
        .orderBy(asc(schema.agentEvidenceSnapshots.rank))
    : [];
  const toolCalls = runIds.length
    ? await db
        .select()
        .from(schema.agentToolCalls)
        .where(inArray(schema.agentToolCalls.agentRunId, runIds))
        .orderBy(asc(schema.agentToolCalls.completedAt))
    : [];
  const events = runIds.length
    ? await db
        .select()
        .from(schema.agentRunEvents)
        .where(inArray(schema.agentRunEvents.agentRunId, runIds))
        .orderBy(asc(schema.agentRunEvents.sequence))
    : [];
  return { session, bindings, messages, runs, snapshots, toolCalls, events };
}

export async function getAgentRunEvents(input: {
  runId: string;
  userId: string;
  afterSequence: number;
}) {
  if (!Number.isInteger(input.afterSequence) || input.afterSequence < 0)
    throw new Error("AGENT_RUN_EVENT_CURSOR_INVALID");
  const db = getDatabase();
  const [run] = await db
    .select({ sessionId: schema.agentRuns.sessionId })
    .from(schema.agentRuns)
    .innerJoin(schema.agentSessions, eq(schema.agentRuns.sessionId, schema.agentSessions.id))
    .where(and(eq(schema.agentRuns.id, input.runId), eq(schema.agentSessions.userId, input.userId)))
    .limit(1);
  if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
  await assertAgentSessionBindingsReadable(run.sessionId, input.userId);
  const rows = await db
    .select({ event: schema.agentRunEvents })
    .from(schema.agentRunEvents)
    .where(
      and(
        eq(schema.agentRunEvents.agentRunId, input.runId),
        gt(schema.agentRunEvents.sequence, input.afterSequence)
      )
    )
    .orderBy(asc(schema.agentRunEvents.sequence));
  return rows.map(({ event }) => presentAgentRunEvent(event));
}

function snapshotSpaceId(evidenceId: string): string | null {
  const separator = evidenceId.indexOf("__");
  return separator > 0 ? evidenceId.slice(0, separator) : null;
}

export async function persistAgentSessionTurn(input: {
  sessionId: string;
  userId: string;
  question: string;
  result: GroundedQueryResult;
  durationMs: number;
  runId?: string;
}): Promise<{ run: AgentRun; assistantMessageId: string }> {
  const runId = input.runId ?? randomUUID();
  const cited = new Set(input.result.answer.evidenceIds);
  return getDatabase().transaction(async (tx) => {
    const [session] = await tx
      .select({ id: schema.agentSessions.id, status: schema.agentSessions.status })
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.id, input.sessionId),
          eq(schema.agentSessions.userId, input.userId)
        )
      )
      .for("update")
      .limit(1);
    if (!session) throw new Error("AGENT_SESSION_NOT_FOUND");
    if (session.status !== "active") throw new Error("AGENT_SESSION_ARCHIVED");
    const [userMessage] = await tx
      .insert(schema.agentMessages)
      .values({ sessionId: input.sessionId, role: "user", content: input.question })
      .returning();
    const [assistantMessage] = await tx
      .insert(schema.agentMessages)
      .values({
        sessionId: input.sessionId,
        role: "assistant",
        content: input.result.answer.answer
      })
      .returning();
    if (!userMessage || !assistantMessage) throw new Error("AGENT_MESSAGE_CREATE_FAILED");
    const [run] = await tx
      .insert(schema.agentRuns)
      .values({
        id: runId,
        sessionId: input.sessionId,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id,
        status: "completed",
        answerMode: input.result.answer.mode,
        insufficientEvidence: input.result.answer.insufficientEvidence,
        searchedPages: input.result.evidence.searchedPages,
        embeddingCalls: input.result.evidence.embeddingCalls,
        durationMs: input.durationMs,
        completedAt: new Date()
      })
      .returning();
    if (!run) throw new Error("AGENT_RUN_CREATE_FAILED");
    await tx.insert(schema.agentRunEvents).values({
      agentRunId: run.id,
      sequence: 1,
      type: "run.started",
      status: "running"
    });
    await tx.insert(schema.agentRunEvents).values({
      agentRunId: run.id,
      sequence: 2,
      type: "run.completed",
      status: "completed"
    });
    const evidence = input.result.evidence.items.map((item, index) => {
      const spaceId = snapshotSpaceId(item.id);
      if (!spaceId) throw new Error("AGENT_EVIDENCE_SPACE_UNKNOWN");
      return {
        agentRunId: run.id,
        evidenceId: item.id,
        spaceId,
        pageId: item.pageId,
        pageTitle: item.pageTitle,
        pageType: item.pageType,
        rank: index + 1,
        sourceCount: item.sourceRefs.length,
        sourceRefs: item.sourceRefs,
        cited: cited.has(item.id)
      };
    });
    const snapshots = evidence.length
      ? await tx.insert(schema.agentEvidenceSnapshots).values(evidence).returning()
      : [];
    await tx
      .update(schema.agentSessions)
      .set({ updatedAt: new Date() })
      .where(eq(schema.agentSessions.id, input.sessionId));
    return {
      run: {
        id: run.id,
        userMessageId: run.userMessageId,
        assistantMessageId: run.assistantMessageId,
        status: run.status,
        answerMode: run.answerMode,
        insufficientEvidence: run.insufficientEvidence,
        searchedPages: run.searchedPages,
        embeddingCalls: 0,
        durationMs: run.durationMs,
        errorCode: run.errorCode,
        createdAt: run.createdAt.toISOString(),
        completedAt: run.completedAt?.toISOString() ?? null,
        evidence: snapshots.map((snapshot) => ({
          id: snapshot.id,
          evidenceId: snapshot.evidenceId,
          spaceId: snapshot.spaceId,
          pageId: snapshot.pageId,
          pageTitle: snapshot.pageTitle,
          pageType: snapshot.pageType as "concept" | "topic" | "case" | "course" | "material",
          rank: snapshot.rank,
          sourceCount: snapshot.sourceCount,
          sourceRefs: snapshot.sourceRefs,
          cited: snapshot.cited
        }))
      },
      assistantMessageId: assistantMessage.id
    };
  });
}

function presentRun(input: {
  id: string;
  userMessageId: string;
  assistantMessageId: string | null;
  status: "running" | "completed" | "failed" | "stopped";
  answerMode: "generated" | "extractive_fallback" | null;
  insufficientEvidence: boolean | null;
  searchedPages: number;
  embeddingCalls: number;
  durationMs: number;
  errorCode: string | null;
  createdAt: Date;
  completedAt: Date | null;
  evidence?: AgentRun["evidence"];
}): AgentRun {
  return {
    id: input.id,
    userMessageId: input.userMessageId,
    assistantMessageId: input.assistantMessageId,
    status: input.status,
    answerMode: input.answerMode,
    insufficientEvidence: input.insufficientEvidence,
    searchedPages: input.searchedPages,
    embeddingCalls: 0,
    durationMs: input.durationMs,
    errorCode: input.errorCode,
    createdAt: input.createdAt.toISOString(),
    completedAt: input.completedAt?.toISOString() ?? null,
    evidence: input.evidence ?? []
  };
}

function presentMessage(input: {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}): AgentMessage {
  return { ...input, createdAt: input.createdAt.toISOString() };
}

export async function beginAgentSessionRun(input: {
  sessionId: string;
  userId: string;
  question: string;
  runId?: string;
}): Promise<{ run: AgentRun; userMessage: AgentMessage; conversation: AgentMessage[] }> {
  const runId = input.runId ?? randomUUID();
  return getDatabase().transaction(async (tx) => {
    const [session] = await tx
      .select({ id: schema.agentSessions.id, status: schema.agentSessions.status })
      .from(schema.agentSessions)
      .where(
        and(
          eq(schema.agentSessions.id, input.sessionId),
          eq(schema.agentSessions.userId, input.userId)
        )
      )
      .for("update")
      .limit(1);
    if (!session) throw new Error("AGENT_SESSION_NOT_FOUND");
    if (session.status !== "active") throw new Error("AGENT_SESSION_ARCHIVED");
    const [activeRun] = await tx
      .select({ id: schema.agentRuns.id })
      .from(schema.agentRuns)
      .where(
        and(eq(schema.agentRuns.sessionId, input.sessionId), eq(schema.agentRuns.status, "running"))
      )
      .limit(1);
    if (activeRun) throw new Error("AGENT_RUN_ACTIVE");
    const conversation = await tx
      .select({
        id: schema.agentMessages.id,
        role: schema.agentMessages.role,
        content: schema.agentMessages.content,
        createdAt: schema.agentMessages.createdAt
      })
      .from(schema.agentMessages)
      .leftJoin(
        schema.agentRuns,
        or(
          eq(schema.agentMessages.id, schema.agentRuns.userMessageId),
          eq(schema.agentMessages.id, schema.agentRuns.assistantMessageId)
        )
      )
      .where(
        and(
          eq(schema.agentMessages.sessionId, input.sessionId),
          or(eq(schema.agentMessages.role, "user"), eq(schema.agentRuns.status, "completed"))
        )
      )
      .orderBy(desc(schema.agentRuns.createdAt), desc(schema.agentMessages.role))
      .limit(MAX_AGENT_CONVERSATION_MESSAGES);
    const [userMessage] = await tx
      .insert(schema.agentMessages)
      .values({ sessionId: input.sessionId, role: "user", content: input.question })
      .returning();
    if (!userMessage) throw new Error("AGENT_MESSAGE_CREATE_FAILED");
    const [run] = await tx
      .insert(schema.agentRuns)
      .values({
        id: runId,
        sessionId: input.sessionId,
        userMessageId: userMessage.id,
        status: "running"
      })
      .returning();
    if (!run) throw new Error("AGENT_RUN_CREATE_FAILED");
    await tx.insert(schema.agentRunEvents).values({
      agentRunId: run.id,
      sequence: 1,
      type: "run.started",
      status: "running"
    });
    await tx
      .update(schema.agentSessions)
      .set({ updatedAt: new Date() })
      .where(eq(schema.agentSessions.id, input.sessionId));
    return {
      run: presentRun(run),
      userMessage: presentMessage(userMessage),
      conversation: conversation.reverse().map(presentMessage)
    };
  });
}

export async function completeAgentSessionRun(input: {
  runId: string;
  sessionId: string;
  userId: string;
  result: GroundedQueryResult;
  durationMs: number;
  toolCalls: AgentKnowledgeToolCallInput[];
}): Promise<{ run: AgentRun; assistantMessageId: string }> {
  validateKnowledgeToolCalls(input.toolCalls);
  const cited = new Set(input.result.answer.evidenceIds);
  return getDatabase().transaction(async (tx) => {
    const [current] = await tx
      .select({ run: schema.agentRuns })
      .from(schema.agentRuns)
      .innerJoin(schema.agentSessions, eq(schema.agentRuns.sessionId, schema.agentSessions.id))
      .where(
        and(
          eq(schema.agentRuns.id, input.runId),
          eq(schema.agentRuns.sessionId, input.sessionId),
          eq(schema.agentSessions.userId, input.userId)
        )
      )
      .for("update")
      .limit(1);
    if (!current) throw new Error("AGENT_RUN_NOT_FOUND");
    if (current.run.status !== "running") throw new Error("AGENT_RUN_NOT_RUNNING");
    const activeBindings = await tx
      .select({
        id: schema.agentContextBindings.id,
        spaceId: schema.agentContextBindings.spaceId,
        status: schema.agentContextBindings.status
      })
      .from(schema.agentContextBindings)
      .where(eq(schema.agentContextBindings.sessionId, input.sessionId));
    if (activeBindings.some(({ status }) => status !== "active"))
      throw new Error("AGENT_SESSION_ACCESS_REVOKED");
    const bindingSpaceIds = [...new Set(activeBindings.map(({ spaceId }) => spaceId))];
    const readableMemberships = bindingSpaceIds.length
      ? await tx
          .select({ spaceId: schema.spaceMemberships.spaceId })
          .from(schema.spaceMemberships)
          .innerJoin(
            schema.knowledgeSpaces,
            eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
          )
          .innerJoin(
            schema.organizationMemberships,
            and(
              eq(
                schema.organizationMemberships.organizationId,
                schema.knowledgeSpaces.organizationId
              ),
              eq(schema.organizationMemberships.userId, input.userId)
            )
          )
          .where(
            and(
              eq(schema.spaceMemberships.userId, input.userId),
              inArray(schema.spaceMemberships.spaceId, bindingSpaceIds),
              eq(schema.organizationMemberships.disabled, false)
            )
          )
          .for("update")
      : [];
    if (readableMemberships.length !== bindingSpaceIds.length)
      throw new Error("AGENT_SESSION_ACCESS_REVOKED");
    const activeBindingIds = new Set(activeBindings.map(({ id }) => id));
    if (
      input.toolCalls.some((toolCall) =>
        toolCall.bindingIds.some((bindingId) => !activeBindingIds.has(bindingId))
      )
    )
      throw new Error("AGENT_TOOL_CALL_SCOPE_REVOKED");
    const search = input.toolCalls[0];
    if (
      !search ||
      search.resultCount !== input.result.evidence.items.length ||
      search.searchedPages !== input.result.evidence.searchedPages
    )
      throw new Error("AGENT_TOOL_CALL_RESULT_MISMATCH");
    const [assistantMessage] = await tx
      .insert(schema.agentMessages)
      .values({
        sessionId: input.sessionId,
        role: "assistant",
        content: input.result.answer.answer
      })
      .returning();
    if (!assistantMessage) throw new Error("AGENT_MESSAGE_CREATE_FAILED");
    const [run] = await tx
      .update(schema.agentRuns)
      .set({
        assistantMessageId: assistantMessage.id,
        status: "completed",
        answerMode: input.result.answer.mode,
        insufficientEvidence: input.result.answer.insufficientEvidence,
        searchedPages: input.result.evidence.searchedPages,
        embeddingCalls: 0,
        durationMs: input.durationMs,
        completedAt: new Date()
      })
      .where(eq(schema.agentRuns.id, current.run.id))
      .returning();
    if (!run) throw new Error("AGENT_RUN_CREATE_FAILED");
    const evidence = input.result.evidence.items.map((item, index) => {
      const spaceId = snapshotSpaceId(item.id);
      if (!spaceId) throw new Error("AGENT_EVIDENCE_SPACE_UNKNOWN");
      return {
        agentRunId: run.id,
        evidenceId: item.id,
        spaceId,
        pageId: item.pageId,
        pageTitle: item.pageTitle,
        pageType: item.pageType,
        rank: index + 1,
        sourceCount: item.sourceRefs.length,
        sourceRefs: item.sourceRefs,
        cited: cited.has(item.id)
      };
    });
    const snapshots = evidence.length
      ? await tx.insert(schema.agentEvidenceSnapshots).values(evidence).returning()
      : [];
    await tx.insert(schema.agentToolCalls).values(
      input.toolCalls.map((toolCall) => ({
        agentRunId: run.id,
        name: toolCall.name,
        bindingIds: toolCall.bindingIds,
        inputSummary: toolCall.inputSummary,
        outputSummary: toolCall.outputSummary,
        resultCount: toolCall.resultCount,
        searchedPages: toolCall.searchedPages,
        durationMs: toolCall.durationMs,
        completedAt: new Date()
      }))
    );
    await tx.insert(schema.agentRunEvents).values(
      input.toolCalls.flatMap((toolCall, index) => {
        const sequence = index * 2 + 2;
        return [
          {
            agentRunId: run.id,
            sequence,
            type: "tool.requested" as const,
            tool: toolCall.name,
            inputSummary: toolCall.inputSummary
          },
          {
            agentRunId: run.id,
            sequence: sequence + 1,
            type: "tool.completed" as const,
            tool: toolCall.name,
            outputSummary: toolCall.outputSummary
          }
        ];
      })
    );
    await tx.insert(schema.agentRunEvents).values({
      agentRunId: run.id,
      sequence: input.toolCalls.length * 2 + 2,
      type: "run.completed",
      status: "completed"
    });
    await tx
      .update(schema.agentSessions)
      .set({ updatedAt: new Date() })
      .where(eq(schema.agentSessions.id, input.sessionId));
    return {
      run: presentRun({
        ...run,
        evidence: snapshots.map((snapshot) => ({
          id: snapshot.id,
          evidenceId: snapshot.evidenceId,
          spaceId: snapshot.spaceId,
          pageId: snapshot.pageId,
          pageTitle: snapshot.pageTitle,
          pageType: snapshot.pageType as "concept" | "topic" | "case" | "course" | "material",
          rank: snapshot.rank,
          sourceCount: snapshot.sourceCount,
          sourceRefs: snapshot.sourceRefs,
          cited: snapshot.cited
        }))
      }),
      assistantMessageId: assistantMessage.id
    };
  });
}

export async function settleAgentSessionRun(input: {
  runId: string;
  sessionId: string;
  userId: string;
  status: "failed" | "stopped";
  durationMs: number;
  errorCode: string;
}): Promise<AgentRun> {
  return getDatabase().transaction(async (tx) => {
    const [current] = await tx
      .select({ run: schema.agentRuns })
      .from(schema.agentRuns)
      .innerJoin(schema.agentSessions, eq(schema.agentRuns.sessionId, schema.agentSessions.id))
      .where(
        and(
          eq(schema.agentRuns.id, input.runId),
          eq(schema.agentRuns.sessionId, input.sessionId),
          eq(schema.agentSessions.userId, input.userId)
        )
      )
      .for("update")
      .limit(1);
    if (!current) throw new Error("AGENT_RUN_NOT_FOUND");
    if (current.run.status !== "running") throw new Error("AGENT_RUN_NOT_RUNNING");
    const [run] = await tx
      .update(schema.agentRuns)
      .set({
        status: input.status,
        durationMs: input.durationMs,
        errorCode: input.errorCode,
        completedAt: new Date()
      })
      .where(eq(schema.agentRuns.id, current.run.id))
      .returning();
    if (!run) throw new Error("AGENT_RUN_CREATE_FAILED");
    const [lastEvent] = await tx
      .select({ sequence: schema.agentRunEvents.sequence })
      .from(schema.agentRunEvents)
      .where(eq(schema.agentRunEvents.agentRunId, run.id))
      .orderBy(desc(schema.agentRunEvents.sequence))
      .limit(1);
    await tx.insert(schema.agentRunEvents).values({
      agentRunId: run.id,
      sequence: (lastEvent?.sequence ?? 0) + 1,
      type: input.status === "stopped" ? "run.stopped" : "run.failed",
      status: input.status
    });
    await tx
      .update(schema.agentSessions)
      .set({ updatedAt: new Date() })
      .where(eq(schema.agentSessions.id, input.sessionId));
    return presentRun(run);
  });
}

export async function stopAgentSessionRun(input: {
  runId: string;
  userId: string;
  durationMs: number;
}): Promise<AgentRun> {
  const db = getDatabase();
  const [run] = await db
    .select({ run: schema.agentRuns, sessionId: schema.agentRuns.sessionId })
    .from(schema.agentRuns)
    .innerJoin(schema.agentSessions, eq(schema.agentRuns.sessionId, schema.agentSessions.id))
    .where(and(eq(schema.agentRuns.id, input.runId), eq(schema.agentSessions.userId, input.userId)))
    .limit(1);
  if (!run) throw new Error("AGENT_RUN_NOT_FOUND");
  if (run.run.status !== "running") return presentRun(run.run);
  return settleAgentSessionRun({
    runId: input.runId,
    sessionId: run.sessionId,
    userId: input.userId,
    status: "stopped",
    durationMs: input.durationMs,
    errorCode: "AGENT_RUN_CANCELLED"
  });
}

export function contextBindingStatus(value: string): AgentContextBindingStatus {
  if (value === "active" || value === "removed" || value === "revoked") return value;
  throw new Error("AGENT_CONTEXT_STATUS_INVALID");
}
