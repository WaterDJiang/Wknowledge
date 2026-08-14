import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  addAgentSessionContextBinding,
  addAgentSessionSpaceBinding,
  beginAgentSessionRun,
  completeAgentSessionRun,
  createQueuedSkillRun,
  createAgentSession,
  decideSkillApproval,
  getAgentRunEvents,
  getAgentSessionDetail,
  listSessionSkillApprovals,
  listSessionSkillPolicies,
  persistAgentSessionTurn,
  removeAgentSessionSpaceBinding,
  resolveAgentSessionContext,
  requestSkillApproval,
  settleAgentSessionRun,
  stopAgentSessionRun,
  updateAgentSession
} from "../src/index";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import type { ManagedSkill } from "@wknowledge/contracts";

const test = process.env.DATABASE_URL ? it : it.skip;

const alwaysApprovalSkill = {
  id: "wiki-correct",
  version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  description: "生成更正提案",
  enabled: true,
  requiredCapabilities: ["chat"],
  permissions: {
    resources: "selected",
    filesystem: "write-artifacts",
    network: "deny",
    approval: "always"
  },
  limits: { timeoutSeconds: 120, memoryMb: 256, maxModelCalls: 1 }
} satisfies ManagedSkill;

const workerApprovalSkill = { ...alwaysApprovalSkill, id: "wiki-lint" } satisfies ManagedSkill;

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const firstSpaceId = randomUUID();
  const secondSpaceId = randomUUID();
  const deniedSpaceId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "Agent 会话测试组织" });
  await db.insert(schema.users).values([
    {
      id: userId,
      email: `agent-user-${userId}@example.com`,
      name: "会话用户",
      passwordHash: "not-used"
    },
    {
      id: otherUserId,
      email: `agent-other-${otherUserId}@example.com`,
      name: "其他用户",
      passwordHash: "not-used"
    }
  ]);
  await db.insert(schema.organizationMemberships).values([
    { organizationId, userId, role: "viewer" },
    { organizationId, userId: otherUserId, role: "viewer" }
  ]);
  await db.insert(schema.knowledgeSpaces).values([
    { id: firstSpaceId, organizationId, name: "知识空间一", createdBy: userId },
    { id: secondSpaceId, organizationId, name: "知识空间二", createdBy: userId },
    { id: deniedSpaceId, organizationId, name: "无权空间", createdBy: userId }
  ]);
  await db.insert(schema.spaceMemberships).values([
    { spaceId: firstSpaceId, userId, role: "viewer" },
    { spaceId: secondSpaceId, userId, role: "viewer" }
  ]);
  return { db, organizationId, userId, otherUserId, firstSpaceId, secondSpaceId, deniedSpaceId };
}

afterAll(async () => closeDatabase());

