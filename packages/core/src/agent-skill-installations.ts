import { and, desc, eq } from "drizzle-orm";
import { getDatabase, schema } from "@wknowledge/database";
import {
  resolveInstalledAgentSkills,
  type AgentSkillCatalogEntry
} from "@wknowledge/agent-runtime";
import type { AgentSkillInstallationSnapshot } from "@wknowledge/contracts";

/**
 * Agent Skill installation snapshots (M5-14, upgrade spec §6.2): installing
 * pins an immutable record per organization; re-pinning a new version keeps
 * the history and moves the single enabled pin; revoking disables it. The
 * tenant-scoped resolution then reuses the runtime's fail-closed resolver.
 */

const SKILL_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

export interface InstallAgentSkillInput {
  organizationId: string;
  skillName: string;
  version: string;
  digest: string;
  sourceFormat: "skill.json" | "agent-skills-directory";
  sourceVersion?: string;
  sourceDigest?: string;
  publisher: string;
  executable: boolean;
}

function assertInstallInput(input: InstallAgentSkillInput): void {
  if (!SKILL_NAME_PATTERN.test(input.skillName)) throw new Error("AGENT_SKILL_INSTALL_INVALID");
  if (!DIGEST_PATTERN.test(input.digest)) throw new Error("AGENT_SKILL_INSTALL_INVALID");
  if (input.version.trim().length === 0 || input.version.length > 64) {
    throw new Error("AGENT_SKILL_INSTALL_INVALID");
  }
  if (input.publisher.trim().length === 0 || input.publisher.length > 200) {
    throw new Error("AGENT_SKILL_INSTALL_INVALID");
  }
  if (input.sourceVersion !== undefined && input.sourceVersion.length === 0) {
    throw new Error("AGENT_SKILL_INSTALL_INVALID");
  }
  if (input.sourceDigest !== undefined && !DIGEST_PATTERN.test(input.sourceDigest)) {
    throw new Error("AGENT_SKILL_INSTALL_INVALID");
  }
}

type InstallationRow = typeof schema.agentSkillInstallations.$inferSelect;

function toSnapshot(row: InstallationRow): AgentSkillInstallationSnapshot {
  return {
    id: row.id,
    organizationId: row.organizationId,
    skillName: row.skillName,
    version: row.version,
    digest: row.digest,
    sourceFormat: row.sourceFormat as AgentSkillInstallationSnapshot["sourceFormat"],
    ...(row.sourceVersion !== null ? { sourceVersion: row.sourceVersion } : {}),
    ...(row.sourceDigest !== null ? { sourceDigest: row.sourceDigest } : {}),
    publisher: row.publisher,
    installedAt: row.installedAt.toISOString(),
    enabled: row.enabled,
    executable: row.executable
  };
}

export async function installAgentSkill(
  input: InstallAgentSkillInput
): Promise<AgentSkillInstallationSnapshot> {
  assertInstallInput(input);
  const db = getDatabase();
  return db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(schema.agentSkillInstallations)
      .where(
        and(
          eq(schema.agentSkillInstallations.organizationId, input.organizationId),
          eq(schema.agentSkillInstallations.skillName, input.skillName),
          eq(schema.agentSkillInstallations.enabled, true)
        )
      )
      .limit(1)
      .for("update");
    if (
      current &&
      current.digest === input.digest &&
      current.version === input.version &&
      current.executable === input.executable
    ) {
      return toSnapshot(current);
    }
    if (current) {
      await tx
        .update(schema.agentSkillInstallations)
        .set({ enabled: false })
        .where(eq(schema.agentSkillInstallations.id, current.id));
    }
    const [inserted] = await tx
      .insert(schema.agentSkillInstallations)
      .values({
        organizationId: input.organizationId,
        skillName: input.skillName,
        version: input.version,
        digest: input.digest,
        sourceFormat: input.sourceFormat,
        ...(input.sourceVersion !== undefined ? { sourceVersion: input.sourceVersion } : {}),
        ...(input.sourceDigest !== undefined ? { sourceDigest: input.sourceDigest } : {}),
        publisher: input.publisher,
        executable: input.executable,
        enabled: true
      })
      .returning();
    if (!inserted) throw new Error("AGENT_SKILL_INSTALL_INVALID");
    return toSnapshot(inserted);
  });
}

export async function revokeAgentSkill(input: {
  organizationId: string;
  skillName: string;
}): Promise<boolean> {
  const db = getDatabase();
  const revoked = await db
    .update(schema.agentSkillInstallations)
    .set({ enabled: false })
    .where(
      and(
        eq(schema.agentSkillInstallations.organizationId, input.organizationId),
        eq(schema.agentSkillInstallations.skillName, input.skillName),
        eq(schema.agentSkillInstallations.enabled, true)
      )
    )
    .returning({ id: schema.agentSkillInstallations.id });
  return revoked.length > 0;
}

export async function listOrganizationSkillInstallations(
  organizationId: string
): Promise<AgentSkillInstallationSnapshot[]> {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(schema.agentSkillInstallations)
    .where(eq(schema.agentSkillInstallations.organizationId, organizationId))
    .orderBy(
      schema.agentSkillInstallations.skillName,
      desc(schema.agentSkillInstallations.installedAt)
    );
  return rows.map(toSnapshot);
}

/**
 * Tenant-scoped resolution: enabled snapshots for one organization plus the
 * discovered catalog, through the shared fail-closed resolver (drift, missing
 * installed skills and duplicates all fail closed).
 */
export async function resolveOrganizationInstalledSkills(input: {
  organizationId: string;
  skills: readonly AgentSkillCatalogEntry[];
}): Promise<ReturnType<typeof resolveInstalledAgentSkills>> {
  const db = getDatabase();
  const rows = await db
    .select()
    .from(schema.agentSkillInstallations)
    .where(
      and(
        eq(schema.agentSkillInstallations.organizationId, input.organizationId),
        eq(schema.agentSkillInstallations.enabled, true)
      )
    );
  return resolveInstalledAgentSkills({ snapshots: rows.map(toSnapshot), skills: input.skills });
}
