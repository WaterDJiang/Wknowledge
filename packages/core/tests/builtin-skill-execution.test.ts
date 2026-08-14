import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { initializeSpace } from "@wknowledge/wiki";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import { createAgentSession, createQueuedSkillRun, executeBuiltinSkillRun } from "../src/index";
import type { ManagedSkill } from "@wknowledge/contracts";

const test = process.env.DATABASE_URL ? it : it.skip;

async function wikiLintSkill(): Promise<ManagedSkill> {
  const manifest = JSON.parse(
    await readFile(path.join(process.cwd(), "skills", "builtin", "wiki-lint", "skill.json"), "utf8")
  ) as Omit<ManagedSkill, "enabled">;
  return { ...manifest, enabled: true };
}

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-skill-"));
  await db.insert(schema.organizations).values({ id: organizationId, name: "Skill 执行测试组织" });
  await db.insert(schema.users).values({
    id: userId,
    email: `skill-exec-${userId}@example.com`,
    name: "Skill 执行用户",
    passwordHash: "not-used"
  });
  await db
    .insert(schema.organizationMemberships)
    .values({ organizationId, userId, role: "viewer" });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "可执行知识空间",
    createdBy: userId
  });
  await db.insert(schema.spaceMemberships).values({ spaceId, userId, role: "viewer" });
  await initializeSpace(dataRoot, spaceId);
  const session = await createAgentSession({
    userId,
    title: "只读 Lint 会话",
    spaceIds: [spaceId]
  });
  const [binding] = await db
    .select()
    .from(schema.agentContextBindings)
    .where(eq(schema.agentContextBindings.sessionId, session.id));
  if (!binding) throw new Error("TEST_SKILL_BINDING_MISSING");
  return {
    db,
    organizationId,
    userId,
    spaceId,
    sessionId: session.id,
    bindingId: binding.id,
    dataRoot
  };
}

afterAll(async () => closeDatabase());

