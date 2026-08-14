import { sql } from "drizzle-orm";
import { getDatabase } from "./index";

const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

export interface WikiPublicationLease {
  spaceId: string;
  ownerToken: string;
  operation: string;
  expiresAt: Date;
}

export interface WikiPublicationLeaseOptions {
  leaseMs?: number;
  heartbeatMs?: number;
}

export async function acquireWikiPublicationLease(
  spaceId: string,
  ownerToken: string,
  operation: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<WikiPublicationLease | null> {
  const expiresAt = new Date(Date.now() + leaseMs);
  const result = await getDatabase().execute(sql`
    INSERT INTO wiki_publication_lock (space_id, owner_token, operation, expires_at)
    VALUES (${spaceId}::uuid, ${ownerToken}, ${operation}, ${expiresAt})
    ON CONFLICT (space_id) DO UPDATE
      SET owner_token = EXCLUDED.owner_token,
          operation = EXCLUDED.operation,
          acquired_at = now(),
          heartbeat_at = now(),
          expires_at = EXCLUDED.expires_at
      WHERE wiki_publication_lock.expires_at <= now()
    RETURNING space_id, owner_token, operation, expires_at
  `);
  const row = result.rows[0] as
    { space_id: string; owner_token: string; operation: string; expires_at: Date } | undefined;
  if (!row) return null;
  return {
    spaceId: row.space_id,
    ownerToken: row.owner_token,
    operation: row.operation,
    expiresAt: new Date(row.expires_at)
  };
}

export async function heartbeatWikiPublicationLease(
  lease: WikiPublicationLease,
  leaseMs = DEFAULT_LEASE_MS
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + leaseMs);
  const result = await getDatabase().execute(sql`
    UPDATE wiki_publication_lock
      SET heartbeat_at = now(), expires_at = ${expiresAt}
      WHERE space_id = ${lease.spaceId}::uuid
        AND owner_token = ${lease.ownerToken}
        AND expires_at > now()
    RETURNING space_id
  `);
  return result.rows.length === 1;
}

export async function releaseWikiPublicationLease(lease: WikiPublicationLease): Promise<void> {
  await getDatabase().execute(sql`
    DELETE FROM wiki_publication_lock
      WHERE space_id = ${lease.spaceId}::uuid AND owner_token = ${lease.ownerToken}
  `);
}

/**
 * Runs one space-scoped publication operation while its PostgreSQL lease is held.
 * The callback must only publish data for the supplied space.
 */
export async function withWikiPublicationLease<T>(
  spaceId: string,
  operation: string,
  work: () => Promise<T>,
  options: WikiPublicationLeaseOptions = {}
): Promise<T> {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
  const lease = await acquireWikiPublicationLease(spaceId, crypto.randomUUID(), operation, leaseMs);
  if (!lease) throw new Error("WIKI_PUBLICATION_LOCKED");

  let leaseLost = false;
  let heartbeatRunning = false;
  const heartbeatMs = Math.max(
    1,
    Math.min(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, Math.floor(leaseMs / 2))
  );
  const heartbeat = async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      if (!(await heartbeatWikiPublicationLease(lease, leaseMs))) leaseLost = true;
    } catch {
      leaseLost = true;
    } finally {
      heartbeatRunning = false;
    }
  };
  const timer = setInterval(() => void heartbeat(), heartbeatMs);

  try {
    const result = await work();
    if (leaseLost) throw new Error("WIKI_PUBLICATION_LEASE_LOST");
    return result;
  } finally {
    clearInterval(timer);
    await releaseWikiPublicationLease(lease);
  }
}
