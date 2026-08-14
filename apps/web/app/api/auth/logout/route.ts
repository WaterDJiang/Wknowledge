import { cookies } from "next/headers";
import { revoke } from "@wknowledge/auth";
import { currentUser, SESSION_COOKIE } from "../../../../lib/api";
import { enforceAuthenticatedMutation } from "../../../../lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const user = await currentUser();
  if (user) {
    const securityError = await enforceAuthenticatedMutation(request, user.id, "auth.logout");
    if (securityError) return securityError;
  }
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revoke(token);
  store.delete(SESSION_COOKIE);
  return new Response(null, { status: 204 });
}
