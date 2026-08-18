import { MODEL_PROVIDER_PRESETS, managedModelProviderPresetSchema } from "@wknowledge/contracts";
import {
  providerEndpointPolicyFromEnvironment,
  validateProviderEndpoint
} from "@wknowledge/model-gateway";
import { settingsAdmin } from "../../../../lib/settings-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await settingsAdmin();
  if ("error" in admin) return admin.error;
  const policy = providerEndpointPolicyFromEnvironment();
  const presets = MODEL_PROVIDER_PRESETS.map((preset) => {
    const allowed = preset.endpoints.every((endpoint) => {
      try {
        validateProviderEndpoint(endpoint.baseUrl, preset.location, policy);
        return true;
      } catch {
        return false;
      }
    });
    return managedModelProviderPresetSchema.parse({ ...preset, allowed });
  });
  return Response.json({ presets });
}
