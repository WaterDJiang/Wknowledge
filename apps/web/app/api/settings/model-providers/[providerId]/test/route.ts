import { apiError } from "../../../../../../lib/api";
import { settingsAdminMutation } from "../../../../../../lib/settings-auth";
import { testManagedProvider } from "../../../../../../lib/settings";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ providerId: string }> }) {
  const admin = await settingsAdminMutation(request, "settings.model-provider.test");
  if ("error" in admin) return admin.error;
  try {
    const { providerId } = await context.params;
    return Response.json({
      provider: await testManagedProvider(admin.organizationId, admin.user.id, providerId)
    });
  } catch {
    return apiError(500, "MODEL_PROVIDER_TEST_FAILED", "模型服务连通测试失败");
  }
}
