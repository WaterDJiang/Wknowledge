import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  confirmLearningPlan,
  claimLearningReportSnapshot,
  completeLearningReportSnapshot,
  createAssessment,
  createAssessmentFromPracticeGenerateCandidate,
  createActiveLearningReportSnapshot,
  createPracticeCandidate,
  createLearningPlanDraft,
  createAgentSession,
  dispatchPendingLearningReportOutbox,
  getActiveLearningCourse,
  getActiveLearningPlan,
  getActiveLearningProgressReport,
  getLearningReportArtifact,
  getLearningReportSnapshot,
  getActiveLearningProgress,
  getLearnerProfile,
  listActivePracticeMistakeReviews,
  listAssessments,
  listLearningContentOptions,
  listLearningReportSnapshots,
  listLearningPlans,
  listManualFreeResponseReviews,
  listPracticeCandidates,
  listPracticeGenerateCandidates,
  materializePlanComposeCandidate,
  materializePracticeGenerateCandidate,
  queuePlanComposeGeneration,
  recordActiveLearningEvent,
  submitPracticeAttempt,
  startAssessment,
  submitAssessment,
  submitAssessmentAttempt,
  submitManualFreeResponseReview,
  updateLearnerDeclared
} from "../src/index";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";

const test = process.env.DATABASE_URL ? it : it.skip;

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const unavailableResourceId = randomUUID();
  const unavailableVersionId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "学习计划测试组织" });
  await db.insert(schema.users).values([
    {
      id: userId,
      email: `learning-user-${userId}@example.com`,
      name: "学习者",
      passwordHash: "not-used"
    },
    {
      id: otherUserId,
      email: `learning-other-${otherUserId}@example.com`,
      name: "无权学习者",
      passwordHash: "not-used"
    }
  ]);
  await db.insert(schema.organizationMemberships).values([
    { organizationId, userId, role: "admin" },
    { organizationId, userId: otherUserId, role: "viewer" }
  ]);
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "学习资料空间",
    createdBy: userId
  });
  await db.insert(schema.spaceMemberships).values({ spaceId, userId, role: "viewer" });
  await db.insert(schema.resources).values([
    { id: resourceId, spaceId, name: "可学习资料", status: "ready", createdBy: userId },
    {
      id: unavailableResourceId,
      spaceId,
      name: "处理中资料",
      status: "processing",
      createdBy: userId
    }
  ]);
  await db.insert(schema.resourceVersions).values([
    {
      id: versionId,
      resourceId,
      version: 1,
      originalName: "学习材料.pdf",
      mimeType: "application/pdf",
      byteSize: 128,
      sha256: randomUUID().replaceAll("-", ""),
      blobUri: `local://tests/${versionId}/source.pdf`,
      compileProfile: "knowledge",
      createdBy: userId
    },
    {
      id: unavailableVersionId,
      resourceId: unavailableResourceId,
      version: 1,
      originalName: "还在处理.txt",
      mimeType: "text/plain",
      byteSize: 12,
      sha256: randomUUID().replaceAll("-", ""),
      blobUri: `local://tests/${unavailableVersionId}/source.txt`,
      compileProfile: "reference",
      createdBy: userId
    }
  ]);
  return {
    db,
    organizationId,
    userId,
    otherUserId,
    spaceId,
    resourceId,
    versionId,
    unavailableVersionId
  };
}

afterAll(async () => closeDatabase());

