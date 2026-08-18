import {
  agentSkillInstallRequestSchema,
  agentSkillRevokeRequestSchema
} from "@wknowledge/contracts";
import {
  discoverAgentSkillCatalog,
  createNodeAgentSkillFsAdapter
} from "@wknowledge/agent-runtime";
import {
  installAgentSkill,
  listOrganizationSkillInstallations,
  revokeAgentSkill
} from "@wknowledge/core";
import { apiError } from "../../../../lib/api";
import { settingsAdmin, settingsAdminMutation } from "../../../../lib/settings-auth";
import { installedSkillsRoot } from "../../../../lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  const skills = await listOrganizationSkillInstallations(admin.organizationId).catch(() => null);
  return Response.json({ installations: skills ?? [] });
}

export async function POST(request: Request) {
  const admin = await settingsAdminMutation(request, "settings.agent_skills.install");
  if ("error" in admin) return admin.error;
  const parsed = agentSkillInstallRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "安装请求格式不正确", undefined, parsed.error.flatten());
  try {
    const catalog = await discoverAgentSkillCatalog({
      rootDirectory: installedSkillsRoot(),
      fs: createNodeAgentSkillFsAdapter()
    });
    const entry = catalog.skills.find((skill) => skill.entry.name === parsed.data.skillName);
    if (!entry)
      return apiError(
        404,
        "AGENT_SKILL_NOT_IN_CATALOG",
        "受管目录中不存在该技能",
        "先由管理员将技能目录放入受管 skills/installed 后重试"
      );
    const snapshot = await installAgentSkill({
      organizationId: admin.organizationId,
      skillName: entry.entry.name,
      version: parsed.data.version ?? "1.0.0",
      digest: entry.digest,
      sourceFormat: "agent-skills-directory",
      publisher: admin.user.id,
      executable: entry.classification.kind === "executable"
    });
    return Response.json({ installation: snapshot });
  } catch (error) {
    const code = error instanceof Error ? error.message : "AGENT_SKILL_INSTALL_FAILED";
    return apiError(500, "AGENT_SKILL_INSTALL_FAILED", "技能安装失败，请稍后重试", code);
  }
}

export async function DELETE(request: Request) {
  const admin = await settingsAdminMutation(request, "settings.agent_skills.revoke");
  if ("error" in admin) return admin.error;
  const parsed = agentSkillRevokeRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "撤销请求格式不正确", undefined, parsed.error.flatten());
  try {
    const revoked = await revokeAgentSkill({
      organizationId: admin.organizationId,
      skillName: parsed.data.skillName
    });
    if (!revoked) return apiError(404, "AGENT_SKILL_NOT_INSTALLED", "该技能未安装");
    return Response.json({ revoked: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "AGENT_SKILL_REVOKE_FAILED";
    return apiError(500, "AGENT_SKILL_REVOKE_FAILED", "技能撤销失败，请稍后重试", code);
  }
}
