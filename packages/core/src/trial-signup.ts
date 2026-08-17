import { createHmac, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { hashPassword } from "@wknowledge/auth";
import { getDatabase, schema } from "@wknowledge/database";
import { initializeSpace } from "@wknowledge/wiki";

const verificationCodeLifetimeMs = 10 * 60 * 1_000;

export interface SignupCodeSender {
  (input: { email: string; code: string }): Promise<void>;
}

function codeHash(email: string, code: string, key: string): string {
  return createHmac("sha256", key).update(`${email}:${code}`).digest("hex");
}

function createVerificationCode(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function requireCredentialKey(value: string | undefined): string {
  const key = value?.trim();
  if (!key || key.length < 32) throw new Error("SIGNUP_CREDENTIAL_KEY_REQUIRED");
  return key;
}

export async function requestTrialSignupCode(input: {
  email: string;
  credentialKey: string | undefined;
  sendCode: SignupCodeSender;
}) {
  const db = getDatabase();
  const email = input.email.toLowerCase();
  const key = requireCredentialKey(input.credentialKey);
  const [existing] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) throw new Error("SIGNUP_EMAIL_EXISTS");

  const code = createVerificationCode();
  const [verification] = await db
    .insert(schema.signupVerificationCodes)
    .values({
      email,
      codeHash: codeHash(email, code, key),
      expiresAt: new Date(Date.now() + verificationCodeLifetimeMs)
    })
    .returning({ id: schema.signupVerificationCodes.id });
  if (!verification) throw new Error("SIGNUP_CODE_CREATE_FAILED");

  try {
    await input.sendCode({ email, code });
  } catch (error) {
    await db
      .delete(schema.signupVerificationCodes)
      .where(eq(schema.signupVerificationCodes.id, verification.id));
    throw error;
  }
}

export async function completeTrialSignup(input: {
  email: string;
  code: string;
  name: string;
  password: string;
  credentialKey: string | undefined;
  dataRoot: string;
}) {
  const db = getDatabase();
  const email = input.email.toLowerCase();
  const key = requireCredentialKey(input.credentialKey);
  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (existing) throw new Error("SIGNUP_EMAIL_EXISTS");

    const [verification] = await tx
      .select()
      .from(schema.signupVerificationCodes)
      .where(
        and(
          eq(schema.signupVerificationCodes.email, email),
          eq(schema.signupVerificationCodes.codeHash, codeHash(email, input.code, key)),
          isNull(schema.signupVerificationCodes.consumedAt),
          gt(schema.signupVerificationCodes.expiresAt, new Date())
        )
      )
      .orderBy(desc(schema.signupVerificationCodes.createdAt))
      .limit(1);
    if (!verification) throw new Error("SIGNUP_CODE_INVALID");

    const [consumed] = await tx
      .update(schema.signupVerificationCodes)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(schema.signupVerificationCodes.id, verification.id),
          isNull(schema.signupVerificationCodes.consumedAt)
        )
      )
      .returning({ id: schema.signupVerificationCodes.id });
    if (!consumed) throw new Error("SIGNUP_CODE_INVALID");

    const [user] = await tx
      .insert(schema.users)
      .values({ email, name: input.name, passwordHash: await hashPassword(input.password) })
      .returning();
    if (!user) throw new Error("SIGNUP_USER_CREATE_FAILED");
    const [organization] = await tx
      .insert(schema.organizations)
      .values({ name: `${input.name} 的试用组织` })
      .returning();
    if (!organization) throw new Error("SIGNUP_ORGANIZATION_CREATE_FAILED");
    await tx.insert(schema.organizationMemberships).values({
      organizationId: organization.id,
      userId: user.id,
      role: "owner"
    });
    const [space] = await tx
      .insert(schema.knowledgeSpaces)
      .values({
        organizationId: organization.id,
        createdBy: user.id,
        name: "我的知识库",
        description: "个人试用知识空间",
        dataPolicy: "local_only"
      })
      .returning();
    if (!space) throw new Error("SIGNUP_SPACE_CREATE_FAILED");
    await tx
      .insert(schema.spaceMemberships)
      .values({ spaceId: space.id, userId: user.id, role: "owner" });
    await tx.insert(schema.auditEvents).values({
      organizationId: organization.id,
      actorUserId: user.id,
      action: "organization.trial.signup",
      targetType: "user",
      targetId: user.id
    });
    return { user, space };
  });
  await initializeSpace(input.dataRoot, result.space.id);
  return result;
}