describe("agent sessions", () => {
  test("creates owner-scoped bindings and refuses a mixed unauthorized request atomically", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "复习助手",
        spaceIds: [value.firstSpaceId, value.secondSpaceId]
      });
      const detail = await getAgentSessionDetail(session.id, value.userId);
      expect(detail.bindings.map(({ virtualPath }) => virtualPath)).toEqual([
        `/knowledge/${value.firstSpaceId}`,
        `/knowledge/${value.secondSpaceId}`
      ]);
      await expect(
        createAgentSession({
          userId: value.userId,
          title: "不应创建",
          spaceIds: [value.firstSpaceId, value.deniedSpaceId]
        })
      ).rejects.toThrow("AGENT_CONTEXT_SPACE_DENIED");
      const sessions = await value.db
        .select()
        .from(schema.agentSessions)
        .where(eq(schema.agentSessions.userId, value.userId));
      expect(sessions).toHaveLength(1);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("denies new Agent sessions and bindings after the organization membership is disabled", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "既有会话",
        spaceIds: [value.firstSpaceId]
      });
      await value.db
        .update(schema.organizationMemberships)
        .set({ disabled: true })
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, value.organizationId),
            eq(schema.organizationMemberships.userId, value.userId)
          )
        );
      await expect(
        createAgentSession({
          userId: value.userId,
          title: "不应创建",
          spaceIds: [value.firstSpaceId]
        })
      ).rejects.toThrow("AGENT_CONTEXT_SPACE_DENIED");
      await expect(
        addAgentSessionContextBinding({
          sessionId: session.id,
          userId: value.userId,
          spaceId: value.secondSpaceId,
          scope: "space"
        })
      ).rejects.toThrow("AGENT_CONTEXT_SPACE_DENIED");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("creates only an explicitly selected page binding without a hidden whole-space binding", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "指定页面助手",
        bindings: [
          {
            spaceId: value.firstSpaceId,
            scope: "wiki_page",
            targetId: "topic-selected"
          }
        ],
        resolveWikiPage: async ({ spaceId, pageId }) =>
          spaceId === value.firstSpaceId && pageId === "topic-selected"
            ? { title: "选中页面" }
            : null
      });
      const detail = await getAgentSessionDetail(session.id, value.userId);
      expect(detail.bindings).toHaveLength(1);
      expect(detail.bindings[0]).toMatchObject({
        scope: "wiki_page",
        targetId: "topic-selected",
        label: "选中页面",
        virtualPath: `/knowledge/${value.firstSpaceId}/wiki/pages/topic-selected`
      });
      const wholeSpace = detail.bindings.find(({ scope }) => scope === "space");
      expect(wholeSpace).toBeUndefined();
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("rejects an invalid initial target without leaving a partial session", async () => {
    const value = await fixture();
    try {
      await expect(
        createAgentSession({
          userId: value.userId,
          title: "不应创建",
          bindings: [
            {
              spaceId: value.firstSpaceId,
              scope: "wiki_page",
              targetId: "topic-missing"
            }
          ],
          resolveWikiPage: async () => null
        })
      ).rejects.toThrow("AGENT_CONTEXT_TARGET_NOT_FOUND");
      await expect(
        value.db
          .select()
          .from(schema.agentSessions)
          .where(eq(schema.agentSessions.userId, value.userId))
      ).resolves.toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("removes bindings, revokes inaccessible contexts, and blocks archived writes", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "范围助手",
        spaceIds: [value.firstSpaceId]
      });
      const second = await addAgentSessionSpaceBinding({
        sessionId: session.id,
        userId: value.userId,
        spaceId: value.secondSpaceId
      });
      await removeAgentSessionSpaceBinding({
        sessionId: session.id,
        userId: value.userId,
        bindingId: second.id
      });
      await value.db
        .delete(schema.spaceMemberships)
        .where(
          and(
            eq(schema.spaceMemberships.spaceId, value.firstSpaceId),
            eq(schema.spaceMemberships.userId, value.userId)
          )
        );
      const context = await resolveAgentSessionContext(session.id, value.userId);
      expect(context.bindings).toEqual([]);
      expect(context.revokedBindingIds).toHaveLength(1);
      await updateAgentSession(session.id, value.userId, { status: "archived" });
      await expect(
        addAgentSessionSpaceBinding({
          sessionId: session.id,
          userId: value.userId,
          spaceId: value.secondSpaceId
        })
      ).rejects.toThrow("AGENT_SESSION_ARCHIVED");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("revokes active Agent bindings when the organization membership is paused", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "组织暂停撤权",
        spaceIds: [value.firstSpaceId]
      });
      await value.db
        .update(schema.organizationMemberships)
        .set({ disabled: true })
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, value.organizationId),
            eq(schema.organizationMemberships.userId, value.userId)
          )
        );

      const context = await resolveAgentSessionContext(session.id, value.userId);
      expect(context.bindings).toEqual([]);
      expect(context.revokedBindingIds).toHaveLength(1);
      await expect(getAgentSessionDetail(session.id, value.userId)).rejects.toThrow(
        "AGENT_SESSION_ACCESS_REVOKED"
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("refuses to persist a running Agent answer after organization membership is paused", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "运行中撤权",
        spaceIds: [value.firstSpaceId]
      });
      const bindingId = (await getAgentSessionDetail(session.id, value.userId)).bindings[0]?.id;
      if (!bindingId) throw new Error("TEST_BINDING_MISSING");
      const begun = await beginAgentSessionRun({
        sessionId: session.id,
        userId: value.userId,
        question: "不应在撤权后保存"
      });
      await value.db
        .update(schema.organizationMemberships)
        .set({ disabled: true })
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, value.organizationId),
            eq(schema.organizationMemberships.userId, value.userId)
          )
        );

      await expect(
        completeAgentSessionRun({
          runId: begun.run.id,
          sessionId: session.id,
          userId: value.userId,
          durationMs: 8,
          result: {
            answer: {
              answer: "撤权后不应保存的回答",
              evidenceIds: [],
              insufficientEvidence: true,
              mode: "extractive_fallback"
            },
            evidence: {
              question: "不应在撤权后保存",
              items: [],
              searchedPages: 0,
              embeddingCalls: 0
            }
          },
          toolCalls: [
            {
              name: "knowledge.search",
              bindingIds: [bindingId],
              inputSummary: "在 1 个受管知识范围中检索",
              outputSummary: "检索 0 页，得到 0 条候选",
              resultCount: 0,
              searchedPages: 0,
              durationMs: 3
            }
          ]
        })
      ).rejects.toThrow("AGENT_SESSION_ACCESS_REVOKED");
      const messages = await value.db
        .select()
        .from(schema.agentMessages)
        .where(eq(schema.agentMessages.sessionId, session.id));
      expect(messages.map(({ role }) => role)).toEqual(["user"]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("binds only validated page or immutable resource-version targets", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "精确范围助手",
        spaceIds: [value.firstSpaceId]
      });
      const resourceId = randomUUID();
      const resourceVersionId = randomUUID();
      const otherResourceId = randomUUID();
      const otherResourceVersionId = randomUUID();
      await value.db.insert(schema.resources).values([
        {
          id: resourceId,
          spaceId: value.firstSpaceId,
          name: "选中资料",
          status: "ready",
          createdBy: value.userId
        },
        {
          id: otherResourceId,
          spaceId: value.secondSpaceId,
          name: "其他空间资料",
          status: "ready",
          createdBy: value.userId
        }
      ]);
      await value.db.insert(schema.resourceVersions).values([
        {
          id: resourceVersionId,
          resourceId,
          version: 1,
          originalName: "选中资料.md",
          mimeType: "text/markdown",
          byteSize: 12,
          sha256: "a".repeat(64),
          blobUri: "local://selected",
          createdBy: value.userId
        },
        {
          id: otherResourceVersionId,
          resourceId: otherResourceId,
          version: 1,
          originalName: "其他资料.md",
          mimeType: "text/markdown",
          byteSize: 12,
          sha256: "b".repeat(64),
          blobUri: "local://other",
          createdBy: value.userId
        }
      ]);
      const pageBinding = await addAgentSessionContextBinding({
        sessionId: session.id,
        userId: value.userId,
        spaceId: value.firstSpaceId,
        scope: "wiki_page",
        targetId: "topic-selected",
        resolveWikiPage: async ({ pageId }) =>
          pageId === "topic-selected" ? { title: "选中页面" } : null
      });
      expect(pageBinding).toMatchObject({
        scope: "wiki_page",
        targetId: "topic-selected",
        virtualPath: `/knowledge/${value.firstSpaceId}/wiki/pages/topic-selected`
      });
      const versionBinding = await addAgentSessionContextBinding({
        sessionId: session.id,
        userId: value.userId,
        spaceId: value.firstSpaceId,
        scope: "resource_version",
        targetId: resourceVersionId
      });
      expect(versionBinding).toMatchObject({
        scope: "resource_version",
        targetId: resourceVersionId,
        virtualPath: `/knowledge/${value.firstSpaceId}/resources/${resourceVersionId}`
      });
      await expect(
        addAgentSessionContextBinding({
          sessionId: session.id,
          userId: value.userId,
          spaceId: value.firstSpaceId,
          scope: "resource_version",
          targetId: otherResourceVersionId
        })
      ).rejects.toThrow("AGENT_CONTEXT_TARGET_NOT_FOUND");
      await expect(
        addAgentSessionContextBinding({
          sessionId: session.id,
          userId: value.userId,
          spaceId: value.firstSpaceId,
          scope: "wiki_page",
          targetId: "topic-missing",
          resolveWikiPage: async () => null
        })
      ).rejects.toThrow("AGENT_CONTEXT_TARGET_NOT_FOUND");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("binds an active course to its fixed versions in one authorized space", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "课程范围助手",
        spaceIds: [value.firstSpaceId]
      });
      const resourceId = randomUUID();
      const resourceVersionId = randomUUID();
      const profileId = randomUUID();
      const planId = randomUUID();
      const courseId = randomUUID();
      const moduleId = randomUUID();
      await value.db.insert(schema.resources).values({
        id: resourceId,
        spaceId: value.firstSpaceId,
        name: "课程固定资料",
        status: "ready",
        createdBy: value.userId
      });
      await value.db.insert(schema.resourceVersions).values({
        id: resourceVersionId,
        resourceId,
        version: 1,
        originalName: "课程固定资料.md",
        mimeType: "text/markdown",
        byteSize: 12,
        sha256: "c".repeat(64),
        blobUri: "local://course-version",
        createdBy: value.userId
      });
      await value.db.insert(schema.learnerProfiles).values({ id: profileId, userId: value.userId });
      await value.db.insert(schema.learningPlans).values({
        id: planId,
        learnerProfileId: profileId,
        version: 1,
        status: "active",
        title: "当前学习计划",
        plan: {}
      });
      await value.db.insert(schema.courses).values({
        id: courseId,
        learningPlanId: planId,
        title: "已确认课程",
        goal: "验证固定版本范围"
      });
      await value.db.insert(schema.courseModules).values({
        id: moduleId,
        courseId,
        ordinal: 1,
        title: "第一模块",
        objective: "学习课程资料"
      });
      await value.db.insert(schema.courseUnits).values({
        courseModuleId: moduleId,
        planUnitId: "unit-01",
        ordinal: 1,
        title: "固定资料单元",
        objective: "学习",
        completionRule: "完成阅读",
        resourceVersionId,
        sourceRef: `wk://source/${resourceVersionId}/document/learning-original`
      });
      const binding = await addAgentSessionContextBinding({
        sessionId: session.id,
        userId: value.userId,
        spaceId: value.firstSpaceId,
        scope: "course",
        targetId: courseId
      });
      expect(binding).toMatchObject({
        scope: "course",
        targetId: courseId,
        label: "已确认课程",
        virtualPath: `/knowledge/${value.firstSpaceId}/courses/${courseId}`
      });
      const resolved = await resolveAgentSessionContext(session.id, value.userId);
      expect(resolved.bindings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: binding.id,
            courseResourceVersionIds: [resourceVersionId]
          })
        ])
      );
      await value.db
        .update(schema.courses)
        .set({ status: "archived" })
        .where(eq(schema.courses.id, courseId));
      const afterArchive = await resolveAgentSessionContext(session.id, value.userId);
      expect(afterArchive.bindings.map(({ id }) => id)).not.toContain(binding.id);
      expect(afterArchive.revokedBindingIds).toContain(binding.id);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("persists messages and source metadata without wiki excerpts", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "证据助手",
        spaceIds: [value.firstSpaceId]
      });
      const result = {
        answer: {
          answer: "间隔检索有助于长期记忆。",
          evidenceIds: [`${value.firstSpaceId}__evidence-01`],
          insufficientEvidence: false,
          mode: "generated" as const
        },
        evidence: {
          question: "怎样改善长期记忆？",
          items: [
            {
              id: `${value.firstSpaceId}__evidence-01`,
              pageId: "memory",
              pageTitle: "学习科学",
              pageType: "topic" as const,
              text: "间隔检索有助于长期记忆。",
              sourceRefs: [`wk://source/${randomUUID()}/document/node-1`],
              conflicted: false
            }
          ],
          searchedPages: 1,
          embeddingCalls: 0 as const
        }
      };
      const sourceRefs = result.evidence.items[0]?.sourceRefs;
      expect(sourceRefs).toBeDefined();
      await persistAgentSessionTurn({
        sessionId: session.id,
        userId: value.userId,
        question: "怎样改善长期记忆？",
        result,
        durationMs: 12
      });
      const detail = await getAgentSessionDetail(session.id, value.userId);
      expect(detail.messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
      expect(detail.snapshots).toHaveLength(1);
      expect(detail.snapshots[0]).toMatchObject({
        spaceId: value.firstSpaceId,
        evidenceId: `${value.firstSpaceId}__evidence-01`,
        sourceRefs,
        cited: true
      });
      expect(JSON.stringify(detail.snapshots)).not.toContain("间隔检索有助于长期记忆");
      await expect(getAgentSessionDetail(session.id, value.otherUserId)).rejects.toThrow(
        "AGENT_SESSION_NOT_FOUND"
      );
      const runId = detail.runs[0]?.id;
      expect(runId).toBeDefined();
      if (!runId) throw new Error("TEST_RUN_MISSING");
      await value.db
        .delete(schema.spaceMemberships)
        .where(
          and(
            eq(schema.spaceMemberships.spaceId, value.firstSpaceId),
            eq(schema.spaceMemberships.userId, value.userId)
          )
        );
      await expect(getAgentSessionDetail(session.id, value.userId)).rejects.toThrow(
        "AGENT_SESSION_ACCESS_REVOKED"
      );
      await expect(
        getAgentRunEvents({ runId, userId: value.userId, afterSequence: 0 })
      ).rejects.toThrow("AGENT_SESSION_ACCESS_REVOKED");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("persists redacted ToolCall lifecycle events and replays an exact sequence", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "ToolCall 审计助手",
        spaceIds: [value.firstSpaceId]
      });
      const bindingId = (await getAgentSessionDetail(session.id, value.userId)).bindings[0]?.id;
      if (!bindingId) throw new Error("TEST_BINDING_MISSING");
      const begun = await beginAgentSessionRun({
        sessionId: session.id,
        userId: value.userId,
        question: "不要保存这段问题正文"
      });
      await completeAgentSessionRun({
        runId: begun.run.id,
        sessionId: session.id,
        userId: value.userId,
        durationMs: 18,
        result: {
          answer: {
            answer: "有一条知识依据。",
            evidenceIds: [`${value.firstSpaceId}__evidence-01`],
            insufficientEvidence: false,
            mode: "extractive_fallback"
          },
          evidence: {
            question: "不要保存这段问题正文",
            items: [
              {
                id: `${value.firstSpaceId}__evidence-01`,
                pageId: "tool-audit",
                pageTitle: "ToolCall 页面",
                pageType: "topic",
                text: "不要保存这段知识正文。",
                sourceRefs: [`wk://source/${randomUUID()}/document/node-1`],
                conflicted: false
              }
            ],
            searchedPages: 3,
            embeddingCalls: 0
          }
        },
        toolCalls: [
          {
            name: "knowledge.search",
            bindingIds: [bindingId],
            inputSummary: "在 1 个受管知识范围中检索",
            outputSummary: "检索 3 页，得到 1 条候选",
            resultCount: 1,
            searchedPages: 3,
            durationMs: 7
          },
          {
            name: "knowledge.read",
            bindingIds: [bindingId],
            inputSummary: "读取 1 个已检索证据片段",
            outputSummary: "读取 1 个受管证据片段",
            resultCount: 1,
            searchedPages: 1,
            durationMs: 2
          }
        ]
      });
      const detail = await getAgentSessionDetail(session.id, value.userId);
      expect(detail.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            agentRunId: begun.run.id,
            name: "knowledge.search",
            bindingIds: [bindingId],
            resultCount: 1,
            searchedPages: 3
          }),
          expect.objectContaining({
            agentRunId: begun.run.id,
            name: "knowledge.read",
            bindingIds: [bindingId],
            resultCount: 1,
            searchedPages: 1
          })
        ])
      );
      expect(JSON.stringify(detail.toolCalls)).not.toContain("不要保存这段问题正文");
      expect(JSON.stringify(detail.toolCalls)).not.toContain("不要保存这段知识正文");
      expect(
        detail.events.map(({ sequence, type, tool, status }) => ({ sequence, type, tool, status }))
      ).toEqual([
        { sequence: 1, type: "run.started", tool: null, status: "running" },
        { sequence: 2, type: "tool.requested", tool: "knowledge.search", status: null },
        { sequence: 3, type: "tool.completed", tool: "knowledge.search", status: null },
        { sequence: 4, type: "tool.requested", tool: "knowledge.read", status: null },
        { sequence: 5, type: "tool.completed", tool: "knowledge.read", status: null },
        { sequence: 6, type: "run.completed", tool: null, status: "completed" }
      ]);
      const replay = await getAgentRunEvents({
        runId: begun.run.id,
        userId: value.userId,
        afterSequence: 3
      });
      expect(replay.map(({ sequence, type }) => ({ sequence, type }))).toEqual([
        { sequence: 4, type: "tool.requested" },
        { sequence: 5, type: "tool.completed" },
        { sequence: 6, type: "run.completed" }
      ]);
      expect(JSON.stringify(replay)).not.toContain("不要保存这段问题正文");
      expect(JSON.stringify(replay)).not.toContain("不要保存这段知识正文");
      await expect(
        getAgentRunEvents({ runId: begun.run.id, userId: value.otherUserId, afterSequence: 0 })
      ).rejects.toThrow("AGENT_RUN_NOT_FOUND");
      await expect(getAgentSessionDetail(session.id, value.otherUserId)).rejects.toThrow(
        "AGENT_SESSION_NOT_FOUND"
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("queues a version-and-scope-bound SkillRun only after matching approval", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "Skill 运行会话",
        spaceIds: [value.firstSpaceId]
      });
      const bindingId = (await getAgentSessionDetail(session.id, value.userId)).bindings[0]?.id;
      expect(bindingId).toBeDefined();
      if (!bindingId) throw new Error("TEST_BINDING_MISSING");
      await expect(
        createQueuedSkillRun({
          sessionId: session.id,
          userId: value.userId,
          skill: workerApprovalSkill,
          bindingIds: [bindingId],
          inputSummary: "生成一份更正提案"
        })
      ).rejects.toThrow("SKILL_APPROVAL_REQUIRED");
      const approval = await requestSkillApproval({
        sessionId: session.id,
        userId: value.userId,
        skill: workerApprovalSkill,
        bindingIds: [bindingId],
        inputSummary: "生成一份更正提案"
      });
      await decideSkillApproval({
        approvalId: approval.id,
        userId: value.userId,
        decision: "approve"
      });
      const run = await createQueuedSkillRun({
        sessionId: session.id,
        userId: value.userId,
        skill: workerApprovalSkill,
        bindingIds: [bindingId],
        inputSummary: "生成一份更正提案"
      });
      expect(run).toMatchObject({
        sessionId: session.id,
        status: "queued",
        skillVersion: workerApprovalSkill.version,
        skillDigest: workerApprovalSkill.digest,
        bindingIds: [bindingId],
        approvalId: approval.id
      });
      const [outbox] = await value.db
        .select()
        .from(schema.skillRunOutbox)
        .where(eq(schema.skillRunOutbox.skillRunId, run.id));
      expect(outbox).toMatchObject({ skillRunId: run.id, status: "pending", attemptCount: 0 });
      await expect(
        createQueuedSkillRun({
          sessionId: session.id,
          userId: value.userId,
          skill: workerApprovalSkill,
          bindingIds: [],
          inputSummary: "范围不匹配"
        })
      ).rejects.toThrow("SKILL_POLICY_DENIED");
      await expect(
        createQueuedSkillRun({
          sessionId: session.id,
          userId: value.userId,
          skill: workerApprovalSkill,
          bindingIds: [bindingId],
          inputSummary: "不同的执行参数摘要"
        })
      ).rejects.toThrow("SKILL_APPROVAL_REQUIRED");
      await expect(getAgentSessionDetail(session.id, value.otherUserId)).rejects.toThrow(
        "AGENT_SESSION_NOT_FOUND"
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("does not create a queued run for a Skill without a Worker execution boundary", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "不支持执行器的 Skill",
        spaceIds: [value.firstSpaceId]
      });
      const bindingId = (await getAgentSessionDetail(session.id, value.userId)).bindings[0]?.id;
      if (!bindingId) throw new Error("TEST_BINDING_MISSING");
      await expect(
        createQueuedSkillRun({
          sessionId: session.id,
          userId: value.userId,
          skill: alwaysApprovalSkill,
          bindingIds: [bindingId],
          inputSummary: "不能创建不可执行的请求"
        })
      ).rejects.toThrow("SKILL_EXECUTION_UNAVAILABLE");
      const runs = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.sessionId, session.id));
      expect(runs).toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("rejects a full-space Worker Skill before approval or queueing when a page scope is selected", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "页面范围 Lint 会话",
        bindings: [
          {
            spaceId: value.firstSpaceId,
            scope: "wiki_page",
            targetId: "selected-page"
          }
        ],
        resolveWikiPage: async ({ pageId }) =>
          pageId === "selected-page" ? { title: "选中页面" } : null
      });
      const [binding] = (await getAgentSessionDetail(session.id, value.userId)).bindings;
      if (!binding) throw new Error("TEST_BINDING_MISSING");
      const fullSpaceWorkerSkill = {
        ...workerApprovalSkill,
        permissions: { ...workerApprovalSkill.permissions, resources: "space" as const }
      } satisfies ManagedSkill;
      const policies = await listSessionSkillPolicies({
        sessionId: session.id,
        userId: value.userId,
        skills: [fullSpaceWorkerSkill]
      });
      expect(policies).toEqual([]);
      await expect(
        requestSkillApproval({
          sessionId: session.id,
          userId: value.userId,
          skill: fullSpaceWorkerSkill,
          bindingIds: [binding.id],
          inputSummary: "不能把页面范围扩展为整空间检查"
        })
      ).rejects.toThrow("SKILL_POLICY_DENIED");
      await expect(
        createQueuedSkillRun({
          sessionId: session.id,
          userId: value.userId,
          skill: fullSpaceWorkerSkill,
          bindingIds: [binding.id],
          inputSummary: "不能把页面范围扩展为整空间检查"
        })
      ).rejects.toThrow("SKILL_POLICY_DENIED");
      await expect(
        value.db.select().from(schema.skillRuns).where(eq(schema.skillRuns.sessionId, session.id))
      ).resolves.toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("keeps a full-space Worker Skill available in a mixed session by selecting only space bindings", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "混合范围 Lint 会话",
        bindings: [
          { spaceId: value.firstSpaceId, scope: "space" },
          {
            spaceId: value.secondSpaceId,
            scope: "wiki_page",
            targetId: "selected-page"
          }
        ],
        resolveWikiPage: async ({ spaceId, pageId }) =>
          spaceId === value.secondSpaceId && pageId === "selected-page"
            ? { title: "选中页面" }
            : null
      });
      const bindings = (await getAgentSessionDetail(session.id, value.userId)).bindings;
      const spaceBinding = bindings.find(({ scope }) => scope === "space");
      const pageBinding = bindings.find(({ scope }) => scope === "wiki_page");
      if (!spaceBinding || !pageBinding) throw new Error("TEST_BINDINGS_MISSING");
      const fullSpaceWorkerSkill = {
        ...workerApprovalSkill,
        permissions: { ...workerApprovalSkill.permissions, resources: "space" as const }
      } satisfies ManagedSkill;
      const policies = await listSessionSkillPolicies({
        sessionId: session.id,
        userId: value.userId,
        skills: [fullSpaceWorkerSkill]
      });
      expect(policies).toEqual([
        expect.objectContaining({ id: "wiki-lint", decision: "ask", execution: "worker" })
      ]);
      await expect(
        createQueuedSkillRun({
          sessionId: session.id,
          userId: value.userId,
          skill: fullSpaceWorkerSkill,
          bindingIds: [pageBinding.id],
          inputSummary: "页面范围不能扩展为整空间"
        })
      ).rejects.toThrow("SKILL_POLICY_DENIED");
      const approval = await requestSkillApproval({
        sessionId: session.id,
        userId: value.userId,
        skill: fullSpaceWorkerSkill,
        bindingIds: [spaceBinding.id],
        inputSummary: "只检查完整知识空间"
      });
      await decideSkillApproval({
        approvalId: approval.id,
        userId: value.userId,
        decision: "approve"
      });
      const run = await createQueuedSkillRun({
        sessionId: session.id,
        userId: value.userId,
        skill: fullSpaceWorkerSkill,
        bindingIds: [spaceBinding.id],
        inputSummary: "只检查完整知识空间"
      });
      expect(run.bindingIds).toEqual([spaceBinding.id]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("settles running runs without persisting a partial assistant answer", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "运行状态助手",
        spaceIds: [value.firstSpaceId]
      });
      const begun = await beginAgentSessionRun({
        sessionId: session.id,
        userId: value.userId,
        question: "先不要完成"
      });
      expect(begun.run.status).toBe("running");
      await expect(
        beginAgentSessionRun({
          sessionId: session.id,
          userId: value.userId,
          question: "不能并发运行"
        })
      ).rejects.toThrow("AGENT_RUN_ACTIVE");
      const stopped = await stopAgentSessionRun({
        runId: begun.run.id,
        userId: value.userId,
        durationMs: 8
      });
      expect(stopped).toMatchObject({
        status: "stopped",
        assistantMessageId: null,
        errorCode: "AGENT_RUN_CANCELLED"
      });
      expect(
        (
          await getAgentRunEvents({ runId: begun.run.id, userId: value.userId, afterSequence: 0 })
        ).map(({ type }) => type)
      ).toEqual(["run.started", "run.stopped"]);
      await expect(
        completeAgentSessionRun({
          runId: begun.run.id,
          sessionId: session.id,
          userId: value.userId,
          durationMs: 9,
          result: {
            answer: {
              answer: "不应被写入",
              evidenceIds: [],
              insufficientEvidence: true,
              mode: "extractive_fallback"
            },
            evidence: {
              question: "先不要完成",
              items: [],
              searchedPages: 0,
              embeddingCalls: 0
            }
          },
          toolCalls: [
            {
              name: "knowledge.search",
              bindingIds: [
                (await getAgentSessionDetail(session.id, value.userId)).bindings[0]?.id ?? ""
              ],
              inputSummary: "在 1 个受管知识范围中检索",
              outputSummary: "检索 0 页，得到 0 条候选",
              resultCount: 0,
              searchedPages: 0,
              durationMs: 2
            }
          ]
        })
      ).rejects.toThrow("AGENT_RUN_NOT_RUNNING");
      const failedRun = await beginAgentSessionRun({
        sessionId: session.id,
        userId: value.userId,
        question: "模拟失败"
      });
      const failed = await settleAgentSessionRun({
        runId: failedRun.run.id,
        sessionId: session.id,
        userId: value.userId,
        status: "failed",
        durationMs: 12,
        errorCode: "MODEL_PROVIDER_TIMEOUT"
      });
      expect(failed).toMatchObject({ status: "failed", assistantMessageId: null });
      expect(
        (
          await getAgentRunEvents({
            runId: failedRun.run.id,
            userId: value.userId,
            afterSequence: 0
          })
        ).map(({ type }) => type)
      ).toEqual(["run.started", "run.failed"]);
      const detail = await getAgentSessionDetail(session.id, value.userId);
      expect(detail.messages.map(({ content }) => content)).toEqual(["先不要完成", "模拟失败"]);
      expect(detail.snapshots).toEqual([]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("loads only recently completed conversation context before creating a new run", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "有限历史会话",
        spaceIds: [value.firstSpaceId]
      });
      const result = {
        answer: {
          answer: "这是已完成的回答。",
          evidenceIds: [],
          insufficientEvidence: true,
          mode: "extractive_fallback" as const
        },
        evidence: { question: "第一问", items: [], searchedPages: 0, embeddingCalls: 0 as const }
      };
      await persistAgentSessionTurn({
        sessionId: session.id,
        userId: value.userId,
        question: "第一问",
        result,
        durationMs: 1
      });
      const failed = await beginAgentSessionRun({
        sessionId: session.id,
        userId: value.userId,
        question: "失败的问题"
      });
      await settleAgentSessionRun({
        runId: failed.run.id,
        sessionId: session.id,
        userId: value.userId,
        status: "failed",
        durationMs: 1,
        errorCode: "MODEL_PROVIDER_TIMEOUT"
      });
      const begun = await beginAgentSessionRun({
        sessionId: session.id,
        userId: value.userId,
        question: "第二问"
      });
      expect(begun.conversation.map(({ role, content }) => ({ role, content }))).toEqual([
        { role: "user", content: "第一问" },
        { role: "assistant", content: "这是已完成的回答。" },
        { role: "user", content: "失败的问题" }
      ]);
      await stopAgentSessionRun({ runId: begun.run.id, userId: value.userId, durationMs: 1 });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("only exposes allowed skills and binds approval to session version and active ranges", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "Skill 审批助手",
        spaceIds: [value.firstSpaceId]
      });
      const detail = await getAgentSessionDetail(session.id, value.userId);
      const bindingId = detail.bindings[0]?.id;
      if (!bindingId) throw new Error("TEST_BINDING_MISSING");
      const policies = await listSessionSkillPolicies({
        sessionId: session.id,
        userId: value.userId,
        skills: [
          alwaysApprovalSkill,
          { ...alwaysApprovalSkill, id: "disabled-skill", enabled: false }
        ]
      });
      expect(policies).toEqual([expect.objectContaining({ id: "wiki-correct", decision: "ask" })]);
      expect(policies[0]).toMatchObject({ execution: "unavailable" });
      const approval = await requestSkillApproval({
        sessionId: session.id,
        userId: value.userId,
        skill: alwaysApprovalSkill,
        bindingIds: [bindingId],
        inputSummary: "依据当前页面生成更正提案"
      });
      expect(approval).toMatchObject({
        status: "pending",
        skillVersion: "1.0.0",
        skillDigest: alwaysApprovalSkill.digest,
        bindingIds: [bindingId]
      });
      await expect(
        requestSkillApproval({
          sessionId: session.id,
          userId: value.userId,
          skill: alwaysApprovalSkill,
          bindingIds: [randomUUID()],
          inputSummary: "不属于会话的范围"
        })
      ).rejects.toThrow("SKILL_POLICY_DENIED");
      await expect(
        decideSkillApproval({
          approvalId: approval.id,
          userId: value.otherUserId,
          decision: "approve"
        })
      ).rejects.toThrow("SKILL_APPROVAL_NOT_FOUND");
      const decided = await decideSkillApproval({
        approvalId: approval.id,
        userId: value.userId,
        decision: "approve"
      });
      expect(decided.status).toBe("approved");
      await expect(
        decideSkillApproval({ approvalId: approval.id, userId: value.userId, decision: "reject" })
      ).rejects.toThrow("SKILL_APPROVAL_ALREADY_DECIDED");
      expect(
        await listSessionSkillApprovals({ sessionId: session.id, userId: value.userId })
      ).toEqual([expect.objectContaining({ id: approval.id, status: "approved" })]);
      const revokedApproval = await requestSkillApproval({
        sessionId: session.id,
        userId: value.userId,
        skill: alwaysApprovalSkill,
        bindingIds: [bindingId],
        inputSummary: "将被撤销的范围"
      });
      await value.db
        .delete(schema.spaceMemberships)
        .where(
          and(
            eq(schema.spaceMemberships.spaceId, value.firstSpaceId),
            eq(schema.spaceMemberships.userId, value.userId)
          )
        );
      await expect(
        decideSkillApproval({
          approvalId: revokedApproval.id,
          userId: value.userId,
          decision: "approve"
        })
      ).rejects.toThrow("SKILL_APPROVAL_SCOPE_REVOKED");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
