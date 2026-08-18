import { createModelProviderInputSchema } from "@wknowledge/contracts";
import { apiError } from "../../../../lib/api";
import { settingsAdmin, settingsAdminMutation } from "../../../../lib/settings-auth";
import { createManagedProvider, listManagedProviders } from "../../../../lib/settings";

export const runtime = "nodejs";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  return Response.json({ providers: await listManagedProviders(admin.organizationId) });
}

export async function POST(request: Request) {
  const admin = await settingsAdminMutation(request, "settings.model-provider.create");
  if ("error" in admin) return admin.error;
  const parsed = createModelProviderInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(400, "INPUT_INVALID", "模型配置不完整", undefined, parsed.error.flatten());
  try {
    const provider = await createManagedProvider(admin.organizationId, admin.user.id, parsed.data);
    return Response.json({ provider }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "MODEL_PROVIDER_ENDPOINT_DENIED")
      return apiError(400, "MODEL_PROVIDER_ENDPOINT_DENIED", "模型服务地址未纳入当前部署网络策略");
    if (error instanceof Error && error.message === "MODEL_PROVIDER_ENDPOINT_UNRESOLVABLE")
      return apiError(400, "MODEL_PROVIDER_ENDPOINT_UNRESOLVABLE", "模型服务地址无法完成 DNS 解析");
    if (error instanceof Error && error.message === "CREDENTIAL_KEY_REQUIRED")
      return apiError(409, "CREDENTIAL_KEY_REQUIRED", "保存模型密钥前需要配置凭据主密钥");
    return apiError(500, "MODEL_PROVIDER_CREATE_FAILED", "模型服务保存失败");
  }
}
