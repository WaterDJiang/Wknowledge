import type { SkillRun } from "@wknowledge/contracts";

export function skillRunStatusLabel(run: SkillRun): string {
  if (run.status === "queued") return "已安全排队，尚未执行";
  if (run.status === "running") return "受管运行时处理中";
  if (run.status === "completed") return "已完成";
  if (run.status === "stopped") return "已停止";
  return "运行失败";
}

export function completedSkillRunSummary(run: SkillRun): string | null {
  if (run.status !== "completed" || !run.outputSummary) return null;
  if (run.skillId === "wiki-lint") {
    const scannedSpaces = run.outputSummary.scannedSpaces;
    const issueCount = run.outputSummary.issueCount;
    if (typeof scannedSpaces === "number" && typeof issueCount === "number")
      return `已检查 ${scannedSpaces} 个知识空间，发现 ${issueCount} 个结构问题`;
  }
  const runtime = run.outputSummary.runtime;
  const bindingCount = run.outputSummary.bindingCount;
  const outputType = run.outputSummary.outputType;
  if (typeof runtime !== "string" || typeof bindingCount !== "number") return null;
  const output = typeof outputType === "string" ? ` · 输出为 ${outputType}` : "";
  return `已在受管 ${runtime} 运行时完成 ${bindingCount} 个知识范围的处理${output}`;
}
