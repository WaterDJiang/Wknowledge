import path from "node:path";
import { and, desc, eq } from "drizzle-orm";
import {
  managedModelProviderSchema,
  managedSkillSchema,
  type CreateModelProviderInput,
  type ManagedModelProvider,
  type ManagedSkill,
  type SkillManifest,
  type UpdateModelProviderInput
} from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";
import {
  ModelGateway,
  OpenAICompatibleProvider,
  assertProviderEndpoint,
  createChatGatewayFromEnv,
  decryptCredential,
  encryptCredential,
  validateProviderEndpoint
} from "@wknowledge/model-gateway";
import { createModelInvocationBudgetGuard } from "@wknowledge/core";
import { discoverManagedDynamicSkills, discoverSkillManifests } from "@wknowledge/skill-runtime";

function credentialKey(): string | undefined {
  return process.env.WKNOWLEDGE_CREDENTIAL_KEY;
}

function publicProvider(row: typeof schema.modelProviders.$inferSelect): ManagedModelProvider {
  return managedModelProviderSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    capabilities: row.capabilities,
    location: row.location,
    baseUrl: row.baseUrl,
    model: row.model,
    enabled: row.enabled,
    hasApiKey: Boolean(row.encryptedApiKey),
    timeoutMs: row.timeoutMs,
    health: row.health,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString()
  });
}

function encryptedApiKey(apiKey: string | undefined) {
  if (!apiKey) return {};
  const key = credentialKey();
  if (!key) throw new Error("CREDENTIAL_KEY_REQUIRED");
  const encrypted = encryptCredential(apiKey, key);
  return {
    encryptedApiKey: encrypted.ciphertext,
    credentialIv: encrypted.iv,
    credentialTag: encrypted.tag
  };
}

export async function listManagedProviders(organizationId: string) {
  const rows = await getDatabase()
    .select()
    .from(schema.modelProviders)
    .where(eq(schema.modelProviders.organizationId, organizationId))
    .orderBy(desc(schema.modelProviders.updatedAt));
  return rows.map(publicProvider);
}

export async function createManagedProvider(
  organizationId: string,
  userId: string,
  input: CreateModelProviderInput
) {
  await assertProviderEndpoint(input.baseUrl, input.location);
  const [row] = await getDatabase()
    .insert(schema.modelProviders)
    .values({
      organizationId,
      createdBy: userId,
      name: input.name,
      capabilities: input.capabilities,
      location: input.location,
      baseUrl: input.baseUrl,
      model: input.model,
      enabled: input.enabled,
      timeoutMs: input.timeoutMs,
      ...encryptedApiKey(input.apiKey)
    })
    .returning();
  if (!row) throw new Error("MODEL_PROVIDER_CREATE_FAILED");
  await auditSetting(organizationId, userId, "model_provider.created", row.id);
  return publicProvider(row);
}

export async function updateManagedProvider(
  organizationId: string,
  userId: string,
  providerId: string,
  input: UpdateModelProviderInput
) {
  const [existing] = await getDatabase()
    .select()
    .from(schema.modelProviders)
    .where(
      and(
        eq(schema.modelProviders.id, providerId),
        eq(schema.modelProviders.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!existing) throw new Error("MODEL_PROVIDER_NOT_FOUND");
  if (
    (input.location ?? existing.location) === "cloud" &&
    !input.apiKey &&
    !existing.encryptedApiKey
  )
    throw new Error("CLOUD_PROVIDER_API_KEY_REQUIRED");
  const location = input.location ?? existing.location;
  const baseUrl = input.baseUrl ?? existing.baseUrl;
  const endpointChanged = baseUrl !== existing.baseUrl || location !== existing.location;
  if (endpointChanged && existing.encryptedApiKey && !input.apiKey)
    throw new Error("MODEL_PROVIDER_API_KEY_REAUTH_REQUIRED");
  await assertProviderEndpoint(baseUrl, location);
  const connectionChanged = Boolean(
    input.location ||
    input.baseUrl ||
    input.model ||
    input.apiKey ||
    input.timeoutMs ||
    input.capabilities
  );
  const [row] = await getDatabase()
    .update(schema.modelProviders)
    .set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.capabilities ? { capabilities: input.capabilities } : {}),
      ...(input.location ? { location: input.location } : {}),
      ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.apiKey ? encryptedApiKey(input.apiKey) : {}),
      health: connectionChanged ? "unknown" : existing.health,
      lastCheckedAt: connectionChanged ? null : existing.lastCheckedAt,
      updatedAt: new Date()
    })
    .where(
      and(
        eq(schema.modelProviders.id, providerId),
        eq(schema.modelProviders.organizationId, organizationId)
      )
    )
    .returning();
  if (!row) throw new Error("MODEL_PROVIDER_NOT_FOUND");
  await auditSetting(organizationId, userId, "model_provider.updated", row.id);
  return publicProvider(row);
}

function providerApiKey(row: typeof schema.modelProviders.$inferSelect): string | undefined {
  if (!row.encryptedApiKey || !row.credentialIv || !row.credentialTag) return undefined;
  const key = credentialKey();
  if (!key) throw new Error("CREDENTIAL_KEY_REQUIRED");
  return decryptCredential(
    { ciphertext: row.encryptedApiKey, iv: row.credentialIv, tag: row.credentialTag },
    key
  );
}

function adapter(row: typeof schema.modelProviders.$inferSelect) {
  validateProviderEndpoint(row.baseUrl, row.location);
  const apiKey = providerApiKey(row);
  return new OpenAICompatibleProvider({
    id: row.id,
    baseUrl: row.baseUrl,
    model: row.model,
    location: row.location,
    capabilities: row.capabilities as ("chat" | "speech_to_text")[],
    ...(apiKey ? { apiKey } : {}),
    timeoutMs: row.timeoutMs
  });
}

