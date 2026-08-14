export const SESSION_SKILL_EXECUTION = {
  "wiki-query": "conversation",
  "wiki-lint": "worker",
  "plan-compose": "worker",
  "practice-generate": "worker",
  "wiki-compile": "unavailable",
  "wiki-correct": "unavailable"
} as const;

export type SessionSkillExecution =
  (typeof SESSION_SKILL_EXECUTION)[keyof typeof SESSION_SKILL_EXECUTION];

export function sessionSkillExecution(
  skill: Pick<ManagedSkill, "id" | "origin"> | string
): SessionSkillExecution {
  if (typeof skill !== "string" && skill.origin === "installed") return "worker";
  const skillId = typeof skill === "string" ? skill : skill.id;
  return SESSION_SKILL_EXECUTION[skillId as keyof typeof SESSION_SKILL_EXECUTION] ?? "unavailable";
}
import type { ManagedSkill } from "@wknowledge/contracts";