describe("builtin Skill execution", () => {
  test("executes only source-bound wiki-lint once and stores a redacted summary", async () => {
    const value = await fixture();
    try {
      const skill = await wikiLintSkill();
      const run = await createQueuedSkillRun({
        sessionId: value.sessionId,
        userId: value.userId,
        skill,
        bindingIds: [value.bindingId],
        inputSummary: "检查已绑定知识空间的 Wiki 结构"
      });
      await expect(
        executeBuiltinSkillRun({
          skillRunId: run.id,
          dataRoot: value.dataRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin")
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "completed",
        outputSummary: { scannedSpaces: 1, issueCount: 0, networkCalls: 0, modelCalls: 0 }
      });
      const [stored] = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.id, run.id));
      expect(stored).toMatchObject({
        status: "completed",
        errorCode: null,
        outputSummary: { scannedSpaces: 1, issueCount: 0, networkCalls: 0, modelCalls: 0 }
      });
      await expect(
        executeBuiltinSkillRun({
          skillRunId: run.id,
          dataRoot: value.dataRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin")
        })
      ).resolves.toEqual({ handled: false, status: "terminal_or_claimed" });
      const audit = await value.db
        .select()
        .from(schema.auditEvents)
        .where(
          and(
            eq(schema.auditEvents.targetId, run.id),
            eq(schema.auditEvents.action, "skill_run.completed")
          )
        );
      expect(audit).toHaveLength(1);
      expect(JSON.stringify(audit[0]?.metadata)).not.toContain(value.dataRoot);
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  });

  test("fails a queued run after scope revocation without scanning the Wiki", async () => {
    const value = await fixture();
    try {
      const skill = await wikiLintSkill();
      const run = await createQueuedSkillRun({
        sessionId: value.sessionId,
        userId: value.userId,
        skill,
        bindingIds: [value.bindingId],
        inputSummary: "撤权后不应读取"
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
        executeBuiltinSkillRun({
          skillRunId: run.id,
          dataRoot: value.dataRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin")
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "SKILL_SCOPE_REVOKED"
      });
      const [stored] = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.id, run.id));
      expect(stored).toMatchObject({ status: "failed", errorCode: "SKILL_SCOPE_REVOKED" });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  });

  test("fails before reading the Wiki when the queued manifest or installation changed", async () => {
    const manifestChanged = await fixture();
    try {
      const skill = await wikiLintSkill();
      const run = await createQueuedSkillRun({
        sessionId: manifestChanged.sessionId,
        userId: manifestChanged.userId,
        skill: { ...skill, digest: `sha256:${"b".repeat(64)}` },
        bindingIds: [manifestChanged.bindingId],
        inputSummary: "运行前必须重核 Manifest"
      });
      await expect(
        executeBuiltinSkillRun({
          skillRunId: run.id,
          dataRoot: manifestChanged.dataRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin")
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "SKILL_MANIFEST_CHANGED"
      });
    } finally {
      await manifestChanged.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, manifestChanged.organizationId));
      await rm(manifestChanged.dataRoot, { recursive: true, force: true });
    }

    const installationChanged = await fixture();
    try {
      const skill = await wikiLintSkill();
      const run = await createQueuedSkillRun({
        sessionId: installationChanged.sessionId,
        userId: installationChanged.userId,
        skill,
        bindingIds: [installationChanged.bindingId],
        inputSummary: "运行前必须重核组织安装状态"
      });
      await installationChanged.db.insert(schema.skillInstallations).values({
        organizationId: installationChanged.organizationId,
        skillId: skill.id,
        version: skill.version,
        digest: skill.digest,
        enabled: false,
        updatedBy: installationChanged.userId
      });
      await expect(
        executeBuiltinSkillRun({
          skillRunId: run.id,
          dataRoot: installationChanged.dataRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin")
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "SKILL_INSTALLATION_CHANGED"
      });
    } finally {
      await installationChanged.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, installationChanged.organizationId));
      await rm(installationChanged.dataRoot, { recursive: true, force: true });
    }
  });

  test("rejects a Wiki directory redirected by a symbolic link", async () => {
    const value = await fixture();
    const redirectedRoot = await mkdtemp(path.join(os.tmpdir(), "wknowledge-redirected-wiki-"));
    try {
      const skill = await wikiLintSkill();
      const run = await createQueuedSkillRun({
        sessionId: value.sessionId,
        userId: value.userId,
        skill,
        bindingIds: [value.bindingId],
        inputSummary: "不允许跳出受管知识目录"
      });
      const redirectedSpaceId = randomUUID();
      await initializeSpace(redirectedRoot, redirectedSpaceId);
      const wikiPath = path.join(value.dataRoot, value.spaceId, "wiki");
      await rm(wikiPath, { recursive: true, force: true });
      await symlink(path.join(redirectedRoot, redirectedSpaceId, "wiki"), wikiPath);
      await expect(
        executeBuiltinSkillRun({
          skillRunId: run.id,
          dataRoot: value.dataRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin")
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "SKILL_PATH_DENIED"
      });
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await Promise.all([
        rm(value.dataRoot, { recursive: true, force: true }),
        rm(redirectedRoot, { recursive: true, force: true })
      ]);
    }
  });

  test("normalizes a missing managed Wiki directory to a stable error code", async () => {
    const value = await fixture();
    try {
      const skill = await wikiLintSkill();
      const run = await createQueuedSkillRun({
        sessionId: value.sessionId,
        userId: value.userId,
        skill,
        bindingIds: [value.bindingId],
        inputSummary: "受管目录缺失时不暴露底层错误"
      });
      await rm(path.join(value.dataRoot, value.spaceId, "wiki"), { recursive: true, force: true });
      await expect(
        executeBuiltinSkillRun({
          skillRunId: run.id,
          dataRoot: value.dataRoot,
          builtinSkillsRoot: path.join(process.cwd(), "skills", "builtin")
        })
      ).resolves.toMatchObject({
        handled: true,
        status: "failed",
        errorCode: "SKILL_PATH_DENIED"
      });
      const [stored] = await value.db
        .select()
        .from(schema.skillRuns)
        .where(eq(schema.skillRuns.id, run.id));
      expect(stored?.errorCode).toBe("SKILL_PATH_DENIED");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
      await rm(value.dataRoot, { recursive: true, force: true });
    }
  });
});
