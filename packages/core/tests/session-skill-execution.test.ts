import { describe, expect, it } from "vitest";
import { sessionSkillExecution } from "../src/session-skill-execution";

describe("session Skill execution availability", () => {
  it("keeps fixed builtin states and marks admitted installed Skills as Worker runnable", () => {
    expect(sessionSkillExecution("wiki-query")).toBe("conversation");
    expect(sessionSkillExecution("wiki-compile")).toBe("unavailable");
    expect(sessionSkillExecution({ id: "safe-inspector", origin: "installed" })).toBe("worker");
    expect(sessionSkillExecution({ id: "safe-inspector", origin: "builtin" })).toBe("unavailable");
  });
});
