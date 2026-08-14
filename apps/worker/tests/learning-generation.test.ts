import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { ManagedSkill } from "@wknowledge/contracts";
import {
  confirmLearningPlan,
  createLearningPlanDraft,
  getActiveLearningCourse,
  queuePlanComposeGeneration,
  queuePracticeGenerateGeneration,
  recordActiveLearningEvent
} from "@wknowledge/core";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import { ModelGateway, type ModelProvider } from "@wknowledge/model-gateway";
import { locatorRef } from "@wknowledge/wiki";
import {
  executeManagedPlanComposeRun,
  executeManagedPracticeGenerateRun
} from "../src/learning-generation";

const test = process.env.DATABASE_URL ? it : it.skip;

const planComposeSkill: ManagedSkill = {
  id: "plan-compose",
  version: "1.0.0",
  digest: "sha256:4d753db4e80a55ffbd890b8e0ca05d422b329653eb6bc3a1d1ed3fd674a8f40a",
  description: "生成计划候选",
  enabled: true,
  requiredCapabilities: ["chat"],
  permissions: {
    resources: "selected",
    filesystem: "none",
    network: "deny",
    approval: "never"
  },
  limits: { timeoutSeconds: 120, memoryMb: 256, maxModelCalls: 1 },
  origin: "builtin"
};

const practiceGenerateSkill: ManagedSkill = {
  id: "practice-generate",
  version: "1.0.0",
  digest: "sha256:8cac2302dc3ac2da32ab2c3e50de4ac7b2e1a5bf4c22b55cb9c8d32ca6cdd468",
  description: "生成针对性练习候选",
  enabled: true,
  requiredCapabilities: ["chat"],
  permissions: {
    resources: "selected",
    filesystem: "none",
    network: "deny",
    approval: "never"
  },
  limits: { timeoutSeconds: 120, memoryMb: 256, maxModelCalls: 1 },
  origin: "builtin"
};

async function fixture(dataPolicy: "local_only" | "cloud_allowed_after_redaction" = "local_only") {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const resourceId = randomUUID();
  const resourceVersionId = randomUUID();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-learning-generation-"));
  await db.insert(schema.organizations).values({ id: organizationId, name: "受管学习生成测试" });
  await db.insert(schema.users).values({
    id: userId,
    email: `learning-generation-${userId}@example.com`,
    name: "学习生成用户",
    passwordHash: "not-used"
  });
  await db
    .insert(schema.organizationMemberships)
    .values({ organizationId, userId, role: "learner" });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "敏感资料空间",
    dataPolicy,
    createdBy: userId
  });
  await db.insert(schema.spaceMemberships).values({ spaceId, userId, role: "learner" });
  await db.insert(schema.resources).values({
    id: resourceId,
    spaceId,
    name: "不应泄露的内部资料名称",
    status: "ready",
    createdBy: userId
  });
  await db.insert(schema.resourceVersions).values({
    id: resourceVersionId,
    resourceId,
    version: 1,
    originalName: "internal-material.md",
    mimeType: "text/markdown",
    byteSize: 64,
    sha256: randomUUID().replaceAll("-", ""),
    blobUri: `local://tests/${resourceVersionId}/source.md`,
    compileProfile: "knowledge",
    createdBy: userId
  });
  await mkdir(path.join(dataRoot, spaceId, "compiled", resourceVersionId), { recursive: true });
  await writeFile(
    path.join(dataRoot, spaceId, "compiled", resourceVersionId, "content.md"),
    "# 学习资料\n这里是可供本地模型使用的摘要。"
  );
  return { db, organizationId, userId, spaceId, resourceVersionId, dataRoot };
}

function gatewayFor(provider: ModelProvider) {
  const gateway = new ModelGateway();
  gateway.register(provider);
  return async () => gateway;
}

afterAll(async () => closeDatabase());

