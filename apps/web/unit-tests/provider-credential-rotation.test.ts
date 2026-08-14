import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";
import { updateManagedProvider } from "../lib/settings";

const test = process.env.DATABASE_URL ? it : it.skip;

afterAll(async () => closeDatabase());

describe("managed provider credential rotation", () => {
  test("does not retain an API key when an administrator changes the endpoint", async () => {
    const db = getDatabase();
    const organizationId = randomUUID();
    const userId = randomUUID();
    const providerId = randomUUID();
    await db.insert(schema.organizations).values({ id: organizationId, name: "Provider 安全组织" });
    await db.insert(schema.users).values({
      id: userId,
      email: `provider-${userId}@example.com`,
      name: "Provider 管理员",
      passwordHash: "not-used"
    });
    await db.insert(schema.modelProviders).values({
      id: providerId,
      organizationId,
      name: "本地 Provider",
      location: "local",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen",
      encryptedApiKey: "retained-key-ciphertext",
      credentialIv: "retained-key-iv",
      credentialTag: "retained-key-tag",
      createdBy: userId
    });
    try {
      await expect(
        updateManagedProvider(organizationId, userId, providerId, {
          baseUrl: "http://127.0.0.1:11435/v1"
        })
      ).rejects.toThrow("MODEL_PROVIDER_API_KEY_REAUTH_REQUIRED");
      const [stored] = await db
        .select({
          baseUrl: schema.modelProviders.baseUrl,
          encryptedApiKey: schema.modelProviders.encryptedApiKey
        })
        .from(schema.modelProviders)
        .where(eq(schema.modelProviders.id, providerId));
      expect(stored).toEqual({
        baseUrl: "http://127.0.0.1:11434/v1",
        encryptedApiKey: "retained-key-ciphertext"
      });
    } finally {
      await db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
      await db.delete(schema.users).where(eq(schema.users.id, userId));
    }
  });
});
