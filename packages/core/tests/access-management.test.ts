import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  acceptOrganizationInvitation,
  createOrganizationInvitation,
  listSpaces,
  listOrganizationInvitations,
  removeSpaceMember,
  setOrganizationUserDisabled,
  setSpaceMemberRole
} from "../src/index";
import {
  getManagedOrganization,
  hashPassword,
  requireOrganizationRole,
  requireSpaceRole
} from "@wknowledge/auth";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";

const enabled = Boolean(process.env.DATABASE_URL);
const test = enabled ? it : it.skip;

async function fixture() {
  const db = getDatabase();
  const organizationId = randomUUID();
  const ownerId = randomUUID();
  const spaceId = randomUUID();
  await db.insert(schema.organizations).values({ id: organizationId, name: "访问管理测试组织" });
  await db.insert(schema.users).values({
    id: ownerId,
    email: `owner-${ownerId}@example.com`,
    name: "所有者",
    passwordHash: await hashPassword("owner-password")
  });
  await db.insert(schema.organizationMemberships).values({
    organizationId,
    userId: ownerId,
    role: "owner"
  });
  await db.insert(schema.knowledgeSpaces).values({
    id: spaceId,
    organizationId,
    name: "访问管理空间",
    createdBy: ownerId
  });
  await db.insert(schema.spaceMemberships).values({ spaceId, userId: ownerId, role: "owner" });
  return { db, organizationId, ownerId, spaceId };
}

afterAll(async () => closeDatabase());

