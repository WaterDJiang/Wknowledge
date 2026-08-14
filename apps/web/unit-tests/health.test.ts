import { describe, expect, it } from "vitest";
import { readDatabaseReadiness } from "../lib/health";

describe("database readiness", () => {
  it("reports ready after a successful lightweight probe", async () => {
    await expect(readDatabaseReadiness(async () => undefined)).resolves.toEqual({ ready: true });
  });

  it("normalizes probe failures without retaining error details", async () => {
    const result = await readDatabaseReadiness(async () => {
      throw new Error("postgres://private-password@db.internal/wknowledge");
    });
    expect(result).toEqual({ ready: false, code: "DATABASE_UNAVAILABLE" });
    expect(JSON.stringify(result)).not.toContain("private-password");
  });
});
