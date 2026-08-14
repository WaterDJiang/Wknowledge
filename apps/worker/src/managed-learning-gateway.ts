import { and, desc, eq } from "drizzle-orm";
import type { DataPolicy } from "@wknowledge/contracts";
import { createModelInvocationBudgetGuard } from "@wknowledge/core";
import { getDatabase, schema } from "@wknowledge/database";
import {
  decryptCredential,
  ModelGateway,
  OpenAICompatibleProvider,
  validateProviderEndpoint
} from "@wknowledge/model-gateway";

function providerApiKey(row: typeof schema.modelProviders.$inferSelect): string | undefined {
  if (!row.encryptedApiKey || !row.credentialIv || !row.credentialTag) return undefined;
  const key = process.env.WKNOWLEDGE_CREDENTIAL_KEY;
  if (!key) throw new Error("CREDENTIAL_KEY_REQUIRED");
  return decryptCredential(
    { ciphertext: row.encryptedApiKey, iv: row.credentialIv, tag: row.credentialTag },
    key
  );
}

export async function createManagedLearningChatGateway(
  organizationId: string,
  dataPolicy: DataPolicy,
  userId?: string
): Promise<ModelGateway> {
  const rows = await getDatabase()
    .select()
    .from(schema.modelProviders)
    .where(
      and(
        eq(schema.modelProviders.organizationId, organizationId),
        eq(schema.modelProviders.enabled, true),
        eq(schema.modelProviders.health, "healthy")
      )
    )
    .orderBy(desc(schema.modelProviders.updatedAt));
  const gateway = new ModelGateway({
    beforeInvoke: createModelInvocationBudgetGuard({
      organizationId,
      ...(userId ? { userId } : {})
    })
  });
  for (const row of rows) {
    if (!row.capabilities.includes("chat")) continue;
    if (row.location === "cloud" && dataPolicy === "local_only") continue;
    validateProviderEndpoint(row.baseUrl, row.location);
    const apiKey = providerApiKey(row);
    gateway.register(
      new OpenAICompatibleProvider({
        id: row.id,
        baseUrl: row.baseUrl,
        model: row.model,
        location: row.location,
        capabilities: ["chat"],
        ...(apiKey ? { apiKey } : {}),
        timeoutMs: row.timeoutMs
      })
    );
  }
  return gateway;
}
