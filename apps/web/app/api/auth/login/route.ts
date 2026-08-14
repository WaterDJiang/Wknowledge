import { cookies } from "next/headers";
import { login } from "@wknowledge/auth";
import { loginInputSchema } from "@wknowledge/contracts";
import { apiError, SESSION_COOKIE } from "../../../../lib/api";
import { enforcePublicMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const parsed = loginInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return apiError(
      400,
      "INPUT_INVALID",
      "邮箱或密码格式不正确",
      undefined,
      parsed.error.flatten()
    );
  const securityError = await enforcePublicMutation(
    request,
    "auth.login",
    parsed.data.email.trim().toLowerCase(),
    { limit: 5, windowSeconds: 600 }
  );
  if (securityError) return securityError;
  const session = await login(parsed.data.email, parsed.data.password);
  if (!session) return apiError(401, "AUTH_INVALID", "邮箱或密码错误");
  const store = await cookies();
  store.set(SESSION_COOKIE, session.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    expires: session.expiresAt,
    path: "/"
  });
  return Response.json({ user: session.user });
}
