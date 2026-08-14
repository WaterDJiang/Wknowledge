import type { DataPolicy, ModelCapability } from "@wknowledge/contracts";
import { consumeRequestRateLimits } from "@wknowledge/database";

const DAY_SECONDS = 24 * 60 * 60;
const MAX_LIMIT = 1_000_000;

export interface ModelInvocationBudgetLimits {
  organizationDailyLimit: number;
  providerDailyLimit: number;
  userDailyLimit: number;
}

export interface ModelInvocationGuardInput {
  providerId: string;
  capability: ModelCapability;
  purpose: string;
  dataPolicy: DataPolicy;
}

export type ModelInvocationGuard = (input: ModelInvocationGuardInput) => Promise<void>;

export const DEFAULT_MODEL_INVOCATION_BUDGET_LIMITS: Readonly<ModelInvocationBudgetLimits> = {
  organizationDailyLimit: 600,
  providerDailyLimit: 300,
  userDailyLimit: 60
};

function configuredLimit(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_LIMIT ? parsed : fallback;
}

export function readModelInvocationBudgetLimits(
  environment: NodeJS.ProcessEnv = process.env
): ModelInvocationBudgetLimits {
  return {
    organizationDailyLimit: configuredLimit(
      environment.WKNOWLEDGE_MODEL_ORGANIZATION_DAILY_LIMIT,
      DEFAULT_MODEL_INVOCATION_BUDGET_LIMITS.organizationDailyLimit
    ),
    providerDailyLimit: configuredLimit(
      environment.WKNOWLEDGE_MODEL_PROVIDER_DAILY_LIMIT,
      DEFAULT_MODEL_INVOCATION_BUDGET_LIMITS.providerDailyLimit
    ),
    userDailyLimit: configuredLimit(
      environment.WKNOWLEDGE_MODEL_USER_DAILY_LIMIT,
      DEFAULT_MODEL_INVOCATION_BUDGET_LIMITS.userDailyLimit
    )
  };
}

export function createModelInvocationBudgetGuard(input: {
  organizationId: string;
  userId?: string;
  limits?: ModelInvocationBudgetLimits;
  consume?: typeof consumeRequestRateLimits;
}): ModelInvocationGuard {
  const limits = input.limits ?? readModelInvocationBudgetLimits();
  const consume = input.consume ?? consumeRequestRateLimits;
  return async ({ providerId }) => {
    const entries = [
      {
        scope: "model.invocation.organization.day",
        subject: input.organizationId,
        limit: limits.organizationDailyLimit,
        windowSeconds: DAY_SECONDS
      },
      {
        scope: "model.invocation.provider.day",
        subject: `${input.organizationId}:${providerId}`,
        limit: limits.providerDailyLimit,
        windowSeconds: DAY_SECONDS
      },
      ...(input.userId
        ? [
            {
              scope: "model.invocation.user.day",
              subject: `${input.organizationId}:${input.userId}`,
              limit: limits.userDailyLimit,
              windowSeconds: DAY_SECONDS
            }
          ]
        : [])
    ];
    const result = await consume(entries);
    if (!result.allowed)
      throw new Error(
        result.deniedScope === "model.invocation.provider.day"
          ? "MODEL_PROVIDER_BUDGET_EXCEEDED"
          : "MODEL_BUDGET_EXCEEDED"
      );
  };
}
