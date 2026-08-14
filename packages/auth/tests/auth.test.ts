import { describe, expect, it } from "vitest";
import { can, hashSessionToken } from "../src/index";

describe("auth rules", () => {
  it("enforces the role hierarchy", () => {
    expect(can("editor", "learner")).toBe(true);
    expect(can("viewer", "editor")).toBe(false);
  });

  it("does not store a raw session token", () => {
    expect(hashSessionToken("secret")).not.toContain("secret");
    expect(hashSessionToken("secret")).toHaveLength(64);
  });
});
