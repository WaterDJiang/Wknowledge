import { apiError } from "../../../../lib/api";

export function presentAssessmentError(error: unknown) {
  const code = error instanceof Error ? error.message : "ASSESSMENT_UNAVAILABLE";
  if (code === "LEARNING_PLAN_ACTIVE_NOT_FOUND")
    return apiError(409, code, "请先确认包含学习资料的计划");
  if (code === "LEARNING_COURSE_ACTIVE_NOT_FOUND")
    return apiError(409, code, "当前计划尚未完成课程编排，请重新生成计划");
  if (code === "ASSESSMENT_PRACTICE_SET_DENIED")
    return apiError(403, code, "只能将当前课程中的候选练习确认成正式测评");
  if (code === "ASSESSMENT_QUESTION_MISSING")
    return apiError(409, code, "候选练习中没有可冻结的题目");
  if (code === "ASSESSMENT_SOURCE_INTEGRITY_FAILED")
    return apiError(409, code, "候选题缺少完整原文依据，无法创建正式测评");
  if (code === "ASSESSMENT_SOURCE_REVOKED")
    return apiError(409, code, "其中原文资料已不可学习，请联系空间管理员");
  return apiError(503, "ASSESSMENT_UNAVAILABLE", "正式测评暂时无法处理，请稍后重试");
}
