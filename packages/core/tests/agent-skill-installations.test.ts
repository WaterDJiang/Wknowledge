import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import {
  installAgentSkill,
  listOrganizationSkillInstallations,
  resolveOrganizationInstalledSkills,
  revokeAgentSkill
} from "../src/index";
import type { AgentSkillCatalogEntry } from "@wknowledge/agent-runtime";

const test = process.env.DATABASE_URL ? it : it.skip;

async function fixtureOrganization(): Promise<string> {
  const organizationId = randomUUID();
  await getDatabase()
    .insert(schema.organizations)
    .values({ id: organizationId, name: `技能安装测试组织-${organizationId.slice(0, 8)}` });
  return organizationId;
}

function catalogEntry(name: string, digest: string): AgentSkillCatalogEntry {
  return {
    directoryName: name,
    entry: {
      name,
      description: `${name} 的说明。`,
      body: "正文说明。"
    },
    classification: { kind: "instruction-only", undeclaredExecutableContent: false },
    digest
  };
}

afterAll(async () => {
  await closeDatabase();
});

describe("agent skill installations", () => {
  test("installs idempotently and re-pins with history preserved", async () => {
    const organizationId = await fixtureOrganization();
    const firstDigest = `sha256:${"1".repeat(64)}`;
    const first = await installAgentSkill({
      organizationId,
      skillName: "docs-skill",
      version: "1.0.0",
      digest: firstDigest,
      sourceFormat: "agent-skills-directory",
      publisher: "admin",
      executable: false
    });
    expect(first.enabled).toBe(true);
    const replay = await installAgentSkill({
      organizationId,
      skillName: "docs-skill",
      version: "1.0.0",
      digest: firstDigest,
      sourceFormat: "agent-skills-directory",
      publisher: "another-admin",
      executable: false
    });
    expect(replay.id).toBe(first.id);
    expect(replay.publisher).toBe("admin");

    const second = await installAgentSkill({
      organizationId,
      skillName: "docs-skill",
      version: "2.0.0",
      digest: `sha256:${"2".repeat(64)}`,
      sourceFormat: "skill.json",
      sourceVersion: "1.0.0",
      sourceDigest: `sha256:${"3".repeat(64)}`,
      publisher: "admin",
      executable: true
    });
    expect(second.id).not.toBe(first.id);
    expect(second.sourceVersion).toBe("1.0.0");
    const history = await listOrganizationSkillInstallations(organizationId);
    expect(history).toHaveLength(2);
    expect(history.filter((snapshot) => snapshot.enabled)).toHaveLength(1);
    expect(history[0]?.version).toBe("2.0.0");
  });

  test("rejects malformed installation input", async () => {
    const organizationId = await fixtureOrganization();
    await expect(
      installAgentSkill({
        organizationId,
        skillName: "BadName",
        version: "1.0.0",
        digest: `sha256:${"a".repeat(64)}`,
        sourceFormat: "agent-skills-directory",
        publisher: "admin",
        executable: false
      })
    ).rejects.toThrow("AGENT_SKILL_INSTALL_INVALID");
  });

  test("revokes an enabled installation once", async () => {
    const organizationId = await fixtureOrganization();
    await installAgentSkill({
      organizationId,
      skillName: "revoked-skill",
      version: "1.0.0",
      digest: `sha256:${"4".repeat(64)}`,
      sourceFormat: "agent-skills-directory",
      publisher: "admin",
      executable: false
    });
    expect(await revokeAgentSkill({ organizationId, skillName: "revoked-skill" })).toBe(true);
    expect(await revokeAgentSkill({ organizationId, skillName: "revoked-skill" })).toBe(false);
    const history = await listOrganizationSkillInstallations(organizationId);
    expect(history.every((snapshot) => !snapshot.enabled)).toBe(true);
  });

  test("resolves installed skills against the catalog fail-closed", async () => {
    const organizationId = await fixtureOrganization();
    const digest = `sha256:${"5".repeat(64)}`;
    await installAgentSkill({
      organizationId,
      skillName: "resolved-skill",
      version: "1.0.0",
      digest,
      sourceFormat: "agent-skills-directory",
      publisher: "admin",
      executable: false
    });
    const resolved = await resolveOrganizationInstalledSkills({
      organizationId,
      skills: [
        catalogEntry("resolved-skill", digest),
        catalogEntry("stranger", `sha256:${"6".repeat(64)}`)
      ]
    });
    expect(resolved.skills).toHaveLength(1);
    expect(resolved.skills[0]?.entry.entry.name).toBe("resolved-skill");

    await expect(
      resolveOrganizationInstalledSkills({
        organizationId,
        skills: [catalogEntry("resolved-skill", `sha256:${"7".repeat(64)}`)]
      })
    ).rejects.toThrow("AGENT_SKILL_SNAPSHOT_DRIFT");

    await expect(
      resolveOrganizationInstalledSkills({ organizationId, skills: [] })
    ).rejects.toThrow("AGENT_SKILL_SNAPSHOT_UNRESOLVED");
  });

  test("keeps organizations isolated", async () => {
    const first = await fixtureOrganization();
    const second = await fixtureOrganization();
    const digest = `sha256:${"8".repeat(64)}`;
    await installAgentSkill({
      organizationId: first,
      skillName: "isolated-skill",
      version: "1.0.0",
      digest,
      sourceFormat: "agent-skills-directory",
      publisher: "admin",
      executable: false
    });
    const secondResolved = await resolveOrganizationInstalledSkills({
      organizationId: second,
      skills: [catalogEntry("isolated-skill", digest)]
    });
    expect(secondResolved.skills).toEqual([]);
    const firstResolved = await resolveOrganizationInstalledSkills({
      organizationId: first,
      skills: [catalogEntry("isolated-skill", digest)]
    });
    expect(firstResolved.skills).toHaveLength(1);
    const db = getDatabase();
    await db.delete(schema.organizations).where(eq(schema.organizations.id, second));
  });
});
