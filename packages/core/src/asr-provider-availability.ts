import { and, desc, eq } from "drizzle-orm";
import type { DataPolicy } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";

export function isAsrProviderLocationCompatible(
  location: "local" | "cloud",
  dataPolicy: DataPolicy
): boolean {
  return location === "local" || dataPolicy === "cloud_allowed";
}

export function isVisionProviderLocationCompatible(
  location: "local" | "cloud",
  dataPolicy: DataPolicy
): boolean {
  return location === "local" || dataPolicy === "cloud_allowed";
}

export async function hasAvailableAsrProvider(
  organizationId: string,
  dataPolicy: DataPolicy
): Promise<boolean> {
  const providers = await getDatabase()
    .select({
      location: schema.modelProviders.location,
      capabilities: schema.modelProviders.capabilities
    })
    .from(schema.modelProviders)
    .where(
      and(
        eq(schema.modelProviders.organizationId, organizationId),
        eq(schema.modelProviders.enabled, true),
        eq(schema.modelProviders.health, "healthy")
      )
    )
    .orderBy(desc(schema.modelProviders.updatedAt));
  return providers.some(
    (provider) =>
      provider.capabilities.includes("speech_to_text") &&
      isAsrProviderLocationCompatible(provider.location, dataPolicy)
  );
}

export async function hasAvailableVisionProvider(
  organizationId: string,
  dataPolicy: DataPolicy
): Promise<boolean> {
  const providers = await getDatabase()
    .select({
      location: schema.modelProviders.location,
      capabilities: schema.modelProviders.capabilities
    })
    .from(schema.modelProviders)
    .where(
      and(
        eq(schema.modelProviders.organizationId, organizationId),
        eq(schema.modelProviders.enabled, true),
        eq(schema.modelProviders.health, "healthy")
      )
    )
    .orderBy(desc(schema.modelProviders.updatedAt));
  return providers.some(
    (provider) =>
      provider.capabilities.includes("vision") &&
      isVisionProviderLocationCompatible(provider.location, dataPolicy)
  );
}
