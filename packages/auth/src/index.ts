import { createHash, randomBytes } from "node:crypto";
import { compare, hash } from "bcryptjs";
import { and, eq, gt } from "drizzle-orm";
import type { Role } from "@wknowledge/contracts";
import { getDatabase, schema } from "@wknowledge/database";

export const hashPassword = (password: string): Promise<string> => hash(password, 12);

const roleRank: Record<Role, number> = {
  viewer: 0,
  learner: 1,
  editor: 2,
  admin: 3,
  owner: 4
};

export const can = (role: Role, required: Role): boolean => roleRank[role] >= roleRank[required];

export const hashSessionToken = (token: string): string =>
  createHash("sha256").update(token).digest("hex");

export async function login(email: string, password: string) {
  const db = getDatabase();
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email.toLowerCase()))
    .limit(1);
  if (!user || user.disabled || !(await compare(password, user.passwordHash))) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db
    .insert(schema.sessions)
    .values({ userId: user.id, tokenHash: hashSessionToken(token), expiresAt });
  return { token, expiresAt, user: { id: user.id, email: user.email, name: user.name } };
}

export async function authenticate(token: string | undefined) {
  if (!token) return null;
  const db = getDatabase();
  const [row] = await db
    .select({ user: schema.users, session: schema.sessions })
    .from(schema.sessions)
    .innerJoin(schema.users, eq(schema.sessions.userId, schema.users.id))
    .where(
      and(
        eq(schema.sessions.tokenHash, hashSessionToken(token)),
        gt(schema.sessions.expiresAt, new Date())
      )
    )
    .limit(1);
  if (!row || row.user.disabled) return null;
  return row.user;
}

export async function revoke(token: string): Promise<void> {
  await getDatabase()
    .delete(schema.sessions)
    .where(eq(schema.sessions.tokenHash, hashSessionToken(token)));
}

export async function requireSpaceRole(userId: string, spaceId: string, required: Role) {
  const db = getDatabase();
  const [membership] = await db
    .select({ membership: schema.spaceMemberships })
    .from(schema.spaceMemberships)
    .innerJoin(
      schema.knowledgeSpaces,
      eq(schema.spaceMemberships.spaceId, schema.knowledgeSpaces.id)
    )
    .innerJoin(
      schema.organizationMemberships,
      and(
        eq(schema.organizationMemberships.organizationId, schema.knowledgeSpaces.organizationId),
        eq(schema.organizationMemberships.userId, userId)
      )
    )
    .where(
      and(
        eq(schema.spaceMemberships.userId, userId),
        eq(schema.spaceMemberships.spaceId, spaceId),
        eq(schema.organizationMemberships.disabled, false)
      )
    )
    .limit(1);
  if (!membership || !can(membership.membership.role, required)) return null;
  return membership.membership;
}

export async function requireOrganizationRole(
  userId: string,
  organizationId: string,
  required: Role
) {
  const [membership] = await getDatabase()
    .select()
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.userId, userId),
        eq(schema.organizationMemberships.organizationId, organizationId),
        eq(schema.organizationMemberships.disabled, false)
      )
    )
    .limit(1);
  if (!membership || !can(membership.role, required)) return null;
  return membership;
}

export async function getManagedOrganization(userId: string) {
  const [membership] = await getDatabase()
    .select()
    .from(schema.organizationMemberships)
    .where(
      and(
        eq(schema.organizationMemberships.userId, userId),
        eq(schema.organizationMemberships.disabled, false)
      )
    )
    .limit(1);
  if (!membership || !can(membership.role, "admin")) return null;
  return membership;
}
