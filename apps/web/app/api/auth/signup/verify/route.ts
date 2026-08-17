import { cookies } from "next/headers";
import { createSession } from "@wknowledge/auth";
import { completeSignupInputSchema } from "@wknowledge/contracts";
import { completeTrialSignup } from "@wknowledge/core";
import { apiError, dataRoot, SESSION_COOKIE } from "../../../../../lib/api";
import { enforcePublicMutation } from "../../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (process.env.WKNOWLEDGE_ALLOW_SIGNUP !== "true")
    return apiError(403, "SIGNUP_DISABLED", "当前暂未开放注册");
  const parsed = completeSignupInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INPUT_INVALID", "注册信息不正确");
  const securityError = await enforcePublicMutation(
    request,
    "auth.signup.verify",
    parsed.data.email,
    {
      limit: 10,
      windowSeconds: 600
    }
  );
  if (securityError) return securityError;
  try {
    const result = await completeTrialSignup({
      ...parsed.data,
      credentialKey: process.env.WKNOWLEDGE_CREDENTIAL_KEY,
      dataRoot: dataRoot()
    });
    const session = await createSession({
      id: result.user.id,
      email: result.user.email,
      name: result.user.name
    });
    const store = await cookies();
    store.set(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      expires: session.expiresAt,
      path: "/"
    });
    return Response.json({
      user: session.user,
      space: { id: result.space.id, name: result.space.name }
    });
  } catch (error) {
    const code = error instanceof Error ? error.message : "SIGNUP_FAILED";
    if (code === "SIGNUP_CODE_INVALID") return apiError(400, code, "验证码错误、已使用或已过期");
    if (code === "SIGNUP_EMAIL_EXISTS") return apiError(409, code, "该邮箱已有账号，请直接登录");
    return apiError(503, "SIGNUP_FAILED", "注册暂时不可用，请稍后重试");
  }
}
