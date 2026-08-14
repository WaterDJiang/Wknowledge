import { desc, eq } from "drizzle-orm";
import { getDatabase, schema } from "./index";

export interface WorkerHeartbeat {
  instanceId: string;
  startedAt: Date;
  heartbeatAt: Date;
}

export async function recordWorkerHeartbeat(input: WorkerHeartbeat): Promise<void> {
  await getDatabase()
    .insert(schema.workerHeartbeats)
    .values({ ...input, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.workerHeartbeats.instanceId,
      set: { heartbeatAt: input.heartbeatAt, updatedAt: new Date() }
    });
}

export async function removeWorkerHeartbeat(instanceId: string): Promise<void> {
  await getDatabase()
    .delete(schema.workerHeartbeats)
    .where(eq(schema.workerHeartbeats.instanceId, instanceId));
}

export async function readLatestWorkerHeartbeat(): Promise<WorkerHeartbeat | null> {
  const [heartbeat] = await getDatabase()
    .select({
      instanceId: schema.workerHeartbeats.instanceId,
      startedAt: schema.workerHeartbeats.startedAt,
      heartbeatAt: schema.workerHeartbeats.heartbeatAt
    })
    .from(schema.workerHeartbeats)
    .orderBy(desc(schema.workerHeartbeats.heartbeatAt))
    .limit(1);
  return heartbeat ?? null;
}
