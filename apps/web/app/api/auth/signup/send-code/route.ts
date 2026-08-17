import { requestSignupCodeInputSchema } from "@wknowledge/contracts";
import { requestTrialSignupCode } from "@wknowledge/core";
import { apiError } from "../../../../../lib/api";
import { enforcePublicMutation } from "../../../../../lib/request-security";
import { createSignupCodeEmailSender } from "../../../../../lib/signup-email";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (process.env.WKNOWLEDGE_ALLOW_SIGNUP !== "true")
    return apiError(403, "SIGNUP_DISABLED", "当前暂未开放注册");
  const parsed = requestSignupCodeInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return apiError(400, "INPUT_INVALID", "请输入有效邮箱");
  const securityError = await enforcePublicMutation(
    request,
    "auth.signup.send_code",
    parsed.data.email,
    {
      limit: 5,
      windowSeconds: 600
    }
  );
  if (securityError) return securityError;
  try {
    await requestTrialSignupCode({
      email: parsed.data.email,
      credentialKey: process.env.WKNOWLEDGE_CREDENTIAL_KEY,
      sendCode: createSignupCodeEmailSender()
    });
    return Response.json({ ok: true });
  } catch (error) {
    const code = error instanceof Error ? error.message : "SIGNUP_SEND_FAILED";
    if (code === "SIGNUP_EMAIL_EXISTS") return apiError(409, code, "该邮箱已有账号，请直接登录");
    if (code === "EMAIL_DELIVERY_NOT_CONFIGURED")
      return apiError(503, code, "邮件发送服务尚未配置");
    if (code === "SMTP_AUTH_REQUIRED") return apiError(503, code, "SMTP 缺少认证配置");
    return apiError(503, "SIGNUP_SEND_FAILED", "验证码发送失败，请稍后重试");
  }
}
