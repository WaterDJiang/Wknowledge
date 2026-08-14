import { createHash } from "node:crypto";
import { consumeRequestRateLimit } from "@wknowledge/database";
import { apiError } from "./api";

interface RequestLimit {
  limit: number;
  windowSeconds: number;
}

const STANDARD_MUTATION_LIMIT: RequestLimit = { limit: 60, windowSeconds: 60 };
const UNVERIFIED_NETWORK_SUBJECT = createHash("sha256")
  .update("wknowledge-public-network-identity-unavailable")
  .digest("hex");

function requestOrigin(request: Request): string | null {
  const value = request.headers.get("origin");
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return "invalid";
  }
}

export function requireSameOrigin(request: Request) {
  const origin = requestOrigin(request);
  if (!origin)
    return apiError(
      403,
      "CSRF_ORIGIN_REQUIRED",
      "写入请求缺少同源验证信息",
      "请从 Wknowledge 页面重新发起操作"
    );
  const requestUrl = new URL(request.url);
  const requestHost = request.headers.get("host");
  const expectedOrigin = requestHost ? `${requestUrl.protocol}//${requestHost}` : requestUrl.origin;
  if (origin !== expectedOrigin)
    return apiError(
      403,
      "CSRF_ORIGIN_DENIED",
      "跨站写入请求已被拒绝",
      "请从当前 Wknowledge 站点重新发起操作"
    );
  return null;
}

export function publicRateLimitSubject(_request: Request, subjectSuffix: string): string {
  return `${UNVERIFIED_NETWORK_SUBJECT}:${subjectSuffix}`;
}

async function enforceRateLimit(
  request: Request,
  scope: string,
  subject: string,
  limit: RequestLimit
) {
  let result: Awaited<ReturnType<typeof consumeRequestRateLimit>>;
  try {
    result = await consumeRequestRateLimit({ scope, subject, ...limit });
  } catch {
    return apiError(503, "REQUEST_GUARD_UNAVAILABLE", "请求安全检查暂时不可用", "请稍后重试");
  }
  if (!result.allowed)
    return apiError(429, "RATE_LIMITED", "操作过于频繁，请稍后重试", "等待后再次提交", {
      retryAfterSeconds: result.retryAfterSeconds
    });
  return null;
}

export async function enforceAuthenticatedMutation(
  request: Request,
  userId: string,
  scope: string,
  limit: RequestLimit = STANDARD_MUTATION_LIMIT
) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  return enforceRateLimit(request, scope, userId, limit);
}

export async function enforcePublicMutation(
  request: Request,
  scope: string,
  subjectSuffix: string,
  limit: RequestLimit
) {
  const originError = requireSameOrigin(request);
  if (originError) return originError;
  return enforceRateLimit(request, scope, publicRateLimitSubject(request, subjectSuffix), limit);
}
