import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_INVOCATION_BUDGET_LIMITS,
  createModelInvocationBudgetGuard,
  readModelInvocationBudgetLimits
} from "../src";

describe("model invocation budget", () => {
  it("uses safe defaults when environment limits are missing or invalid", () => {
    expect(readModelInvocationBudgetLimits({})).toEqual(DEFAULT_MODEL_INVOCATION_BUDGET_LIMITS);
    expect(
      readModelInvocationBudgetLimits({
        WKNOWLEDGE_MODEL_ORGANIZATION_DAILY_LIMIT: "0",
        WKNOWLEDGE_MODEL_PROVIDER_DAILY_LIMIT: "not-a-number",
        WKNOWLEDGE_MODEL_USER_DAILY_LIMIT: "1000001"
      })
    ).toEqual(DEFAULT_MODEL_INVOCATION_BUDGET_LIMITS);
  });

  it("consumes organization, provider and user budgets before the provider call", async () => {
    let received: unknown;
    const consume = async (entries: unknown) => {
      received = entries;
      return { allowed: true, retryAfterSeconds: 0 };
    };
    const guard = createModelInvocationBudgetGuard({
      organizationId: "org-a",
      userId: "user-a",
      limits: { organizationDailyLimit: 10, providerDailyLimit: 5, userDailyLimit: 2 },
      consume
    });
    await guard({
      providerId: "provider-a",
      capability: "chat",
      purpose: "agent",
      dataPolicy: "local_only"
    });
    expect(received).toEqual([
      expect.objectContaining({
        scope: "model.invocation.organization.day",
        subject: "org-a",
        limit: 10
      }),
      expect.objectContaining({
        scope: "model.invocation.provider.day",
        subject: "org-a:provider-a",
        limit: 5
      }),
      expect.objectContaining({
        scope: "model.invocation.user.day",
        subject: "org-a:user-a",
        limit: 2
      })
    ]);
  });

  it("keeps worker budgets scoped to organization and provider without inventing a user", async () => {
    let received: unknown;
    const consume = async (entries: unknown) => {
      received = entries;
      return { allowed: false, retryAfterSeconds: 86_400 };
    };
    const guard = createModelInvocationBudgetGuard({ organizationId: "org-a", consume });
    await expect(
      guard({
        providerId: "provider-a",
        capability: "speech_to_text",
        purpose: "speech_to_text",
        dataPolicy: "local_only"
      })
    ).rejects.toThrow("MODEL_BUDGET_EXCEEDED");
    expect(received).toHaveLength(2);
  });
});
