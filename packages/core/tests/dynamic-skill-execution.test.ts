import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { computeSkillDigest, type DynamicSkillSandboxExecution } from "@wknowledge/skill-runtime";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import { createAgentSession, executeBuiltinSkillRun, executeDynamicSkillRun } from "../src/index";

const test = process.env.DATABASE_URL ? it : it.skip;

const inputSchema = {
  type: "object",
  required: ["schemaVersion", "skillRunId", "bindings"],
  properties: {
    schemaVersion: { type: "integer", enum: [1] },
    skillRunId: { type: "string" },
    bindings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "scope", "spaceId", "virtualPath"],
        properties: {
          id: { type: "string" },
          scope: { type: "string" },
          spaceId: { type: "string" },
          virtualPath: { type: "string" }
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

const outputSchema = {
  type: "object",
  required: ["accepted"],
  properties: { accepted: { type: "boolean" } },
  additionalProperties: false
};

const planComposeOutputSchema = {
  type: "object",
  required: ["title", "units"],
  properties: {
    title: { type: "string" },
    units: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "resourceVersionId", "sourceRef", "objective", "completionRule"],
        properties: {
          title: { type: "string" },
          resourceVersionId: { type: "string" },
          sourceRef: { type: "string" },
          objective: { type: "string" },
          completionRule: { type: "string" }
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

const practiceGenerateOutputSchema = {
  type: "object",
  required: ["courseId", "difficulty", "questions"],
  properties: {
    courseId: { type: "string" },
    difficulty: { type: "string" },
    questions: {
      type: "array",
      items: {
        type: "object",
        required: [
          "courseUnitId",
          "knowledgePointId",
          "resourceVersionId",
          "sourceRef",
          "answerType",
          "prompt",
          "answerKey",
          "rubric"
        ],
        properties: {
          courseUnitId: { type: "string" },
          knowledgePointId: { type: "string" },
          resourceVersionId: { type: "string" },
          sourceRef: { type: "string" },
          answerType: { type: "string" },
          prompt: { type: "string" },
          answerKey: { type: "string" },
          rubric: { type: "object" }
        },
        additionalProperties: false
      }
    }
  },
  additionalProperties: false
};

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const installedSkillsRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-installed-skills-"));
  const sandboxRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-dynamic-sandbox-"));
  await db.insert(schema.organizations).values({ id: organizationId, name: "动态 Skill 测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `dynamic-skill-${userId}@example.com`,
    name: "动态 Skill 用户",
    passwordHash: "not-used"
  });
  await db
    .insert(schema.organizationMemberships)
    .values({ organizationId, userId, role: "viewer" });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "动态 Skill 范围",
    createdBy: userId
  });
  await db.insert(schema.spaceMemberships).values({ spaceId, userId, role: "viewer" });
  const session = await createAgentSession({
    userId,
    title: "动态 Skill 会话",
    spaceIds: [spaceId]
  });
  const [binding] = await db
    .select()
    .from(schema.agentContextBindings)
    .where(eq(schema.agentContextBindings.sessionId, session.id));
  if (!binding) throw new Error("TEST_DYNAMIC_SKILL_BINDING_MISSING");
  return {
    db,
    organizationId,
    userId,
    spaceId,
    sessionId: session.id,
    binding,
    installedSkillsRoot,
    sandboxRoot
  };
}

async function currentCourseContext(value: Awaited<ReturnType<typeof fixture>>) {
  const resourceId = randomUUID();
  const versionId = randomUUID();
  const sourceRef = `wk://source/${versionId}/${Buffer.from(
    JSON.stringify({ type: "document", resourceVersionId: versionId, nodeId: "course-focus" })
  ).toString("base64url")}`;
  await value.db.insert(schema.resources).values({
    id: resourceId,
    spaceId: value.spaceId,
    name: "动态 Skill 固定资料",
    status: "ready",
    createdBy: value.userId
  });
  await value.db.insert(schema.resourceVersions).values({
    id: versionId,
    resourceId,
    version: 1,
    originalName: "动态 Skill 资料.md",
    mimeType: "text/markdown",
    byteSize: 64,
    sha256: randomUUID().replaceAll("-", ""),
    blobUri: `local://dynamic-skill/${versionId}/source.md`,
    compileProfile: "knowledge",
    createdBy: value.userId
  });
  const [profile] = await value.db
    .insert(schema.learnerProfiles)
    .values({ userId: value.userId })
    .returning();
  if (!profile) throw new Error("TEST_DYNAMIC_SKILL_PROFILE_MISSING");
  const [plan] = await value.db
    .insert(schema.learningPlans)
    .values({
      learnerProfileId: profile.id,
      version: 1,
      status: "active",
      title: "动态 Skill 课程",
      plan: {}
    })
    .returning();
  if (!plan) throw new Error("TEST_DYNAMIC_SKILL_PLAN_MISSING");
  const [course] = await value.db
    .insert(schema.courses)
    .values({
      learningPlanId: plan.id,
      status: "active",
      title: "动态 Skill 课程",
      goal: "验证范围"
    })
    .returning();
  if (!course) throw new Error("TEST_DYNAMIC_SKILL_COURSE_MISSING");
  const [module] = await value.db
    .insert(schema.courseModules)
    .values({ courseId: course.id, ordinal: 1, title: "原文", objective: "固定资料" })
    .returning();
  if (!module) throw new Error("TEST_DYNAMIC_SKILL_MODULE_MISSING");
  const [unit] = await value.db
    .insert(schema.courseUnits)
    .values({
      courseModuleId: module.id,
      planUnitId: "unit-01",
      ordinal: 1,
      title: "固定单元",
      objective: "验证 Skill 范围",
      completionRule: "完成固定资料",
      resourceVersionId: versionId,
      sourceRef
    })
    .returning();
  if (!unit) throw new Error("TEST_DYNAMIC_SKILL_UNIT_MISSING");
  const [point] = await value.db
    .insert(schema.courseKnowledgePoints)
    .values({
      courseUnitId: unit.id,
      ordinal: 1,
      title: "固定重点",
      statement: "固定重点陈述",
      resourceVersionId: versionId,
      sourceRef
    })
    .returning();
  if (!point) throw new Error("TEST_DYNAMIC_SKILL_POINT_MISSING");
  const session = await createAgentSession({
    userId: value.userId,
    title: "生成练习精确范围",
    bindings: [{ spaceId: value.spaceId, scope: "course", targetId: course.id }]
  });
  const [binding] = await value.db
    .select()
    .from(schema.agentContextBindings)
    .where(eq(schema.agentContextBindings.sessionId, session.id));
  if (!binding) throw new Error("TEST_DYNAMIC_SKILL_COURSE_BINDING_MISSING");
  return { course, unit, point, versionId, sourceRef, sessionId: session.id, binding };
}

async function installDynamicSkill(input: {
  installedSkillsRoot: string;
  skillId?: string;
  version?: string;
  program?: string;
  outputSchema?: Record<string, unknown>;
}) {
  const skillId = input.skillId ?? "binding-inspector";
  const version = input.version ?? "1.0.0";
  const directory = path.join(input.installedSkillsRoot, skillId);
  const programFile = path.join(directory, "run.mjs");
  const program = input.program ?? "process.exit(0);\n";
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(programFile, program, { encoding: "utf8", mode: 0o500 });
  const digest = computeSkillDigest([{ name: "run.mjs", content: Buffer.from(program) }]);
  await writeFile(
    path.join(directory, "skill.json"),
    JSON.stringify({
      id: skillId,
      version,
      digest,
      description: "检查受管上下文的合成动态 Skill",
      inputSchema,
      outputSchema: input.outputSchema ?? outputSchema,
      requiredCapabilities: [],
      permissions: {
        resources: "selected",
        filesystem: "write-artifacts",
        network: "deny",
        approval: "never"
      },
      limits: { timeoutSeconds: 30, memoryMb: 64, maxModelCalls: 0 },
      entrypoint: "typescript-json-cli"
    }),
    "utf8"
  );
  return { skillId, version, digest };
}

async function queuedDynamicRun(input: {
  value: Awaited<ReturnType<typeof fixture>>;
  skill: Awaited<ReturnType<typeof installDynamicSkill>>;
  inputSummary?: string;
  sessionId?: string;
  bindingId?: string;
}) {
  const [run] = await input.value.db
    .insert(schema.skillRuns)
    .values({
      sessionId: input.sessionId ?? input.value.sessionId,
      userId: input.value.userId,
      skillId: input.skill.skillId,
      skillVersion: input.skill.version,
      skillDigest: input.skill.digest,
      bindingIds: [input.bindingId ?? input.value.binding.id],
      inputSummary: input.inputSummary ?? "PRIVATE_USER_INPUT_DO_NOT_FORWARD"
    })
    .returning();
  if (!run) throw new Error("TEST_DYNAMIC_SKILL_RUN_MISSING");
  return run;
}

const runtime = {
  bubblewrapPath: "/usr/bin/bwrap",
  nodePath: "/usr/bin/node",
  pythonPath: "/usr/bin/python3"
};

afterAll(async () => closeDatabase());

describe("dynamic Skill Worker execution", () => {
  test("dispatches a registered dynamic Skill after the builtin handler declines it without forwarding user text", async () => {
    const value = await fixture();
    try {
      const skill = await installDynamicSkill({ installedSkillsRoot: value.installedSkillsRoot });
      const run = await queuedDynamicRun({ value, skill });
      await expect(
        executeBuiltinSkillRun({
          skillRunId: run.id,
          dataRoot: value.sandboxRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin")
        })
      ).resolves.toEqual({ handled: false, status: "not_builtin" });
      let sandboxInput: unknown;
      const result = await executeDynamicSkillRun({
        skillRunId: run.id,
        installedSkillsRoot: value.installedSkillsRoot,
        sandboxRoot: value.sandboxRoot,
        runtime,
        sandboxExecutor: async ({ sandbox }) => {
          sandboxInput = JSON.parse(
            await readFile(path.join(sandbox.inputDirectory, "input.json"), "utf8")
          );
          return { status: "completed", output: { accepted: true }, durationMs: 7 };
        }
      });
      expect(result).toMatchObject({
        handled: true,
        status: "completed",
        outputSummary: {
          runtime: "node",
          bindingCount: 1,
          durationMs: 7,
          networkCalls: 0,
          modelCalls: 0,
          outputType: "object",
          outputKeyCount: 1
        }
      });
      expect(sandboxInput).toEqual({
        schemaVersion: 1,
        input: {
          schemaVersion: 1,
          skillRunId: run.id,
          bindings: [
            {
              id: value.binding.id,
              scope: "space",
              spaceId: value.spaceId,
              virtualPath: `/knowledge/${value.spaceId}`
            }
          ]
        }
      });
      const serializedInput = JSON.stringify(sandboxInput);
      expect(serializedInput).not.toContain("PRIVATE_USER_INPUT_DO_NOT_FORWARD");
      expect(serializedInput).not.toContain(value.installedSkillsRoot);
      expect(serializedInput).not.toContain(process.env.DATABASE_URL ?? "DATABASE_URL_NOT_SET");
      const [stored] = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.id, run.id));
      expect(stored).toMatchObject({ status: "completed", errorCode: null });
      const audit = await value.db
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.targetId, run.id),
            eq(schema.auditEvents.action, "skill_run.completed")
          )
        );
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain("PRIVATE_USER_INPUT_DO_NOT_FORWARD");
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain(value.installedSkillsRoot);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await Promise.all([
        rm(value.installedSkillsRoot, { recursive: true, force: true }),
        rm(value.sandboxRoot, { recursive: true, force: true })
      ]);
    }
  });

  test("fails closed before sandbox execution when the installed program digest drifts", async () => {
    const value = await fixture();
    try {
      const skill = await installDynamicSkill({ installedSkillsRoot: value.installedSkillsRoot });
      const run = await queuedDynamicRun({ value, skill, inputSummary: "不会进入动态程序" });
      await chmod(path.join(value.installedSkillsRoot, skill.skillId, "run.mjs"), 0o600);
      await writeFile(
        path.join(value.installedSkillsRoot, skill.skillId, "run.mjs"),
        "process.exit(1);\n",
        "utf8"
      );
      let called = false;
      await expect(
        executeDynamicSkillRun({
          skillRunId: run.id,
          installedSkillsRoot: value.installedSkillsRoot,
          sandboxRoot: value.sandboxRoot,
          runtime,
          sandboxExecutor: async () => {
            called = true;
            return {
              status: "completed",
              output: { accepted: true },
              durationMs: 0
            } satisfies DynamicSkillSandboxExecution;
          }
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "SKILL_MANIFEST_CHANGED"
      });
      expect(called).toBe(false);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await Promise.all([
        rm(value.installedSkillsRoot, { recursive: true, force: true }),
        rm(value.sandboxRoot, { recursive: true, force: true })
      ]);
    }
  });

  test("revokes a queued dynamic Skill before sandbox execution when its organization membership is paused", async () => {
    const value = await fixture();
    try {
      const skill = await installDynamicSkill({ installedSkillsRoot: value.installedSkillsRoot });
      const run = await queuedDynamicRun({ value, skill, inputSummary: "暂停后不得执行" });
      await value.db
        .update(schema.organizationMemberships)
        .set({ disabled: true })
        .where(
          and(
            eq(schema.organizationMemberships.organizationId, value.organizationId),
            eq(schema.organizationMemberships.userId, value.userId)
          )
        );
      let called = false;
      await expect(
        executeDynamicSkillRun({
          skillRunId: run.id,
          installedSkillsRoot: value.installedSkillsRoot,
          sandboxRoot: value.sandboxRoot,
          runtime,
          sandboxExecutor: async () => {
            called = true;
            return {
              status: "completed",
              output: { accepted: true },
              durationMs: 0
            } satisfies DynamicSkillSandboxExecution;
          }
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "SKILL_SCOPE_REVOKED"
      });
      expect(called).toBe(false);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await Promise.all([
        rm(value.installedSkillsRoot, { recursive: true, force: true }),
        rm(value.sandboxRoot, { recursive: true, force: true })
      ]);
    }
  });

  test("stores only a validated plan-compose candidate output outside the SkillRun summary", async () => {
    const value = await fixture();
    try {
      const skill = await installDynamicSkill({
        installedSkillsRoot: value.installedSkillsRoot,
        skillId: "plan-compose",
        outputSchema: planComposeOutputSchema
      });
      const run = await queuedDynamicRun({ value, skill, inputSummary: "PRIVATE_PLAN_GOAL" });
      const sourceRef = `wk://source/${randomUUID()}/${Buffer.from(
        JSON.stringify({ type: "document", resourceVersionId: randomUUID(), nodeId: "focus" })
      ).toString("base64url")}`;
      const result = await executeDynamicSkillRun({
        skillRunId: run.id,
        installedSkillsRoot: value.installedSkillsRoot,
        sandboxRoot: value.sandboxRoot,
        runtime,
        sandboxExecutor: async () => ({
          status: "completed",
          output: {
            title: "AI 候选计划",
            units: [
              {
                title: "第一单元",
                resourceVersionId: randomUUID(),
                sourceRef,
                objective: "理解资料",
                completionRule: "完成原文阅读"
              }
            ]
          },
          durationMs: 7
        })
      });
      expect(result).toMatchObject({ handled: true, status: "completed" });
      const [candidate] = await value.db
        .select()
        .from(schema.planComposeCandidates)
        .where(eq(schema.planComposeCandidates.skillRunId, run.id));
      expect(candidate).toMatchObject({ userId: value.userId, materializedLearningPlanId: null });
      expect(candidate?.candidate).toMatchObject({ title: "AI 候选计划" });
      const [storedRun] = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.id, run.id));
      expect(JSON.stringify(storedRun?.outputSummary)).not.toContain("AI 候选计划");
      expect(JSON.stringify(storedRun?.outputSummary)).not.toContain("PRIVATE_PLAN_GOAL");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await Promise.all([
        rm(value.installedSkillsRoot, { recursive: true, force: true }),
        rm(value.sandboxRoot, { recursive: true, force: true })
      ]);
    }
  });

  test("fails a plan-compose run without storing a candidate when its output is invalid", async () => {
    const value = await fixture();
    try {
      const skill = await installDynamicSkill({
        installedSkillsRoot: value.installedSkillsRoot,
        skillId: "plan-compose",
        outputSchema: planComposeOutputSchema
      });
      const run = await queuedDynamicRun({ value, skill });
      await expect(
        executeDynamicSkillRun({
          skillRunId: run.id,
          installedSkillsRoot: value.installedSkillsRoot,
          sandboxRoot: value.sandboxRoot,
          runtime,
          sandboxExecutor: async () => ({
            status: "completed",
            output: { title: "缺少单元" },
            durationMs: 7
          })
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "PLAN_COMPOSE_CANDIDATE_INVALID"
      });
      const candidates = await value.db
        .select()
        .from(schema.planComposeCandidates)
        .where(eq(schema.planComposeCandidates.skillRunId, run.id));
      expect(candidates).toHaveLength(0);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await Promise.all([
        rm(value.installedSkillsRoot, { recursive: true, force: true }),
        rm(value.sandboxRoot, { recursive: true, force: true })
      ]);
    }
  });

  test("stores only a validated practice-generate candidate outside public SkillRun summaries", async () => {
    const value = await fixture();
    try {
      const skill = await installDynamicSkill({
        installedSkillsRoot: value.installedSkillsRoot,
        skillId: "practice-generate",
        outputSchema: practiceGenerateOutputSchema
      });
      const courseContext = await currentCourseContext(value);
      const run = await queuedDynamicRun({
        value,
        skill,
        inputSummary: "PRIVATE_PRACTICE_SCOPE",
        sessionId: courseContext.sessionId,
        bindingId: courseContext.binding.id
      });
      await expect(
        executeDynamicSkillRun({
          skillRunId: run.id,
          installedSkillsRoot: value.installedSkillsRoot,
          sandboxRoot: value.sandboxRoot,
          runtime,
          sandboxExecutor: async () => ({
            status: "completed",
            output: {
              courseId: courseContext.course.id,
              difficulty: "easy",
              questions: [
                {
                  courseUnitId: courseContext.unit.id,
                  knowledgePointId: courseContext.point.id,
                  resourceVersionId: courseContext.versionId,
                  sourceRef: courseContext.sourceRef,
                  answerType: "exact_response",
                  prompt: "PRIVATE_PRACTICE_PROMPT",
                  answerKey: "PRIVATE_PRACTICE_ANSWER_KEY",
                  rubric: {
                    kind: "exact_response",
                    normalization: "nfkc_trim_casefold_whitespace",
                    maximumScore: 1,
                    note: "固定答案键判定。"
                  }
                }
              ]
            },
            durationMs: 7
          })
        })
      ).resolves.toMatchObject({ handled: true, status: "completed" });
      const [candidate] = await value.db
        .select()
        .from(schema.practiceGenerateCandidates)
        .where(eq(schema.practiceGenerateCandidates.skillRunId, run.id));
      expect(candidate?.candidate).toMatchObject({
        courseId: courseContext.course.id,
        difficulty: "easy"
      });
      const [storedRun] = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.id, run.id));
      expect(JSON.stringify(storedRun?.outputSummary)).not.toContain("PRIVATE_PRACTICE_PROMPT");
      expect(JSON.stringify(storedRun?.outputSummary)).not.toContain("PRIVATE_PRACTICE_ANSWER_KEY");
      expect(JSON.stringify(storedRun?.outputSummary)).not.toContain("PRIVATE_PRACTICE_SCOPE");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await Promise.all([
        rm(value.installedSkillsRoot, { recursive: true, force: true }),
        rm(value.sandboxRoot, { recursive: true, force: true })
      ]);
    }
  });

  test("rejects a structurally valid practice-generate output when its run lacks the exact course Binding", async () => {
    const value = await fixture();
    try {
      const skill = await installDynamicSkill({
        installedSkillsRoot: value.installedSkillsRoot,
        skillId: "practice-generate",
        outputSchema: practiceGenerateOutputSchema
      });
      const run = await queuedDynamicRun({ value, skill });
      const versionId = randomUUID();
      const sourceRef = `wk://source/${versionId}/${Buffer.from(
        JSON.stringify({ type: "document", resourceVersionId: versionId, nodeId: "focus" })
      ).toString("base64url")}`;
      await expect(
        executeDynamicSkillRun({
          skillRunId: run.id,
          installedSkillsRoot: value.installedSkillsRoot,
          sandboxRoot: value.sandboxRoot,
          runtime,
          sandboxExecutor: async () => ({
            status: "completed",
            output: {
              courseId: randomUUID(),
              difficulty: "easy",
              questions: [
                {
                  courseUnitId: randomUUID(),
                  knowledgePointId: randomUUID(),
                  resourceVersionId: versionId,
                  sourceRef,
                  answerType: "exact_response",
                  prompt: "不应写入候选。",
                  answerKey: "不应写入答案键。",
                  rubric: {
                    kind: "exact_response",
                    normalization: "nfkc_trim_casefold_whitespace",
                    maximumScore: 1,
                    note: "固定答案键判定。"
                  }
                }
              ]
            },
            durationMs: 7
          })
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "PRACTICE_GENERATE_SCOPE_DENIED"
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
      await Promise.all([
        rm(value.installedSkillsRoot, { recursive: true, force: true }),
        rm(value.sandboxRoot, { recursive: true, force: true })
      ]);
    }
  });

  test("fails an invalid practice-generate output without retaining a candidate", async () => {
    const value = await fixture();
    try {
      const skill = await installDynamicSkill({
        installedSkillsRoot: value.installedSkillsRoot,
        skillId: "practice-generate",
        outputSchema: practiceGenerateOutputSchema
      });
      const run = await queuedDynamicRun({ value, skill });
      await expect(
        executeDynamicSkillRun({
          skillRunId: run.id,
          installedSkillsRoot: value.installedSkillsRoot,
          sandboxRoot: value.sandboxRoot,
          runtime,
          sandboxExecutor: async () => ({
            status: "completed",
            output: { courseId: randomUUID(), difficulty: "easy", questions: [] },
            durationMs: 7
          })
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "PRACTICE_GENERATE_CANDIDATE_INVALID"
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
      await Promise.all([
        rm(value.installedSkillsRoot, { recursive: true, force: true }),
        rm(value.sandboxRoot, { recursive: true, force: true })
      ]);
    }
  });
});
