import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  hasAvailableAsrProvider,
  hasAvailableVisionProvider,
  isAsrProviderLocationCompatible,
  isVisionProviderLocationCompatible
} from "../src/asr-provider-availability";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";

const test = process.env.DATABASE_URL ? it : it.skip;

afterAll(async () => closeDatabase());

describe("ASR Provider availability", () => {
  it("applies the same local/cloud data-policy matrix everywhere", () => {
    expect(isAsrProviderLocationCompatible("local", "local_only")).toBe(true);
    expect(isAsrProviderLocationCompatible("local", "cloud_allowed_after_redaction")).toBe(true);
    expect(isAsrProviderLocationCompatible("cloud", "local_only")).toBe(false);
    expect(isAsrProviderLocationCompatible("cloud", "cloud_allowed_after_redaction")).toBe(false);
    expect(isAsrProviderLocationCompatible("cloud", "cloud_allowed")).toBe(true);
  });

  it("allows vision cloud routing only when image pixels are explicitly cloud-allowed", () => {
    expect(isVisionProviderLocationCompatible("local", "local_only")).toBe(true);
    expect(isVisionProviderLocationCompatible("local", "cloud_allowed_after_redaction")).toBe(true);
    expect(isVisionProviderLocationCompatible("cloud", "local_only")).toBe(false);
    expect(isVisionProviderLocationCompatible("cloud", "cloud_allowed_after_redaction")).toBe(
      false
    );
    expect(isVisionProviderLocationCompatible("cloud", "cloud_allowed")).toBe(true);
  });

  test("requires enabled, healthy, capable and policy-compatible providers", async () => {
    const db = getDatabase();
    const organizationId = randomUUID();
    const userId = randomUUID();
    try {
      await db.insert(schema.organizations).values({ id: organizationId, name: "ASR 可用性测试" });
      await db.insert(schema.users).values({
        id: userId,
        email: `asr-availability-${userId}@example.com`,
        name: "ASR 测试用户",
        passwordHash: "not-used"
      });
      await db.insert(schema.modelProviders).values([
        {
          organizationId,
          name: "云端 ASR",
          capabilities: ["speech_to_text"],
          location: "cloud",
          baseUrl: "https://asr.example.test/v1",
          model: "whisper",
          health: "healthy",
          createdBy: userId
        },
        {
          organizationId,
          name: "停用本地 ASR",
          capabilities: ["speech_to_text"],
          location: "local",
          baseUrl: "http://127.0.0.1:9000/v1",
          model: "whisper",
          enabled: false,
          health: "healthy",
          createdBy: userId
        },
        {
          organizationId,
          name: "不健康本地 ASR",
          capabilities: ["speech_to_text"],
          location: "local",
          baseUrl: "http://127.0.0.1:9001/v1",
          model: "whisper",
          health: "unhealthy",
          createdBy: userId
        }
      ]);
      await expect(hasAvailableAsrProvider(organizationId, "local_only")).resolves.toBe(false);
      await expect(hasAvailableAsrProvider(organizationId, "cloud_allowed")).resolves.toBe(true);
      await db.insert(schema.modelProviders).values({
        organizationId,
        name: "健康本地 ASR",
        capabilities: ["speech_to_text"],
        location: "local",
        baseUrl: "http://127.0.0.1:9002/v1",
        model: "whisper",
        health: "healthy",
        createdBy: userId
      });
      await expect(hasAvailableAsrProvider(organizationId, "local_only")).resolves.toBe(true);
      await expect(
        hasAvailableAsrProvider(organizationId, "cloud_allowed_after_redaction")
      ).resolves.toBe(true);
      await db.insert(schema.modelProviders).values({
        organizationId,
        name: "云端视觉",
        capabilities: ["vision"],
        location: "cloud",
        baseUrl: "https://vision.example.test/v1",
        model: "vision-model",
        health: "healthy",
        createdBy: userId
      });
      await expect(hasAvailableVisionProvider(organizationId, "local_only")).resolves.toBe(false);
      await expect(
        hasAvailableVisionProvider(organizationId, "cloud_allowed_after_redaction")
      ).resolves.toBe(false);
      await expect(hasAvailableVisionProvider(organizationId, "cloud_allowed")).resolves.toBe(true);
    } finally {
      await db.delete(schema.organizations).where(eq(schema.organizations.id, organizationId));
    }
  });
});
