import { updateSkillInputSchema } from "@wknowledge/contracts";
import { apiError } from "../../../../../lib/api";
import { settingsAdminMutation } from "../../../../../lib/settings-auth";
import { setManagedSkillEnabled } from "../../../../../lib/settings";

export const runtime = "nodejs";

export async function PATCH(request: Request, context: { params: Promise<{ skillId: string }> }) {
  const admin = await settingsAdminMutation(request, "settings.skill.update");
  if ("error" in admin) return admin.error;
  const parsed = updateSkillInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INPUT_INVALID", "Skill 状态不正确");
  try {
    const { skillId } = await context.params;
    return Response.json({
      skill: await setManagedSkillEnabled(
        admin.organizationId,
        admin.user.id,
        skillId,
        parsed.data.enabled
      )
    });
  } catch {
    return apiError(404, "SKILL_NOT_FOUND", "Skill 不存在");
  }
}