describe("organization invitations and space members", () => {
  test("stores only invitation hash, accepts once, and joins the requested space", async () => {
    const value = await fixture();
    try {
      const invitation = await createOrganizationInvitation({
        organizationId: value.organizationId,
        invitedBy: value.ownerId,
        email: "new-member@example.com",
        organizationRole: "learner",
        spaceId: value.spaceId,
        spaceRole: "viewer"
      });
      expect(invitation.token).toHaveLength(43);
      const listed = await listOrganizationInvitations(value.organizationId);
      expect(listed[0]).toMatchObject({ email: "new-member@example.com", spaceId: value.spaceId });
      expect(JSON.stringify(listed)).not.toContain(invitation.token);

      const accepted = await acceptOrganizationInvitation({
        token: invitation.token,
        name: "新成员",
        password: "new-member-password"
      });
      expect(accepted.user.email).toBe("new-member@example.com");
      const [membership] = await value.db
        .select()
        .from(schema.spaceMemberships)
        .where(
          and(
            eq(schema.spaceMemberships.spaceId, value.spaceId),
            eq(schema.spaceMemberships.userId, accepted.user.id)
          )
        );
      expect(membership?.role).toBe("viewer");
      await expect(
        acceptOrganizationInvitation({ token: invitation.token, name: "重复接受" })
      ).rejects.toThrow("INVITATION_INVALID");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("disables only the current organization membership and protects other organizations", async () => {
    const value = await fixture();
    const userId = randomUUID();
    const otherOrganizationId = randomUUID();
    const otherSpaceId = randomUUID();
    try {
      await value.db.insert(schema.users).values({
        id: userId,
        email: `member-${userId}@example.com`,
        name: "普通成员",
        passwordHash: await hashPassword("member-password")
      });
      await value.db
        .insert(schema.organizationMemberships)
        .values({ organizationId: value.organizationId, userId, role: "admin" });
      await value.db.insert(schema.sessions).values({
        userId,
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 60_000)
      });
      await value.db
        .insert(schema.organizations)
        .values({ id: otherOrganizationId, name: "其他组织" });
      await value.db.insert(schema.knowledgeSpaces).values({
        id: otherSpaceId,
        organizationId: otherOrganizationId,
        name: "其他空间",
        createdBy: userId
      });
      await value.db.insert(schema.organizationMemberships).values({
        organizationId: otherOrganizationId,
        userId,
        role: "editor"
      });
      await value.db.insert(schema.spaceMemberships).values({
        spaceId: value.spaceId,
        userId,
        role: "viewer"
      });
      await value.db.insert(schema.spaceMemberships).values({
        spaceId: otherSpaceId,
        userId,
        role: "viewer"
      });
      const disabled = await setOrganizationUserDisabled({
        organizationId: value.organizationId,
        userId,
        actorUserId: value.ownerId,
        disabled: true
      });
      expect(disabled.disabled).toBe(true);
      const [user] = await value.db
        .select({ disabled: schema.users.disabled })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      expect(user?.disabled).toBe(false);
      const sessions = await value.db
        .select()
        .from(schema.sessions)
        .where(eq(schema.sessions.userId, userId));
      expect(sessions).toHaveLength(1);
      await expect(
        requireOrganizationRole(userId, value.organizationId, "viewer")
      ).resolves.toBeNull();
      await expect(requireSpaceRole(userId, value.spaceId, "viewer")).resolves.toBeNull();
      await expect(
        requireOrganizationRole(userId, otherOrganizationId, "viewer")
      ).resolves.toMatchObject({
        role: "editor"
      });
      await expect(requireSpaceRole(userId, otherSpaceId, "viewer")).resolves.toMatchObject({
        role: "viewer"
      });
      await expect(getManagedOrganization(userId)).resolves.toBeNull();
      await expect(listSpaces(userId)).resolves.toEqual([
        expect.objectContaining({ space: expect.objectContaining({ id: otherSpaceId }) })
      ]);
      await expect(
        setOrganizationUserDisabled({
          organizationId: value.organizationId,
          userId,
          actorUserId: value.ownerId,
          disabled: false
        })
      ).resolves.toMatchObject({ disabled: false });
      await expect(
        requireOrganizationRole(userId, value.organizationId, "viewer")
      ).resolves.toMatchObject({
        role: "admin"
      });
      await expect(listSpaces(userId)).resolves.toHaveLength(2);
      await expect(
        setOrganizationUserDisabled({
          organizationId: value.organizationId,
          userId,
          actorUserId: userId,
          disabled: true
        })
      ).rejects.toThrow("USER_SELF_DISABLE_FORBIDDEN");
      await expect(
        setOrganizationUserDisabled({
          organizationId: value.organizationId,
          userId,
          actorUserId: userId,
          disabled: false
        })
      ).rejects.toThrow("USER_SELF_DISABLE_FORBIDDEN");
      await expect(
        setOrganizationUserDisabled({
          organizationId: value.organizationId,
          userId: value.ownerId,
          actorUserId: userId,
          disabled: true
        })
      ).rejects.toThrow("OWNER_DISABLE_FORBIDDEN");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, otherOrganizationId));
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });

  test("updates and removes a non-owner space member but never the owner", async () => {
    const value = await fixture();
    const userId = randomUUID();
    try {
      await value.db.insert(schema.users).values({
        id: userId,
        email: `space-${userId}@example.com`,
        name: "空间成员",
        passwordHash: await hashPassword("space-password")
      });
      await value.db
        .insert(schema.organizationMemberships)
        .values({ organizationId: value.organizationId, userId, role: "editor" });
      await setSpaceMemberRole({
        organizationId: value.organizationId,
        spaceId: value.spaceId,
        userId,
        role: "viewer",
        actorUserId: value.ownerId
      });
      await setSpaceMemberRole({
        organizationId: value.organizationId,
        spaceId: value.spaceId,
        userId,
        role: "editor",
        actorUserId: value.ownerId
      });
      await removeSpaceMember({
        organizationId: value.organizationId,
        spaceId: value.spaceId,
        userId,
        actorUserId: value.ownerId
      });
      await expect(
        removeSpaceMember({
          organizationId: value.organizationId,
          spaceId: value.spaceId,
          userId: value.ownerId,
          actorUserId: value.ownerId
        })
      ).rejects.toThrow("SPACE_OWNER_MUTATION_FORBIDDEN");
    } finally {
      await value.db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, value.organizationId));
    }
  });
});
