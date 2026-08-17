import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { completeTrialSignup, requestTrialSignupCode } from "../src/index";
import { closeDatabase, getDatabase, schema } from "@wknowledge/database";

const test = process.env.DATABASE_URL ? it : it.skip;
const roots: string[] = [];
const credentialKey = Buffer.alloc(32, 9).toString("base64url");

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await closeDatabase();
});

describe("trial signup", () => {
  test("creates an isolated owner, organization and first space after a one-time code", async () => {
    const db = getDatabase();
    const email = `trial-${randomUUID()}@example.com`;
    const root = await mkdtemp(path.join(os.tmpdir(), "wknowledge-trial-signup-"));
    roots.push(root);
    let code = "";
    await requestTrialSignupCode({
      email,
      credentialKey,
      sendCode: async (input) => {
        code = input.code;
      }
    });
    const wrongCode = code === "000000" ? "000001" : "000000";
    await expect(
      completeTrialSignup({
        email,
        code: wrongCode,
        name: "试用用户",
        password: "trial-password",
        credentialKey,
        dataRoot: root
      })
    ).rejects.toThrow("SIGNUP_CODE_INVALID");
    const [beforeSignup] = await db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    expect(beforeSignup).toBeUndefined();
    const result = await completeTrialSignup({
      email,
      code,
      name: "试用用户",
      password: "trial-password",
      credentialKey,
      dataRoot: root
    });
    try {
      const [membership] = await db
        .select()
        .from(schema.organizationMemberships)
        .where(
          and(
            eq(schema.organizationMemberships.userId, result.user.id),
            eq(schema.organizationMemberships.organizationId, result.space.organizationId)
          )
        );
      expect(membership?.role).toBe("owner");
      expect(result.space.name).toBe("我的知识库");
      await expect(
        completeTrialSignup({
          email,
          code,
          name: "重复用户",
          password: "trial-password",
          credentialKey,
          dataRoot: root
        })
      ).rejects.toThrow("SIGNUP_EMAIL_EXISTS");
    } finally {
      await db
        .delete(schema.organizations)
        .where(eq(schema.organizations.id, result.space.organizationId));
      await db.delete(schema.users).where(eq(schema.users.id, result.user.id));
    }
  });
});
