import { readDatabaseReadiness } from "../../../../lib/health";

export const runtime = "nodejs";

export async function GET() {
  const database = await readDatabaseReadiness();
  if (!database.ready)
    return Response.json(
      { status: "degraded", service: "wknowledge-web", code: database.code },
      { status: 503 }
    );
  return Response.json({ status: "ready", service: "wknowledge-web" });
}
