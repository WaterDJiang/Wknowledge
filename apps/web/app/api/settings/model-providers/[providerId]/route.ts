import { updateModelProviderInputSchema } from "@wknowledge/contracts";
import { apiError } from "../../../../../lib/api";
import { settingsAdminMutation } from "../../../../../lib/settings-auth";
import { updateManagedProvider } from "../../../../../lib/settings";

export const runtime = "nodejs";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ providerId: string }> }
) {
  const admin = await settingsAdminMutation(request, "settings.model-provider.update");
  if ("error" in admin) return admin.error;
  const parsed = updateModelProviderInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INPUT_INVALID", "模型配置不正确");
  try {
    const { providerId } = await context.params;
    return Response.json({
      provider: await updateManagedProvider(
        admin.organizationId,
        admin.user.id,
        providerId,
        parsed.data
      )
    });
  } catch (error) {
    if (error instanceof Error && error.message === "MODEL_PROVIDER_NOT_FOUND")
      return apiError(404, "MODEL_PROVIDER_NOT_FOUND", "模型服务不存在");
    if (error instanceof Error && error.message === "CLOUD_PROVIDER_API_KEY_REQUIRED")
      return apiError(400, "CLOUD_PROVIDER_API_KEY_REQUIRED", "云端模型服务必须配置 API Key");
    if (error instanceof Error && error.message === "CREDENTIAL_KEY_REQUIRED")
      return apiError(409, "CREDENTIAL_KEY_REQUIRED", "保存模型密钥前需要配置凭据主密钥");
    if (error instanceof Error && error.message === "MODEL_PROVIDER_API_KEY_REAUTH_REQUIRED")
      return apiError(
        409,
        "MODEL_PROVIDER_API_KEY_REAUTH_REQUIRED",
        "修改模型服务地址后需要重新填写 API Key"
      );
    if (
      error instanceof Error &&
      (error.message === "MODEL_PROVIDER_ENDPOINT_DENIED" ||
        error.message === "MODEL_PROVIDER_ENDPOINT_UNRESOLVABLE")
    )
      return apiError(400, "MODEL_PROVIDER_ENDPOINT_DENIED", "模型服务地址不符合部署网络策略");
    return apiError(500, "MODEL_PROVIDER_UPDATE_FAILED", "模型服务更新失败");
  }
}