describe("managed plan-compose worker", () => {
  test("writes only a source-bound candidate and a redacted run summary", async () => {
    const value = await fixture();
    try {
      const goal = "完成内部资料的入门学习";
      const run = await queuePlanComposeGeneration({
        userId: value.userId,
        skill: planComposeSkill,
        goal,
        resourceVersionIds: [value.resourceVersionId]
      });
      const sourceRef = locatorRef({
        type: "document",
        resourceVersionId: value.resourceVersionId,
        nodeId: "learning-original"
      });
      const provider: ModelProvider = {
        id: "local-provider",
        location: "local",
        capabilities: new Set(["chat"]),
        healthcheck: async () => true,
        invoke: vi.fn(async () => ({
          providerId: "local-provider",
          model: "local-test",
          durationMs: 2,
          output: JSON.stringify({
            title: "入门学习计划",
            units: [
              {
                title: "阅读资料",
                resourceVersionId: value.resourceVersionId,
                sourceRef,
                objective: "理解资料的重点",
                completionRule: "完成阅读并记录要点"
              }
            ]
          })
        }))
      };
      const result = await executeManagedPlanComposeRun({
        skillRunId: run.id,
        dataRoot: value.dataRoot,
        builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin"),
        gatewayFactory: gatewayFor(provider)
      });
      expect(result).toMatchObject({ handled: true, status: "completed" });
      const [storedRun] = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.id, run.id));
      expect(storedRun?.outputSummary).toMatchObject({
        providerId: "local-provider",
        modelCalls: 1,
        candidateUnits: 1
      });
      expect(JSON.stringify(storedRun?.outputSummary)).not.toContain(goal);
      const [candidate] = await value.db
        .select()
        .from(schema.planComposeCandidates)
        .where(eq(schema.planComposeCandidates.skillRunId, run.id));
      expect(candidate?.candidate).toMatchObject({ title: "入门学习计划" });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  });

  test("redacts goal, file name and compiled text before routing to a cloud provider", async () => {
    const value = await fixture("cloud_allowed_after_redaction");
    try {
      const goal = "不应发送到云端的个人学习目标";
      const run = await queuePlanComposeGeneration({
        userId: value.userId,
        skill: planComposeSkill,
        goal,
        resourceVersionIds: [value.resourceVersionId]
      });
      const sourceRef = locatorRef({
        type: "document",
        resourceVersionId: value.resourceVersionId,
        nodeId: "learning-original"
      });
      const provider: ModelProvider = {
        id: "cloud-provider",
        location: "cloud",
        capabilities: new Set(["chat"]),
        healthcheck: async () => true,
        invoke: vi.fn(async () => ({
          providerId: "cloud-provider",
          model: "cloud-test",
          durationMs: 2,
          output: JSON.stringify({
            title: "基础学习计划",
            units: [
              {
                title: "学习资料",
                resourceVersionId: value.resourceVersionId,
                sourceRef,
                objective: "理解资料内容",
                completionRule: "完成阅读"
              }
            ]
          })
        }))
      };
      await expect(
        executeManagedPlanComposeRun({
          skillRunId: run.id,
          dataRoot: value.dataRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin"),
          gatewayFactory: gatewayFor(provider)
        })
      ).resolves.toMatchObject({ handled: true, status: "completed" });
      const payload = (provider.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.payload;
      const sent = JSON.stringify(payload);
      expect(sent).not.toContain(goal);
      expect(sent).not.toContain("不应泄露的内部资料名称");
      expect(sent).not.toContain("这里是可供本地模型使用的摘要");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  });
});

describe("managed practice-generate worker", () => {
  test("writes only a completed-unit, source-bound candidate and a redacted run summary", async () => {
    const value = await fixture();
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "练习生成验收计划",
        goal: "完成资料后生成针对性练习",
        resourceVersionIds: [value.resourceVersionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const planUnit = active.plan.units[0];
      const courseUnit = course.modules[0]?.units[0];
      const knowledgePoint = courseUnit?.knowledgePoints[0];
      if (!planUnit || !courseUnit || !knowledgePoint)
        throw new Error("TEST_PRACTICE_GENERATE_COURSE_MISSING");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: planUnit.id,
        verb: "completed",
        sourceRef: planUnit.sourceRef
      });
      const run = await queuePracticeGenerateGeneration({
        userId: value.userId,
        skill: practiceGenerateSkill,
        courseUnitIds: [courseUnit.id],
        difficulty: "standard"
      });
      const provider: ModelProvider = {
        id: "local-provider",
        location: "local",
        capabilities: new Set(["chat"]),
        healthcheck: async () => true,
        invoke: vi.fn(async () => ({
          providerId: "local-provider",
          model: "local-test",
          durationMs: 2,
          output: JSON.stringify({
            courseId: course.id,
            difficulty: "standard",
            questions: [
              {
                courseUnitId: courseUnit.id,
                knowledgePointId: knowledgePoint.id,
                resourceVersionId: value.resourceVersionId,
                sourceRef: planUnit.sourceRef,
                answerType: "free_response",
                prompt: "请结合固定原文说明这个学习重点。",
                rubric: {
                  kind: "free_response",
                  criteria: ["表述准确", "能回到固定原文"],
                  maximumScore: 3,
                  note: "依据量表等待人工复核。"
                }
              }
            ]
          })
        }))
      };
      await expect(
        executeManagedPracticeGenerateRun({
          skillRunId: run.id,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin"),
          gatewayFactory: gatewayFor(provider)
        })
      ).resolves.toMatchObject({ handled: true, status: "completed" });
      const [storedRun] = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.id, run.id));
      expect(storedRun?.outputSummary).toMatchObject({
        providerId: "local-provider",
        modelCalls: 1,
        candidateQuestions: 1
      });
      expect(JSON.stringify(storedRun?.outputSummary)).not.toContain("固定原文");
      const [candidate] = await value.db
        .select()
        .from(schema.practiceGenerateCandidates)
        .where(eq(schema.practiceGenerateCandidates.skillRunId, run.id));
      expect(candidate?.candidate).toMatchObject({
        courseId: course.id,
        difficulty: "standard",
        questions: [
          {
            courseUnitId: courseUnit.id,
            knowledgePointId: knowledgePoint.id,
            resourceVersionId: value.resourceVersionId,
            sourceRef: planUnit.sourceRef
          }
        ]
      });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  });

  test("redacts course-unit titles and knowledge-point statements before routing to a cloud provider", async () => {
    const value = await fixture("cloud_allowed_after_redaction");
    try {
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "不应发送到云端的课程标题",
        goal: "不应发送到云端的学习目标",
        resourceVersionIds: [value.resourceVersionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const planUnit = active.plan.units[0];
      const courseUnit = course.modules[0]?.units[0];
      const knowledgePoint = courseUnit?.knowledgePoints[0];
      if (!planUnit || !courseUnit || !knowledgePoint)
        throw new Error("TEST_PRACTICE_GENERATE_CLOUD_COURSE_MISSING");
      await recordActiveLearningEvent({
        userId: value.userId,
        unitId: planUnit.id,
        verb: "completed",
        sourceRef: planUnit.sourceRef
      });
      const run = await queuePracticeGenerateGeneration({
        userId: value.userId,
        skill: practiceGenerateSkill,
        courseUnitIds: [courseUnit.id],
        difficulty: "easy"
      });
      const provider: ModelProvider = {
        id: "cloud-provider",
        location: "cloud",
        capabilities: new Set(["chat"]),
        healthcheck: async () => true,
        invoke: vi.fn(async () => ({
          providerId: "cloud-provider",
          model: "cloud-test",
          durationMs: 2,
          output: JSON.stringify({
            courseId: course.id,
            difficulty: "easy",
            questions: [
              {
                courseUnitId: courseUnit.id,
                knowledgePointId: knowledgePoint.id,
                resourceVersionId: value.resourceVersionId,
                sourceRef: planUnit.sourceRef,
                answerType: "exact_response",
                prompt: "请写出该学习重点。",
                answerKey: "仅供受管候选保存的答案键",
                rubric: {
                  kind: "exact_response",
                  normalization: "nfkc_trim_casefold_whitespace",
                  maximumScore: 1,
                  note: "按固定答案键判定。"
                }
              }
            ]
          })
        }))
      };
      await expect(
        executeManagedPracticeGenerateRun({
          skillRunId: run.id,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin"),
          gatewayFactory: gatewayFor(provider)
        })
      ).resolves.toMatchObject({ handled: true, status: "completed" });
      const payload = (provider.invoke as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.payload;
      const sent = JSON.stringify(payload);
      expect(sent).not.toContain("不应发送到云端的课程标题");
      expect(sent).not.toContain("不应发送到云端的学习目标");
      expect(sent).not.toContain("不应泄露的内部资料名称");
      expect(sent).not.toContain(knowledgePoint.statement);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  });

  test("fails without creating a candidate when the model omits a selected completed unit", async () => {
    const value = await fixture();
    try {
      const secondResourceId = randomUUID();
      const secondVersionId = randomUUID();
      await value.db.insert(schema.resources).values({
        id: secondResourceId,
        spaceId: value.spaceId,
        name: "第二份练习资料",
        status: "ready",
        createdBy: value.userId
      });
      await value.db.insert(schema.resourceVersions).values({
        id: secondVersionId,
        resourceId: secondResourceId,
        version: 1,
        originalName: "second-material.md",
        mimeType: "text/markdown",
        byteSize: 64,
        sha256: randomUUID().replaceAll("-", ""),
        blobUri: `local://tests/${secondVersionId}/source.md`,
        compileProfile: "knowledge",
        createdBy: value.userId
      });
      const draft = await createLearningPlanDraft({
        userId: value.userId,
        title: "完整覆盖验收计划",
        goal: "两个单元都应生成练习",
        resourceVersionIds: [value.resourceVersionId, secondVersionId]
      });
      const active = await confirmLearningPlan({ planId: draft.id, userId: value.userId });
      const course = await getActiveLearningCourse(value.userId);
      const courseUnits = course.modules.flatMap(({ units }) => units);
      const firstPlanUnit = active.plan.units.find(
        ({ resourceVersionId }) => resourceVersionId === value.resourceVersionId
      );
      const firstCourseUnit = courseUnits.find(
        ({ resourceVersionId }) => resourceVersionId === value.resourceVersionId
      );
      const secondCourseUnit = courseUnits.find(
        ({ resourceVersionId }) => resourceVersionId === secondVersionId
      );
      const firstKnowledgePoint = firstCourseUnit?.knowledgePoints[0];
      if (!firstPlanUnit || !firstCourseUnit || !secondCourseUnit || !firstKnowledgePoint)
        throw new Error("TEST_PRACTICE_GENERATE_TWO_UNIT_COURSE_MISSING");
      await Promise.all(
        active.plan.units.map((unit) =>
          recordActiveLearningEvent({
            userId: value.userId,
            unitId: unit.id,
            verb: "completed",
            sourceRef: unit.sourceRef
          })
        )
      );
      const run = await queuePracticeGenerateGeneration({
        userId: value.userId,
        skill: practiceGenerateSkill,
        courseUnitIds: [firstCourseUnit.id, secondCourseUnit.id],
        difficulty: "standard"
      });
      const provider: ModelProvider = {
        id: "local-provider",
        location: "local",
        capabilities: new Set(["chat"]),
        healthcheck: async () => true,
        invoke: async () => ({
          providerId: "local-provider",
          model: "local-test",
          durationMs: 2,
          output: JSON.stringify({
            courseId: course.id,
            difficulty: "standard",
            questions: [
              {
                courseUnitId: firstCourseUnit.id,
                knowledgePointId: firstKnowledgePoint.id,
                resourceVersionId: value.resourceVersionId,
                sourceRef: firstPlanUnit.sourceRef,
                answerType: "free_response",
                prompt: "只为第一个单元生成的题目。",
                rubric: {
                  kind: "free_response",
                  criteria: ["表述准确"],
                  maximumScore: 3,
                  note: "等待人工复核。"
                }
              }
            ]
          })
        })
      };
      await expect(
        executeManagedPracticeGenerateRun({
          skillRunId: run.id,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin"),
          gatewayFactory: gatewayFor(provider)
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "LEARNING_GENERATION_CANDIDATE_INVALID"
      });
      const candidates = await value.db
        .select()
        .from(schema.practiceGenerateCandidates)
        .where(eq(schema.practiceGenerateCandidates.skillRunId, run.id));
      expect(candidates).toHaveLength(0);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  });
});
