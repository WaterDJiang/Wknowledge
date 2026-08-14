import { hash } from "bcryptjs";
import { eq } from "drizzle-orm";
import { closeDatabase, getDatabase, schema } from "./index";

const email = process.env.WKNOWLEDGE_BOOTSTRAP_EMAIL ?? "admin@example.com";
const password = process.env.WKNOWLEDGE_BOOTSTRAP_PASSWORD;
const name = process.env.WKNOWLEDGE_BOOTSTRAP_NAME ?? "知识库管理员";

if (!password || password === "change-me-before-production") {
  throw new Error("Set WKNOWLEDGE_BOOTSTRAP_PASSWORD to a non-default value before seeding.");
}

const db = getDatabase();
try {
  const [existing] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (existing) {
    console.info(`Bootstrap user already exists: ${email}`);
  } else {
    const [organization] = await db
      .insert(schema.organizations)
      .values({ name: "Wknowledge" })
      .returning();
    const [user] = await db
      .insert(schema.users)
      .values({ email, name, passwordHash: await hash(password, 12) })
      .returning();
    if (!organization || !user) throw new Error("Failed to create bootstrap organization or user.");
    await db
      .insert(schema.organizationMemberships)
      .values({ organizationId: organization.id, userId: user.id, role: "owner" });
    console.info(`Created bootstrap owner: ${email}`);
  }
} finally {
  await closeDatabase();
}