describe("learning plans", () => {
  test("queues a plan-compose request with private goal input and exact resource bindings", async () => {
    const value = await fixture();
    try {
      const goal = "在两周内完成产品资料的基础学习";
      const skill = {
        id: "plan-compose",
        version: "1.0.0",
        digest: "sha256:4d753db4e80a55ffbd890b8e0ca05d422b329653eb6bc3a1d1ed3fd674a8f40a",
        description: "生成计划候选",
        enabled: true,
        requiredCapabilities: ["chat" as const],
        permissions: {
          resources: "selected" as const,
          filesystem: "none" as const,
          network: "deny" as const,
          approval: "never" as const
        },
        limits: { timeoutSeconds: 120, memoryMb: 256, maxModelCalls: 1 },
        origin: "builtin" as const
      };
      const run = await queuePlanComposeGeneration({
        userId: value.userId,
        skill,
        goal,
        resourceVersionIds: [value.versionId]
      });
      expect(run.status).toBe("queued");
      expect(run.inputSummary).toBe("生成计划候选：已选择资料 1 份");
      expect(run.inputSummary).not.toContain(goal);
      const [request] = await value.db
        .select()
        .from(schema.learningGenerationRequests)
        .where(eq(schema.learningGenerationRequests.skillRunId, run.id));
      expect(request?.kind).toBe("plan_compose");
      expect(request?.input).toEqual({ goal, resourceVersionIds: [value.versionId] });
      const bindings = await value.db
        .select()
        .from(schema.agentContextBindings)
        .where(eq(schema.agentContextBindings.sessionId, run.sessionId));
      expect(bindings).toHaveLength(1);
      expect(bindings[0]).toMatchObject({
        scope: "resource_version",
        targetId: value.versionId,
        spaceId: value.spaceId
      });
      const audits = await value.db
        .select()
        .from(schema.auditEvents)
        .where(eq(schema.auditEvents.targetId, run.id));
      expect(JSON.stringify(audits)).not.toContain(goal);
      expect(JSON.stringify(audits)).not.toContain("学习材料.pdf");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("rejects an unavailable plan-compose selection before creating a session or run", async () => {
    const value = await fixture();
    try {
      const skill = {
        id: "plan-compose",
        version: "1.0.0",
        digest: "sha256:4d753db4e80a55ffbd890b8e0ca05d422b329653eb6bc3a1d1ed3fd674a8f40a",
        description: "生成计划候选",
        enabled: true,
        requiredCapabilities: ["chat" as const],
        permissions: {
          resources: "selected" as const,
          filesystem: "none" as const,
          network: "deny" as const,
          approval: "never" as const
        },
        limits: { timeoutSeconds: 120, memoryMb: 256, maxModelCalls: 1 },
        origin: "builtin" as const
      };
      await expect(
        queuePlanComposeGeneration({
          userId: value.userId,
          skill,
          goal: "不可用资料不能排队",
          resourceVersionIds: [value.unavailableVersionId]
        })
      ).rejects.toThrow("LEARNING_GENERATION_SELECTION_DENIED");
      const [sessions, runs, requests] = await Promise.all([
        value.db
          .select()
          .from(schema.agentSessions)
          .where(eq(schema.agentSessions.organizationId, value.organizationId)),
        value.db.select().from(schema.skillRuns).where(eq(schema.skillRuns.userId, value.userId)),
        value.db
          .select({ request: schema.learningGenerationRequests })
          .from(schema.learningGenerationRequests)
          .innerJoin(
            schema.skillRuns,
            eq(schema.learningGenerationRequests.skillRunId, schema.skillRuns.id)
          )
          .where(eq(schema.skillRuns.userId, value.userId))
      ]);
      expect(sessions).toHaveLength(0);
      expect(runs).toHaveLength(0);
      expect(requests).toHaveLength(0);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("keeps learner declarations separate from observed and inferred data", async () => {
    const value = await fixture();
    try {
      const initial = await getLearnerProfile(value.userId);
      expect(initial.declared).toEqual({
        currentLevel: "unspecified",
        weeklyMinutes: 120,
        preferredPace: "steady",
        note: ""
      });
      await value.db
        .update(schema.learnerProfiles)
        .set({ observed: { completedUnits: 3 }, inferred: { confidence: 0.4 } })
        .where(eq(schema.learnerProfiles.id, initial.id));
      const updated = await updateLearnerDeclared({
        userId: value.userId,
        declared: {
          currentLevel: "intermediate",
          weeklyMinutes: 180,
          preferredPace: "flexible",
          note: "优先完成 PDF 材料"
        }
      });
      expect(updated).toMatchObject({
        declared: { currentLevel: "intermediate", weeklyMinutes: 180 },
        observed: { completedUnits: 3 },
        inferred: { confidence: 0.4 }
      });
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "带画像快照的计划",
        goal: "验证自述画像快照",
        resourceVersionIds: [value.versionId]
      });
      expect(draft.plan.learnerDeclared).toMatchObject({
        currentLevel: "intermediate",
        weeklyMinutes: 180,
        preferredPace: "flexible"
      });
      await updateLearnerDeclared({
        userId: value.userId,
        declared: {
          currentLevel: "advanced",
          weeklyMinutes: 300,
          preferredPace: "intensive",
          note: "已调整"
        }
      });
      expect((await listLearningPlans(value.userId))[0]?.plan.learnerDeclared.weeklyMinutes).toBe(
        180
      );
      const events = await value.db
        .select()
        .from(schema.learningEvents)
        .where(eq(schema.learningEvents.userId, value.userId));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            verb: "learner_profile.declared_updated",
            object: "learner_profile"
          })
        ])
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("only exposes ready resources and snapshots a selected immutable version into a draft", async () => {
    const value = await fixture();
    try {
      const options = await listLearningContentOptions(value.userId);
      expect(options.map(({ resourceVersionId }) => resourceVersionId)).toEqual([value.versionId]);
      await expect(
        createLearningPlanDraft({
          userId: value.userId,
          title: "无权资料计划",
          goal: "验证选材权限",
          resourceVersionIds: [value.unavailableVersionId]
        })
      ).rejects.toThrow("LEARNING_PLAN_SELECTION_DENIED");
      await expect(
        createLearningPlanDraft({
          userId: value.userId,
          title: "重复资料计划",
          goal: "验证重复选材",
          resourceVersionIds: [value.versionId, value.versionId]
        })
      ).rejects.toThrow("LEARNING_PLAN_SELECTION_DUPLICATE");

      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "PDF 学习计划",
        goal: "理解资料里的核心方法",
        resourceVersionIds: [value.versionId]
      });
      expect(draft).toMatchObject({ status: "draft", version: 1 });
      expect(draft.plan.learnerDeclared).toMatchObject({
        currentLevel: "unspecified",
        weeklyMinutes: 120
      });
      expect(draft.plan.selections).toEqual([
        expect.objectContaining({
          resourceVersionId: value.versionId,
          originalName: "学习材料.pdf",
          compileProfile: "knowledge"
        })
      ]);
      await value.db
        .update(schema.resources)
        .set({ name: "后来改名的资料" })
        .where(eq(schema.resources.id, value.resourceId));
      expect((await listLearningPlans(value.userId))[0]?.plan.selections[0]?.resourceName).toBe(
        "可学习资料"
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("denies learning content selection and plan drafts after the organization membership is disabled", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "暂停前已创建的计划",
        goal: "验证确认前重核",
        resourceVersionIds: [value.versionId]
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
      expect(await listLearningContentOptions(value.userId)).toEqual([]);
      await expect(
        createLearningPlanDraft({
          userId: value.userId,
          title: "暂停成员不能创建的计划",
          goal: "验证组织成员撤权",
          resourceVersionIds: [value.versionId]
        })
      ).rejects.toThrow("LEARNING_PLAN_SELECTION_DENIED");
      await expect(confirmLearningPlan({ planId: draft.id, userId: value.userId })).rejects.toThrow(
        "LEARNING_PLAN_SELECTION_REVOKED"
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("materializes a completed plan-compose run as a source-bound draft only", async () => {
    const value = await fixture();
    try {
      const session = await createAgentSession({
        userId: value.userId,
        title: "计划 Skill",
        bindings: [{ spaceId: value.spaceId, scope: "resource_version", targetId: value.versionId }]
      });
      const [binding] = await value.db
        .select()
        .from(schema.agentContextBindings)
        .where(eq(schema.agentContextBindings.sessionId, session.id));
      if (!binding) throw new Error("TEST_BINDING_MISSING");
      const skillRunId = randomUUID();
      await value.db.insert(schema.skillRuns).values({
        id: skillRunId,
        sessionId: session.id,
        userId: value.userId,
        skillId: "plan-compose",
        skillVersion: "1.2.3",
        skillDigest: `sha256:${"b".repeat(64)}`,
        bindingIds: [binding.id],
        inputSummary: "已选 1 份资料",
        status: "completed",
        completedAt: new Date()
      });
      const validSourceRef = `wk://source/${value.versionId}/${Buffer.from(
        JSON.stringify({
          type: "document",
          resourceVersionId: value.versionId,
          nodeId: "plan-focus"
        })
      ).toString("base64url")}`;
      const [candidate] = await value.db
        .insert(schema.planComposeCandidates)
        .values({
          skillRunId,
          userId: value.userId,
          candidate: {
            title: "Skill 候选计划",
            units: [
              {
                title: "资料重点",
                resourceVersionId: value.versionId,
                sourceRef: validSourceRef,
                objective: "掌握资料中的关键方法",
                completionRule: "阅读固定版本并完成学习记录"
              }
            ]
          }
        })
        .returning();
      if (!candidate) throw new Error("TEST_PLAN_COMPOSE_CANDIDATE_MISSING");
      await expect(
        materializePlanComposeCandidate({
          userId: value.userId,
          candidateId: candidate.id,
          goal: "理解固定资料",
          selectedResourceVersionIds: [value.versionId]
        })
      ).resolves.toMatchObject({
        status: "draft",
        plan: {
          generation: "skill_candidate",
          provenance: { skillRunId, skillVersion: "1.2.3" }
        }
      });
      await expect(getActiveLearningPlan(value.userId)).rejects.toThrow(
        "LEARNING_PLAN_ACTIVE_NOT_FOUND"
      );
      const outOfScopeResourceId = randomUUID();
      const outOfScopeVersionId = randomUUID();
      await value.db.insert(schema.resources).values({
        id: outOfScopeResourceId,
        spaceId: value.spaceId,
        name: "同空间但未绑定的资料",
        status: "ready",
        createdBy: value.userId
      });
      await value.db.insert(schema.resourceVersions).values({
        id: outOfScopeVersionId,
        resourceId: outOfScopeResourceId,
        version: 1,
        originalName: "未绑定资料.txt",
        mimeType: "text/plain",
        byteSize: 12,
        sha256: randomUUID().replaceAll("-", ""),
        blobUri: `local://tests/${outOfScopeVersionId}/source.txt`,
        compileProfile: "knowledge",
        createdBy: value.userId
      });
      const [outOfScopeRun] = await value.db
        .insert(schema.skillRuns)
        .values({
          sessionId: session.id,
          userId: value.userId,
          skillId: "plan-compose",
          skillVersion: "1.2.3",
          skillDigest: `sha256:${"c".repeat(64)}`,
          bindingIds: [binding.id],
          inputSummary: "范围外资料",
          status: "completed",
          completedAt: new Date()
        })
        .returning();
      if (!outOfScopeRun) throw new Error("TEST_PLAN_COMPOSE_RUN_MISSING");
      const [outOfScopeCandidate] = await value.db
        .insert(schema.planComposeCandidates)
        .values({
          skillRunId: outOfScopeRun.id,
          userId: value.userId,
          candidate: {
            title: "范围越界计划",
            units: [
              {
                title: "范围外资料",
                resourceVersionId: outOfScopeVersionId,
                sourceRef: `wk://source/${outOfScopeVersionId}/${Buffer.from(
                  JSON.stringify({
                    type: "document",
                    resourceVersionId: outOfScopeVersionId,
                    nodeId: "outside-focus"
                  })
                ).toString("base64url")}`,
                objective: "不应通过",
                completionRule: "不应通过"
              }
            ]
          }
        })
        .returning();
      if (!outOfScopeCandidate) throw new Error("TEST_PLAN_COMPOSE_CANDIDATE_MISSING");
      await expect(
        materializePlanComposeCandidate({
          userId: value.userId,
          candidateId: outOfScopeCandidate.id,
          goal: "不应读取未绑定资料",
          selectedResourceVersionIds: [outOfScopeVersionId]
        })
      ).rejects.toThrow("PLAN_COMPOSE_SCOPE_DENIED");
      await expect(
        materializePlanComposeCandidate({
          userId: value.userId,
          candidateId: candidate.id,
          goal: "验证重复物化",
          selectedResourceVersionIds: [value.versionId]
        })
      ).rejects.toThrow("PLAN_COMPOSE_CANDIDATE_ALREADY_MATERIALIZED");
      expect(await listLearningPlans(value.userId)).toHaveLength(1);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("requires confirmation, archives prior active plan, and rechecks access at confirmation", async () => {
    const value = await fixture();
    try {
      const first = await createLearningPlanDraft({
        userId: value.userId,
        title: "第一期",
        goal: "完成首次学习",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: first.id, userId: value.userId });
      expect(active.status).toBe("active");
      expect(active.confirmedAt).not.toBeNull();

      const second = await createLearningPlanDraft({
        userId: value.userId,
        title: "第二期",
        goal: "完成二次学习",
        resourceVersionIds: [value.versionId]
      });
      const replacement = await confirmLearningPlan({ planId: second.id, userId: value.userId });
      expect(replacement).toMatchObject({ status: "active", version: 2 });
      expect(await listLearningPlans(value.userId)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: first.id, status: "archived" }),
          expect.objectContaining({ id: second.id, status: "active" })
        ])
      );

      const revoked = await createLearningPlanDraft({
        userId: value.userId,
        title: "应拒绝确认",
        goal: "验证确认时重新授权",
        resourceVersionIds: [value.versionId]
      });
      await value.db
        .delete(schema.spaceMemberships)
        .where(
          and(
            eq(schema.spaceMemberships.spaceId, value.spaceId),
            eq(schema.spaceMemberships.userId, value.userId)
          )
        );
      await expect(
        confirmLearningPlan({ planId: revoked.id, userId: value.userId })
      ).rejects.toThrow("LEARNING_PLAN_SELECTION_REVOKED");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("records only fixed-source events for the active plan and rebuilds progress append-only", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "原文学习",
        goal: "完成固定版本资料阅读",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const unit = active.plan.units[0];
      expect(unit).toBeDefined();
      if (!unit) throw new Error("TEST_UNIT_MISSING");
      await expect(
        recordActiveLearningEvent({
          userId: value.userId,
          unitId: unit.id,
          verb: "opened",
          sourceRef: unit.sourceRef.replace(value.versionId, randomUUID())
        })
      ).rejects.toThrow("LEARNING_UNIT_SOURCE_DENIED");
      await value.db
        .update(schema.resources)
        .set({ status: "processing" })
        .where(eq(schema.resources.id, value.resourceId));
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: unit.id,
        verb: "opened",
        sourceRef: unit.sourceRef,
        position: { page: 3, progressPercent: 40 }
      });
      const completed = await recordActiveLearningEvent({
        userId: value.userId,
        unitId: unit.id,
        verb: "completed",
        sourceRef: unit.sourceRef,
        position: { page: 9, progressPercent: 100 }
      });
      expect(completed).toEqual([
        expect.objectContaining({
          id: unit.id,
          events: 2,
          openedAt: expect.any(String),
          completedAt: expect.any(String),
          lastPosition: { page: 9, progressPercent: 100 }
        })
      ]);
      expect(await getActiveLearningProgress(value.userId)).toEqual(completed);
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
        recordActiveLearningEvent({
          userId: value.userId,
          unitId: unit.id,
          verb: "opened",
          sourceRef: unit.sourceRef
        })
      ).rejects.toThrow("LEARNING_UNIT_SOURCE_REVOKED");
      await value.db
        .delete(schema.spaceMemberships)
        .where(
          and(
            eq(schema.spaceMemberships.spaceId, value.spaceId),
            eq(schema.spaceMemberships.userId, value.userId)
          )
        );
      await expect(
        recordActiveLearningEvent({
          userId: value.userId,
          unitId: unit.id,
          verb: "opened",
          sourceRef: unit.sourceRef
        })
      ).rejects.toThrow("LEARNING_UNIT_SOURCE_REVOKED");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("orchestrates one immutable course from a confirmed plan without model or Skill execution", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "课程编排计划",
        goal: "完成资料的原文学习",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      expect(course).toMatchObject({
        learningPlanId: active.id,
        status: "active",
        title: "课程编排计划",
        goal: "完成资料的原文学习",
        modules: [
          {
            ordinal: 1,
            title: "原文学习",
            units: [
              {
                planUnitId: active.plan.units[0]?.id,
                resourceVersionId: value.versionId,
                sourceRef: active.plan.units[0]?.sourceRef,
                knowledgePoints: [
                  {
                    resourceVersionId: value.versionId,
                    sourceRef: active.plan.units[0]?.sourceRef
                  }
                ]
              }
            ]
          }
        ]
      });
      await value.db
        .update(schema.resources)
        .set({ name: "课程确认后的资料改名" })
        .where(eq(schema.resources.id, value.resourceId));
      expect((await getActiveLearningCourse(value.userId)).modules[0]?.units[0]?.title).toBe(
        active.plan.units[0]?.title
      );
      expect(await confirmLearningPlan({ planId: draft.id, userId: value.userId })).toMatchObject({
        id: active.id,
        status: "active"
      });
      const rows = await value.db
        .select()
        .from(schema.courses)
        .where(eq(schema.courses.learningPlanId, active.id));
      expect(rows).toHaveLength(1);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("creates source-bound candidate practice only after the fixed plan unit is completed", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "练习候选计划",
        goal: "完成资料学习后进行练习",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const planUnit = active.plan.units[0];
      const courseUnit = course.modules[0]?.units[0];
      if (!planUnit || !courseUnit) throw new Error("TEST_COURSE_UNIT_MISSING");
      await expect(
        createPracticeCandidate({
          userId: value.userId,
          courseUnitIds: [courseUnit.id],
          difficulty: "standard"
        })
      ).rejects.toThrow("PRACTICE_COURSE_UNIT_NOT_COMPLETED");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: planUnit.id,
        verb: "completed",
        sourceRef: planUnit.sourceRef
      });
      const candidate = await createPracticeCandidate({
        userId: value.userId,
        courseUnitIds: [courseUnit.id],
        difficulty: "challenge"
      });
      expect(candidate).toMatchObject({
        courseId: course.id,
        status: "candidate",
        difficulty: "challenge",
        generation: "deterministic_template",
        questions: [
          {
            courseUnitId: courseUnit.id,
            knowledgePointId: courseUnit.knowledgePoints[0]?.id,
            resourceVersionId: value.versionId,
            sourceRef: planUnit.sourceRef,
            version: 1,
            answerType: "free_response"
          }
        ]
      });
      const question = candidate.questions[0];
      if (!question) throw new Error("TEST_PRACTICE_QUESTION_MISSING");
      const firstAttempt = await submitPracticeAttempt({
        userId: value.userId,
        questionId: question.id,
        response: "我结合固定版本原文总结了这个结构重点。"
      });
      expect(firstAttempt).toMatchObject({
        practiceQuestionId: question.id,
        courseUnitId: courseUnit.id,
        knowledgePointId: courseUnit.knowledgePoints[0]?.id,
        resourceVersionId: value.versionId,
        sourceRef: planUnit.sourceRef,
        questionVersion: 1,
        prompt: question.prompt,
        rubric: question.rubric,
        response: "我结合固定版本原文总结了这个结构重点。",
        status: "pending_review"
      });
      await submitPracticeAttempt({
        userId: value.userId,
        questionId: question.id,
        response: "第二次作答保留为独立的历史记录。"
      });
      expect(await getActiveLearningProgressReport(value.userId)).toEqual({
        learningPlanId: active.id,
        courseId: course.id,
        units: { total: 1, completed: 1, completionPercent: 100 },
        practice: {
          candidateSets: 1,
          questions: 1,
          attempts: 2,
          pendingReview: 2,
          objectiveGraded: 0,
          objectiveCorrect: 0,
          objectiveScore: 0,
          objectiveMaximumScore: 0,
          traceableAttempts: 2
        },
        mastery: {
          totalKnowledgePoints: 1,
          gradedKnowledgePoints: 0,
          currentCorrect: 0,
          averagePercent: null,
          items: [
            {
              knowledgePointId: courseUnit.knowledgePoints[0]?.id,
              status: "ungraded",
              correct: null,
              score: null,
              maximumScore: null,
              percent: null,
              updatedAt: null
            }
          ]
        }
      });
      expect((await listPracticeCandidates(value.userId))[0]?.questions[0]?.attempts).toHaveLength(
        2
      );
      const attemptEvents = await value.db
        .select()
        .from(schema.learningEvents)
        .where(
          and(
            eq(schema.learningEvents.verb, "practice.attempt_submitted"),
            eq(schema.learningEvents.userId, value.userId)
          )
        );
      expect(attemptEvents).toHaveLength(2);
      expect(attemptEvents[0]?.context).toMatchObject({
        practiceAttemptId: firstAttempt.id,
        practiceQuestionId: question.id,
        sourceRef: planUnit.sourceRef
      });
      expect(JSON.stringify(attemptEvents[0]?.context)).not.toContain(firstAttempt.response);
      await value.db
        .update(schema.resources)
        .set({ name: "练习后的资料改名" })
        .where(eq(schema.resources.id, value.resourceId));
      expect((await listPracticeCandidates(value.userId))[0]?.questions[0]).toMatchObject({
        resourceVersionId: value.versionId,
        sourceRef: planUnit.sourceRef,
        attempts: expect.arrayContaining([
          expect.objectContaining({
            resourceVersionId: value.versionId,
            sourceRef: planUnit.sourceRef,
            questionVersion: 1
          })
        ])
      });
      expect((await getActiveLearningProgressReport(value.userId)).practice).toMatchObject({
        attempts: 2,
        objectiveGraded: 0,
        traceableAttempts: 2
      });
      await expect(
        createPracticeCandidate({
          userId: value.userId,
          courseUnitIds: [courseUnit.id, courseUnit.id],
          difficulty: "easy"
        })
      ).rejects.toThrow("PRACTICE_COURSE_UNIT_DUPLICATE");
      await expect(
        createPracticeCandidate({
          userId: value.otherUserId,
          courseUnitIds: [courseUnit.id],
          difficulty: "easy"
        })
      ).rejects.toThrow("LEARNING_PLAN_ACTIVE_NOT_FOUND");
      await value.db
        .delete(schema.spaceMemberships)
        .where(
          and(
            eq(schema.spaceMemberships.spaceId, value.spaceId),
            eq(schema.spaceMemberships.userId, value.userId)
          )
        );
      await expect(
        createPracticeCandidate({
          userId: value.userId,
          courseUnitIds: [courseUnit.id],
          difficulty: "easy"
        })
      ).rejects.toThrow("PRACTICE_SOURCE_REVOKED");
      await expect(
        submitPracticeAttempt({
          userId: value.userId,
          questionId: question.id,
          response: "撤权后不能再继续提交。"
        })
      ).rejects.toThrow("PRACTICE_ATTEMPT_SOURCE_REVOKED");
      await expect(getActiveLearningProgressReport(value.userId)).rejects.toThrow(
        "LEARNING_PLAN_SOURCE_REVOKED"
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("materializes a completed practice-generate run only for the current completed course", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "生成练习候选计划",
        goal: "验证生成型候选的课程范围",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const planUnit = active.plan.units[0];
      const courseUnit = course.modules[0]?.units[0];
      const knowledgePoint = courseUnit?.knowledgePoints[0];
      if (!planUnit || !courseUnit || !knowledgePoint)
        throw new Error("TEST_PRACTICE_COURSE_MISSING");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: planUnit.id,
        verb: "completed",
        sourceRef: planUnit.sourceRef
      });
      const session = await createAgentSession({
        userId: value.userId,
        title: "生成练习 Skill",
        bindings: [{ spaceId: value.spaceId, scope: "course", targetId: course.id }]
      });
      const [binding] = await value.db
        .select()
        .from(schema.agentContextBindings)
        .where(eq(schema.agentContextBindings.sessionId, session.id));
      if (!binding) throw new Error("TEST_PRACTICE_COURSE_BINDING_MISSING");
      const [run] = await value.db
        .insert(schema.skillRuns)
        .values({
          sessionId: session.id,
          userId: value.userId,
          skillId: "practice-generate",
          skillVersion: "2.0.0",
          skillDigest: `sha256:${"d".repeat(64)}`,
          bindingIds: [binding.id],
          inputSummary: "已完成单元的脱敏摘要",
          status: "completed",
          completedAt: new Date()
        })
        .returning();
      if (!run) throw new Error("TEST_PRACTICE_GENERATE_RUN_MISSING");
      const [candidate] = await value.db
        .insert(schema.practiceGenerateCandidates)
        .values({
          skillRunId: run.id,
          userId: value.userId,
          candidate: {
            courseId: course.id,
            difficulty: "easy",
            questions: [
              {
                courseUnitId: courseUnit.id,
                knowledgePointId: knowledgePoint.id,
                resourceVersionId: value.versionId,
                sourceRef: planUnit.sourceRef,
                answerType: "exact_response",
                prompt: "根据固定原文写出学习重点。",
                answerKey: "PRIVATE_PRACTICE_ANSWER_KEY",
                rubric: {
                  kind: "exact_response",
                  normalization: "nfkc_trim_casefold_whitespace",
                  maximumScore: 1,
                  note: "按固定答案键确定性判定。"
                }
              }
            ]
          }
        })
        .returning();
      if (!candidate) throw new Error("TEST_PRACTICE_GENERATE_CANDIDATE_MISSING");
      const assessment = await createAssessmentFromPracticeGenerateCandidate({
        userId: value.userId,
        candidateId: candidate.id
      });
      expect(assessment).toMatchObject({
        courseId: course.id,
        status: "draft",
        questions: [
          {
            courseUnitId: courseUnit.id,
            knowledgePointId: knowledgePoint.id,
            resourceVersionId: value.versionId,
            sourceRef: planUnit.sourceRef,
            answerType: "exact_response"
          }
        ]
      });
      const materialized = (await listPracticeCandidates(value.userId))[0];
      if (!materialized) throw new Error("TEST_MATERIALIZED_PRACTICE_SET_MISSING");
      expect(materialized).toMatchObject({
        courseId: course.id,
        status: "candidate",
        generation: "skill_candidate",
        provenance: { skillRunId: run.id, skillVersion: "2.0.0" },
        questions: [
          {
            courseUnitId: courseUnit.id,
            knowledgePointId: knowledgePoint.id,
            resourceVersionId: value.versionId,
            sourceRef: planUnit.sourceRef,
            answerType: "exact_response"
          }
        ]
      });
      expect(JSON.stringify(materialized)).not.toContain("PRIVATE_PRACTICE_ANSWER_KEY");
      const listedCandidate = (await listPracticeGenerateCandidates(value.userId))[0];
      expect(JSON.stringify(listedCandidate)).not.toContain("PRIVATE_PRACTICE_ANSWER_KEY");
      await expect(
        createAssessmentFromPracticeGenerateCandidate({
          userId: value.userId,
          candidateId: candidate.id
        })
      ).resolves.toMatchObject({ id: assessment.id });
      await expect(
        materializePracticeGenerateCandidate({ userId: value.userId, candidateId: candidate.id })
      ).rejects.toThrow("PRACTICE_GENERATE_CANDIDATE_ALREADY_MATERIALIZED");
      const [invalidRun] = await value.db
        .insert(schema.skillRuns)
        .values({
          sessionId: session.id,
          userId: value.userId,
          skillId: "practice-generate",
          skillVersion: "2.0.1",
          skillDigest: `sha256:${"e".repeat(64)}`,
          bindingIds: [binding.id],
          inputSummary: "错误来源候选",
          status: "completed",
          completedAt: new Date()
        })
        .returning();
      if (!invalidRun) throw new Error("TEST_INVALID_PRACTICE_GENERATE_RUN_MISSING");
      const [invalidCandidate] = await value.db
        .insert(schema.practiceGenerateCandidates)
        .values({
          skillRunId: invalidRun.id,
          userId: value.userId,
          candidate: {
            courseId: course.id,
            difficulty: "standard",
            questions: [
              {
                courseUnitId: courseUnit.id,
                knowledgePointId: knowledgePoint.id,
                resourceVersionId: value.versionId,
                sourceRef: `wk://source/${value.versionId}/eyJ0eXBlIjoiZG9jdW1lbnQiLCJyZXNvdXJjZVZlcnNpb25JZCI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsIm5vZGVJZCI6ImZvcmdlZCJ9`,
                answerType: "free_response",
                prompt: "来源错误的候选题。",
                rubric: {
                  kind: "free_response",
                  criteria: ["可回查原文"],
                  maximumScore: 3,
                  note: "等待人工复核。"
                }
              }
            ]
          }
        })
        .returning();
      if (!invalidCandidate) throw new Error("TEST_INVALID_PRACTICE_GENERATE_CANDIDATE_MISSING");
      await expect(
        materializePracticeGenerateCandidate({
          userId: value.userId,
          candidateId: invalidCandidate.id
        })
      ).rejects.toThrow("PRACTICE_GENERATE_SOURCE_DENIED");
      expect(await listPracticeCandidates(value.userId)).toHaveLength(1);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("grades exact-response candidates from hidden immutable answer-key snapshots", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "客观回顾计划",
        goal: "验证确定性评分",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const planUnit = active.plan.units[0];
      const courseUnit = course.modules[0]?.units[0];
      if (!planUnit || !courseUnit) throw new Error("TEST_OBJECTIVE_COURSE_UNIT_MISSING");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: planUnit.id,
        verb: "completed",
        sourceRef: planUnit.sourceRef
      });
      const candidate = await createPracticeCandidate({
        userId: value.userId,
        courseUnitIds: [courseUnit.id],
        difficulty: "easy"
      });
      const question = candidate.questions[0];
      const point = courseUnit.knowledgePoints[0];
      if (!question || !point) throw new Error("TEST_OBJECTIVE_QUESTION_MISSING");
      expect(question).toMatchObject({
        answerType: "exact_response",
        rubric: {
          kind: "exact_response",
          normalization: "nfkc_trim_casefold_whitespace",
          maximumScore: 1
        }
      });
      expect("answerKey" in question).toBe(false);
      const correct = await submitPracticeAttempt({
        userId: value.userId,
        questionId: question.id,
        response: `  ${point.statement.toUpperCase()}  `
      });
      expect(correct).toMatchObject({
        status: "graded",
        grade: {
          grader: "objective_rule",
          ruleVersion: "exact_response.v1",
          score: 1,
          maximumScore: 1,
          correct: true
        }
      });
      const incorrect = await submitPracticeAttempt({
        userId: value.userId,
        questionId: question.id,
        response: "与受管答案键不同的回答"
      });
      expect(incorrect).toMatchObject({
        status: "graded",
        grade: { score: 0, maximumScore: 1, correct: false }
      });
      const attempts = (await listPracticeCandidates(value.userId))[0]?.questions[0]?.attempts;
      expect(attempts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: correct.id,
            status: "graded",
            grade: expect.objectContaining({ score: 1 })
          }),
          expect.objectContaining({
            id: incorrect.id,
            status: "graded",
            grade: expect.objectContaining({ score: 0 })
          })
        ])
      );
      expect(attempts?.every((attempt) => !("answerKey" in attempt))).toBe(true);
      const grades = await value.db
        .select()
        .from(schema.practiceGrades)
        .where(eq(schema.practiceGrades.attemptId, correct.id));
      expect(grades).toHaveLength(1);
      const [attemptSnapshot] = await value.db
        .select()
        .from(schema.practiceAttempts)
        .where(eq(schema.practiceAttempts.id, correct.id));
      expect(attemptSnapshot?.answerKey).toBe(point.statement);
      const snapshots = await value.db
        .select()
        .from(schema.masterySnapshots)
        .where(eq(schema.masterySnapshots.userId, value.userId));
      expect(snapshots).toHaveLength(2);
      expect(snapshots.map(({ evidence }) => evidence)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            schemaVersion: 1,
            courseId: course.id,
            knowledgePointId: point.id,
            attemptType: "practice"
          })
        ])
      );
      expect(JSON.stringify(snapshots)).not.toContain(point.statement);
      expect(JSON.stringify(snapshots)).not.toContain("与受管答案键不同的回答");
      expect(await getActiveLearningProgressReport(value.userId)).toMatchObject({
        practice: {
          attempts: 2,
          pendingReview: 0,
          objectiveGraded: 2,
          objectiveCorrect: 1,
          objectiveScore: 1,
          objectiveMaximumScore: 2
        },
        mastery: {
          totalKnowledgePoints: 1,
          gradedKnowledgePoints: 1,
          currentCorrect: 0,
          averagePercent: 0,
          items: [
            expect.objectContaining({
              knowledgePointId: point.id,
              status: "graded",
              score: 0,
              maximumScore: 1,
              percent: 0,
              correct: false
            })
          ]
        }
      });
      expect(await listActivePracticeMistakeReviews(value.userId)).toEqual([
        expect.objectContaining({
          practiceQuestionId: question.id,
          practiceAttemptId: incorrect.id,
          resourceVersionId: value.versionId,
          sourceRef: planUnit.sourceRef,
          prompt: question.prompt,
          response: "与受管答案键不同的回答",
          grade: expect.objectContaining({ score: 0, correct: false })
        })
      ]);
      const corrected = await submitPracticeAttempt({
        userId: value.userId,
        questionId: question.id,
        response: point.statement
      });
      expect(corrected.grade).toMatchObject({ score: 1, correct: true });
      expect((await getActiveLearningProgressReport(value.userId)).mastery).toMatchObject({
        gradedKnowledgePoints: 1,
        currentCorrect: 1,
        averagePercent: 100,
        items: [
          expect.objectContaining({ knowledgePointId: point.id, correct: true, percent: 100 })
        ]
      });
      expect(await listActivePracticeMistakeReviews(value.userId)).toEqual([]);
      const gradingEvents = await value.db
        .select()
        .from(schema.learningEvents)
        .where(
          and(
            eq(schema.learningEvents.userId, value.userId),
            eq(schema.learningEvents.verb, "practice.attempt_graded")
          )
        );
      expect(gradingEvents).toHaveLength(3);
      expect(JSON.stringify(gradingEvents)).not.toContain(point.statement);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("freezes a completed candidate as a single-attempt formal assessment", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "正式测评计划",
        goal: "确认候选题卷后完成一次可追溯测评",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const planUnit = active.plan.units[0];
      const courseUnit = course.modules[0]?.units[0];
      const point = courseUnit?.knowledgePoints[0];
      if (!planUnit || !courseUnit || !point)
        throw new Error("TEST_ASSESSMENT_COURSE_UNIT_MISSING");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: planUnit.id,
        verb: "completed",
        sourceRef: planUnit.sourceRef
      });
      const candidate = await createPracticeCandidate({
        userId: value.userId,
        courseUnitIds: [courseUnit.id],
        difficulty: "easy"
      });
      const candidateQuestion = candidate.questions[0];
      if (!candidateQuestion) throw new Error("TEST_ASSESSMENT_CANDIDATE_QUESTION_MISSING");

      const assessment = await createAssessment({
        userId: value.userId,
        practiceSetId: candidate.id
      });
      expect(assessment).toMatchObject({
        courseId: course.id,
        practiceSetId: candidate.id,
        status: "draft",
        questions: [
          {
            ordinal: 1,
            courseUnitId: courseUnit.id,
            resourceVersionId: value.versionId,
            sourceRef: planUnit.sourceRef,
            prompt: candidateQuestion.prompt,
            attempts: []
          }
        ]
      });
      expect("answerKey" in assessment.questions[0]!).toBe(false);
      expect(
        (await createAssessment({ userId: value.userId, practiceSetId: candidate.id })).id
      ).toBe(assessment.id);
      expect(await listAssessments(value.userId)).toEqual([
        expect.objectContaining({ id: assessment.id, status: "draft" })
      ]);

      await value.db
        .update(schema.practiceSets)
        .set({ status: "archived" })
        .where(eq(schema.practiceSets.id, candidate.id));
      await value.db
        .update(schema.practiceQuestions)
        .set({ prompt: "不应改变正式题卷的候选题提示" })
        .where(eq(schema.practiceQuestions.id, candidateQuestion.id));
      await value.db
        .update(schema.resources)
        .set({ name: "测评之后资料改名" })
        .where(eq(schema.resources.id, value.resourceId));

      const started = await startAssessment({ assessmentId: assessment.id, userId: value.userId });
      const question = started.questions[0];
      if (!question) throw new Error("TEST_ASSESSMENT_QUESTION_MISSING");
      expect(started).toMatchObject({
        status: "active",
        questions: [expect.objectContaining({ prompt: candidateQuestion.prompt })]
      });
      const correct = await submitAssessmentAttempt({
        userId: value.userId,
        assessmentId: assessment.id,
        assessmentQuestionId: question.id,
        response: ` ${point.statement.toUpperCase()} `
      });
      expect(correct).toMatchObject({
        assessmentQuestionId: question.id,
        courseUnitId: courseUnit.id,
        resourceVersionId: value.versionId,
        sourceRef: planUnit.sourceRef,
        status: "graded",
        grade: { score: 1, maximumScore: 1, correct: true }
      });
      await expect(
        submitAssessmentAttempt({
          userId: value.userId,
          assessmentId: assessment.id,
          assessmentQuestionId: question.id,
          response: point.statement
        })
      ).rejects.toThrow("ASSESSMENT_QUESTION_ALREADY_ANSWERED");
      const submitted = await submitAssessment({
        assessmentId: assessment.id,
        userId: value.userId
      });
      expect(submitted).toMatchObject({
        status: "submitted",
        questions: [
          expect.objectContaining({ attempts: [expect.objectContaining({ id: correct.id })] })
        ]
      });
      await expect(
        startAssessment({ assessmentId: assessment.id, userId: value.userId })
      ).rejects.toThrow("ASSESSMENT_ALREADY_SUBMITTED");
      await expect(
        submitAssessmentAttempt({
          userId: value.userId,
          assessmentId: assessment.id,
          assessmentQuestionId: question.id,
          response: point.statement
        })
      ).rejects.toThrow("ASSESSMENT_NOT_ACTIVE");
      const events = await value.db
        .select()
        .from(schema.learningEvents)
        .where(eq(schema.learningEvents.userId, value.userId));
      expect(events.map(({ verb }) => verb)).toEqual(
        expect.arrayContaining([
          "assessment.created",
          "assessment.started",
          "assessment.attempt_submitted",
          "assessment.attempt_graded",
          "assessment.submitted"
        ])
      );
      expect(JSON.stringify(events)).not.toContain(point.statement);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("allows an organization admin to grade only frozen pending free responses", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "人工复核计划",
        goal: "验证固定量表的人工评分边界",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const planUnit = active.plan.units[0];
      const courseUnit = course.modules[0]?.units[0];
      if (!planUnit || !courseUnit) throw new Error("TEST_MANUAL_REVIEW_COURSE_UNIT_MISSING");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: planUnit.id,
        verb: "completed",
        sourceRef: planUnit.sourceRef
      });
      const candidate = await createPracticeCandidate({
        userId: value.userId,
        courseUnitIds: [courseUnit.id],
        difficulty: "standard"
      });
      const question = candidate.questions[0];
      if (!question) throw new Error("TEST_MANUAL_REVIEW_QUESTION_MISSING");
      const attempt = await submitPracticeAttempt({
        userId: value.userId,
        questionId: question.id,
        response: "我根据固定原文解释了关键概念与适用边界。"
      });
      expect(attempt).toMatchObject({ status: "pending_review", grade: null });
      expect(await listManualFreeResponseReviews(value.organizationId)).toEqual([
        expect.objectContaining({
          attemptType: "practice",
          attemptId: attempt.id,
          learnerUserId: value.userId,
          resourceVersionId: value.versionId,
          sourceRef: planUnit.sourceRef,
          rubric: expect.objectContaining({ kind: "free_response", maximumScore: 3 })
        })
      ]);
      await expect(
        submitManualFreeResponseReview({
          organizationId: randomUUID(),
          reviewerUserId: value.userId,
          attemptId: attempt.id,
          attemptType: "practice",
          score: 2,
          rationale: "跨组织不能评分。"
        })
      ).rejects.toThrow("MANUAL_REVIEW_ATTEMPT_NOT_FOUND");
      await expect(
        submitManualFreeResponseReview({
          organizationId: value.organizationId,
          reviewerUserId: value.userId,
          attemptId: attempt.id,
          attemptType: "practice",
          score: 4,
          rationale: "不能超过冻结量表。"
        })
      ).rejects.toThrow("MANUAL_REVIEW_SCORE_INVALID");
      const reviewed = await submitManualFreeResponseReview({
        organizationId: value.organizationId,
        reviewerUserId: value.userId,
        attemptId: attempt.id,
        attemptType: "practice",
        score: 2,
        rationale: "准确覆盖重点，但适用边界说明仍可更完整。"
      });
      expect(reviewed).toMatchObject({
        attemptType: "practice",
        attemptId: attempt.id,
        grade: {
          grader: "human_review",
          ruleVersion: "manual_rubric.v1",
          score: 2,
          maximumScore: 3,
          correct: false,
          reviewerUserId: value.userId
        }
      });
      await expect(
        submitManualFreeResponseReview({
          organizationId: value.organizationId,
          reviewerUserId: value.userId,
          attemptId: attempt.id,
          attemptType: "practice",
          score: 3,
          rationale: "第二次不得覆盖历史评分。"
        })
      ).rejects.toThrow("MANUAL_REVIEW_ALREADY_GRADED");
      expect(await listManualFreeResponseReviews(value.organizationId)).toEqual([]);
      const [grade] = await value.db
        .select()
        .from(schema.practiceGrades)
        .where(eq(schema.practiceGrades.attemptId, attempt.id));
      expect(grade).toMatchObject({
        grader: "human_review",
        ruleVersion: "manual_rubric.v1",
        rationale: "准确覆盖重点，但适用边界说明仍可更完整。",
        reviewerUserId: value.userId
      });
      const events = await value.db
        .select()
        .from(schema.learningEvents)
        .where(eq(schema.learningEvents.userId, value.userId));
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            actor: "instructor",
            verb: "practice.attempt_manually_graded",
            result: { score: 2, maximumScore: 3, grader: "human_review" }
          })
        ])
      );
      expect(JSON.stringify(events)).not.toContain("准确覆盖重点，但适用边界说明仍可更完整。");

      const formalCandidate = await createPracticeCandidate({
        userId: value.userId,
        courseUnitIds: [courseUnit.id],
        difficulty: "standard"
      });
      const assessment = await createAssessment({
        userId: value.userId,
        practiceSetId: formalCandidate.id
      });
      const activeAssessment = await startAssessment({
        assessmentId: assessment.id,
        userId: value.userId
      });
      const formalQuestion = activeAssessment.questions[0];
      if (!formalQuestion) throw new Error("TEST_MANUAL_REVIEW_ASSESSMENT_QUESTION_MISSING");
      const formalAttempt = await submitAssessmentAttempt({
        userId: value.userId,
        assessmentId: assessment.id,
        assessmentQuestionId: formalQuestion.id,
        response: "我把知识点与适用条件逐项对应到了固定原文。"
      });
      expect(await listManualFreeResponseReviews(value.organizationId)).toEqual([
        expect.objectContaining({ attemptType: "assessment", attemptId: formalAttempt.id })
      ]);
      const formalReviewed = await submitManualFreeResponseReview({
        organizationId: value.organizationId,
        reviewerUserId: value.userId,
        attemptId: formalAttempt.id,
        attemptType: "assessment",
        score: 3,
        rationale: "覆盖了量表中的全部关键点，并清楚说明了适用条件。"
      });
      expect(formalReviewed.grade).toMatchObject({
        grader: "human_review",
        maximumScore: 3,
        score: 3,
        correct: true
      });
      expect(
        await value.db
          .select()
          .from(schema.masterySnapshots)
          .where(eq(schema.masterySnapshots.gradeId, formalReviewed.grade.id))
      ).toEqual([
        expect.objectContaining({
          userId: value.userId,
          knowledgePointId: formalQuestion.knowledgePointId,
          score: 1,
          evidence: expect.objectContaining({
            attemptType: "assessment",
            grader: "human_review",
            score: 3,
            maximumScore: 3
          })
        })
      ]);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("fails closed for active learning, practice, assessment, and reports after membership is disabled", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "撤权学习计划",
        goal: "验证学习资料撤权",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const unit = active.plan.units[0];
      const courseUnit = course.modules[0]?.units[0];
      if (!unit || !courseUnit) throw new Error("TEST_REVOKED_LEARNING_UNIT_MISSING");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: unit.id,
        verb: "completed",
        sourceRef: unit.sourceRef
      });
      const practice = await createPracticeCandidate({
        userId: value.userId,
        courseUnitIds: [courseUnit.id],
        difficulty: "easy"
      });
      await createAssessment({ userId: value.userId, practiceSetId: practice.id });
      const snapshot = await createActiveLearningReportSnapshot(value.userId);

      await value.db
        .update(schema.organizationMemberships)
        .set({ disabled: true })
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, value.organizationId),
            eq(schema.organizationMemberships.userId, value.userId)
          )
        );

      await expect(getActiveLearningPlan(value.userId)).rejects.toThrow(
        "LEARNING_PLAN_SOURCE_REVOKED"
      );
      await expect(getActiveLearningCourse(value.userId)).rejects.toThrow(
        "LEARNING_PLAN_SOURCE_REVOKED"
      );
      await expect(getActiveLearningProgress(value.userId)).rejects.toThrow(
        "LEARNING_PLAN_SOURCE_REVOKED"
      );
      await expect(listPracticeCandidates(value.userId)).rejects.toThrow("PRACTICE_SOURCE_REVOKED");
      await expect(listAssessments(value.userId)).rejects.toThrow("ASSESSMENT_SOURCE_REVOKED");
      await expect(
        createPracticeCandidate({
          userId: value.userId,
          courseUnitIds: [courseUnit.id],
          difficulty: "easy"
        })
      ).rejects.toThrow("PRACTICE_SOURCE_REVOKED");
      await expect(getActiveLearningProgressReport(value.userId)).rejects.toThrow(
        "LEARNING_PLAN_SOURCE_REVOKED"
      );
      await expect(
        getLearningReportSnapshot({ snapshotId: snapshot.id, userId: value.userId })
      ).rejects.toThrow("LEARNING_REPORT_SOURCE_REVOKED");
      await expect(listLearningReportSnapshots({ userId: value.userId })).rejects.toThrow(
        "LEARNING_REPORT_SOURCE_REVOKED"
      );
      await expect(claimLearningReportSnapshot(snapshot.id)).rejects.toThrow(
        "LEARNING_REPORT_SOURCE_REVOKED"
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("freezes an active report snapshot once and keeps it private and immutable", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "报告快照计划",
        goal: "验证报告导出",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const unit = active.plan.units[0];
      if (!unit) throw new Error("TEST_REPORT_PLAN_UNIT_MISSING");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: unit.id,
        verb: "completed",
        sourceRef: unit.sourceRef
      });
      const first = await createActiveLearningReportSnapshot(value.userId);
      const duplicate = await createActiveLearningReportSnapshot(value.userId);
      expect(first).toMatchObject({
        learningPlanId: active.id,
        courseId: course.id,
        status: "queued",
        report: { units: { total: 1, completed: 1, completionPercent: 100 } },
        artifacts: []
      });
      expect(duplicate.id).toBe(first.id);
      expect(
        await getLearningReportSnapshot({ snapshotId: first.id, userId: value.userId })
      ).toMatchObject({ id: first.id, report: first.report, status: "queued" });
      await expect(
        getLearningReportSnapshot({ snapshotId: first.id, userId: value.otherUserId })
      ).rejects.toThrow("LEARNING_REPORT_SNAPSHOT_NOT_FOUND");
      await expect(
        getLearningReportArtifact({ snapshotId: first.id, userId: value.userId, format: "png" })
      ).rejects.toThrow("LEARNING_REPORT_ARTIFACT_NOT_READY");
      const [outbox] = await value.db
        .select()
        .from(schema.learningReportOutbox)
        .where(eq(schema.learningReportOutbox.snapshotId, first.id));
      expect(outbox).toMatchObject({ status: "pending", attemptCount: 0 });
      const claimed = await claimLearningReportSnapshot(first.id);
      if (!claimed) throw new Error("TEST_REPORT_SNAPSHOT_NOT_CLAIMED");
      expect(claimed.report).toEqual(first.report);
      await expect(
        completeLearningReportSnapshot({
          snapshotId: first.id,
          token: claimed.token,
          artifacts: [
            {
              format: "png",
              blobUri: "not-a-uri",
              sha256: "a".repeat(64),
              byteSize: 128
            },
            {
              format: "pdf",
              blobUri: `local://learning-reports/${first.id}/report.pdf`,
              sha256: "b".repeat(64),
              byteSize: 0
            }
          ]
        })
      ).rejects.toThrow("LEARNING_REPORT_ARTIFACT_METADATA_INVALID");
      await completeLearningReportSnapshot({
        snapshotId: first.id,
        token: claimed.token,
        artifacts: [
          {
            format: "png",
            blobUri: `local://learning-reports/${first.id}/report.png`,
            sha256: "a".repeat(64),
            byteSize: 128
          },
          {
            format: "pdf",
            blobUri: `local://learning-reports/${first.id}/report.pdf`,
            sha256: "b".repeat(64),
            byteSize: 256
          }
        ]
      });
      expect(
        await getLearningReportSnapshot({ snapshotId: first.id, userId: value.userId })
      ).toMatchObject({
        status: "completed",
        report: first.report,
        artifacts: [{ format: "png" }, { format: "pdf" }]
      });
      expect(
        await getLearningReportArtifact({
          snapshotId: first.id,
          userId: value.userId,
          format: "png"
        })
      ).toMatchObject({
        blobUri: `local://learning-reports/${first.id}/report.png`,
        byteSize: 128
      });
      expect(JSON.stringify(first)).not.toContain("学习材料.pdf");
      expect(JSON.stringify(first)).not.toContain("wk://source/");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("lists only the learner's frozen report snapshots from newest to oldest", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "历史报告计划",
        goal: "验证历史报告",
        resourceVersionIds: [value.versionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const first = await createActiveLearningReportSnapshot(value.userId);
      await value.db
        .update(schema.learningReportSnapshots)
        .set({ status: "completed", createdAt: new Date("2026-08-14T00:00:00.000Z") })
        .where(eq(schema.learningReportSnapshots.id, first.id));
      const [second] = await value.db
        .insert(schema.learningReportSnapshots)
        .values({
          userId: value.userId,
          learningPlanId: active.id,
          courseId: first.courseId,
          report: first.report,
          status: "completed",
          createdAt: new Date("2026-08-14T00:01:00.000Z")
        })
        .returning();
      if (!second) throw new Error("TEST_REPORT_SNAPSHOT_CREATE_FAILED");
      await value.db.insert(schema.learningReportSnapshots).values({
        userId: value.otherUserId,
        learningPlanId: active.id,
        courseId: first.courseId,
        report: first.report,
        status: "completed"
      });
      const snapshots = await listLearningReportSnapshots({ userId: value.userId });
      expect(snapshots.map(({ id }) => id)).toEqual([second.id, first.id]);
      expect(snapshots.every((snapshot) => snapshot.report.learningPlanId === active.id)).toBe(
        true
      );
      await expect(listLearningReportSnapshots({ userId: value.otherUserId })).rejects.toThrow(
        "LEARNING_REPORT_SOURCE_REVOKED"
      );
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("dispatches a queued report snapshot exactly once through its outbox", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "报告投递计划",
        goal: "验证报告队列",
        resourceVersionIds: [value.versionId]
      });
      await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const snapshot = await createActiveLearningReportSnapshot(value.userId);
      const published: string[] = [];
      expect(
        await dispatchPendingLearningReportOutbox(
          {
            async publish(name, payload) {
              expect(name).toBe("learning.report.render");
              published.push(payload.snapshotId);
              return randomUUID();
            }
          },
          25,
          30_000,
          snapshot.id
        )
      ).toEqual({ dispatched: 1, failed: 0 });
      expect(published).toEqual([snapshot.id]);
      expect(
        await dispatchPendingLearningReportOutbox(
          {
            async publish() {
              throw new Error("UNEXPECTED_SECOND_REPORT_PUBLISH");
            }
          },
          25,
          30_000,
          snapshot.id
        )
      ).toEqual({ dispatched: 0, failed: 0 });
      const [outbox] = await value.db
        .select()
        .from(schema.learningReportOutbox)
        .where(eq(schema.learningReportOutbox.snapshotId, snapshot.id));
      expect(outbox).toMatchObject({ status: "sent", attemptCount: 1 });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