export async function testManagedProvider(
  organizationId: string,
  userId: string,
  providerId: string
) {
  const [row] = await getDatabase()
    .select()
    .from(schema.modelProviders)
    .where(
      and(
        eq(schema.modelProviders.id, providerId),
        eq(schema.modelProviders.organizationId, organizationId)
      )
    )
    .limit(1);
  if (!row) throw new Error("MODEL_PROVIDER_NOT_FOUND");
  const healthy = await adapter(row).healthcheck();
  const [updated] = await getDatabase()
    .update(schema.modelProviders)
    .set({
      health: healthy ? "healthy" : "unhealthy",
      lastCheckedAt: new Date(),
      updatedAt: new Date()
    })
    .where(eq(schema.modelProviders.id, row.id))
    .returning();
  await auditSetting(organizationId, userId, "model_provider.tested", row.id, { healthy });
  if (!updated) throw new Error("MODEL_PROVIDER_NOT_FOUND");
  return publicProvider(updated);
}

export async function createManagedChatGateway(organizationId: string, userId?: string) {
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
  const beforeInvoke = createModelInvocationBudgetGuard({
    organizationId,
    ...(userId ? { userId } : {})
  });
  if (rows.length === 0) return createChatGatewayFromEnv(process.env, undefined, { beforeInvoke });
  const gateway = new ModelGateway({ beforeInvoke });
  for (const row of rows) gateway.register(adapter(row));
  return gateway;
}

function workspaceRoot(): string {
  return process.env.WKNOWLEDGE_WORKSPACE_ROOT ?? path.resolve(process.cwd(), "../..");
}

function builtinSkillsRoot(): string {
  return path.join(workspaceRoot(), "skills/builtin");
}

function installedSkillsRoot(): string {
  return path.join(workspaceRoot(), "skills/installed");
}

type ManagedSkillDefinition = {
  manifest: SkillManifest;
  origin: "builtin" | "installed";
};

export async function discoverManagedSkillDefinitions(input?: {
  builtinRoot?: string;
  installedRoot?: string;
}): Promise<ManagedSkillDefinition[]> {
  const [builtin, installed] = await Promise.all([
    discoverSkillManifests(input?.builtinRoot ?? builtinSkillsRoot()),
    discoverManagedDynamicSkills(input?.installedRoot ?? installedSkillsRoot())
  ]);
  const builtinIds = new Set(builtin.map(({ id }) => id));
  return [
    ...builtin.map((manifest) => ({ manifest, origin: "builtin" as const })),
    ...installed
      .filter(({ manifest }) => !builtinIds.has(manifest.id))
      .map(({ manifest }) => ({ manifest, origin: "installed" as const }))
  ].sort((left, right) => left.manifest.id.localeCompare(right.manifest.id));
}

export async function listManagedSkills(organizationId: string): Promise<ManagedSkill[]> {
  const [manifests, installations] = await Promise.all([
    discoverManagedSkillDefinitions(),
    getDatabase()
      .select()
      .from(schema.skillInstallations)
      .where(eq(schema.skillInstallations.organizationId, organizationId))
  ]);
  const enabledById = new Map(installations.map((item) => [item.skillId, item.enabled]));
  return manifests.map(({ manifest, origin }) =>
    managedSkillSchema.parse({
      id: manifest.id,
      version: manifest.version,
      digest: manifest.digest,
      description: manifest.description,
      enabled: enabledById.get(manifest.id) ?? true,
      requiredCapabilities: manifest.requiredCapabilities,
      permissions: manifest.permissions,
      limits: manifest.limits,
      origin
    })
  );
}

export async function setManagedSkillEnabled(
  organizationId: string,
  userId: string,
  skillId: string,
  enabled: boolean
) {
  const definition = (await discoverManagedSkillDefinitions()).find(
    ({ manifest }) => manifest.id === skillId
  );
  if (!definition) throw new Error("SKILL_NOT_FOUND");
  const { manifest } = definition;
  await getDatabase()
    .insert(schema.skillInstallations)
    .values({
      organizationId,
      skillId,
      version: manifest.version,
      digest: manifest.digest,
      enabled,
      updatedBy: userId
    })
    .onConflictDoUpdate({
      target: [schema.skillInstallations.organizationId, schema.skillInstallations.skillId],
      set: {
        version: manifest.version,
        digest: manifest.digest,
        enabled,
        updatedBy: userId,
        updatedAt: new Date()
      }
    });
  await auditSetting(organizationId, userId, "skill.updated", skillId, { enabled });
  return (await listManagedSkills(organizationId)).find((item) => item.id === skillId)!;
}

export async function isManagedSkillEnabled(organizationId: string, skillId: string) {
  const [installation] = await getDatabase()
    .select({ enabled: schema.skillInstallations.enabled })
    .from(schema.skillInstallations)
    .where(
      and(
        eq(schema.skillInstallations.organizationId, organizationId),
        eq(schema.skillInstallations.skillId, skillId)
      )
    )
    .limit(1);
  return installation?.enabled ?? true;
}

export async function getManagedSkill(organizationId: string, skillId: string) {
  return (await listManagedSkills(organizationId)).find((skill) => skill.id === skillId) ?? null;
}

async function auditSetting(
  organizationId: string,
  userId: string,
  action: string,
  targetId: string,
  metadata: Record<string, unknown> = {}
) {
  await getDatabase().insert(schema.auditEvents).values({
    organizationId,
    actorUserId: userId,
    action,
    targetType: "settings",
    targetId,
    metadata
  });
}
