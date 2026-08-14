import { randomUUID } from "node:crypto";
import path from "node:path";
import { cookies } from "next/headers";
import { authenticate } from "@wknowledge/auth";

export const SESSION_COOKIE = "wknowledge_session";

export async function currentUser() {
  const store = await cookies();
  return authenticate(store.get(SESSION_COOKIE)?.value);
}

export function apiError(
  status: number,
  code: string,
  message: string,
  suggestion?: string,
  details?: unknown
) {
  return Response.json(
    {
      code,
      message,
      ...(suggestion ? { suggestion } : {}),
      requestId: randomUUID(),
      ...(details === undefined ? {} : { details })
    },
    { status }
  );
}

export function dataRoot(): string {
  return process.env.WKNOWLEDGE_DATA_ROOT ?? path.resolve(process.cwd(), "../../data/spaces");
}

export function blobRoot(): string {
  return process.env.WKNOWLEDGE_BLOB_ROOT ?? path.resolve(process.cwd(), "../../data/blobs");
}
