# 正式测评确认与作答 M6-07 Spec v1

## 1. 关联计划

- 工作包：`M6-07`，依赖 `M6-04` 固定 Course、`M6-06` 有来源候选题、`M6-08` 不可变 Attempt 与 `M6-09` 确定性 Grade。
- 状态：已验证。首切片已将已有候选练习确认成个人正式测评并完成固定题卷作答；本轮增加由学习者明确确认 `practice-generate` Skill 候选后直接创建题卷的入口，不启用独立的 `assessment-generate`、主观模型评分、掌握度推断或跨学习者统一考试。

## 2. 目标

- 让学习者明确选择一组候选题后，创建可追溯、不可改写的正式测评题卷。
- 正式测评与日常候选练习分开：题卷创建后固定题目/答案键、量表、知识点、资源版本和 `SourceLocator`。
- 每题作答保存到新的 AssessmentAttempt；客观题复用确定性 Grade，非客观题保留 `pending_review`，不能由 UI 或模型伪造分数。

## 3. 范围与数据流

```text
已完成 Unit
→ 有来源 PracticeSet candidate
→ 学习者明确“确认本次测评”
→ Assessment draft（固定题卷快照）
→ 开始测评
→ 每题单次作答 AssessmentAttempt
→ 全部提交后 Assessment submitted
→ 客观 Grade / 主观人工复核
```

`practice-generate` 的受限候选也可由学习者明确选择“确认并创建正式测评”。服务端先使用既有候选物化和全部课程/来源重核创建 candidate PracticeSet，再调用同一题卷快照逻辑；任一后续失败必须可通过原候选的既有确认/创建测评入口安全恢复，不能伪造题卷或作答。

- Assessment 仅属于当前学习者、当前 active Course 和一个 `candidate` PracticeSet；不能由其他用户或其他 Course 激活。
- 创建时检查学习者仍有每份 ResourceVersion 的空间权限、题目与知识点/来源完整性、问题集非空，随后把题面、题目版本、答案键、量表、SourceLocator 与版本写入 snapshot。
- `draft` 允许学习者查看题卷和来源；`active` 允许为每个 snapshot question 创建一次 Attempt；`submitted` 为终态，不接受任何新作答。
- `AssessmentAttempt` 只从 Assessment snapshot 创建，不读取此后变化的 `practice_question`。其资源/来源、题面、量表、答案键和版本均随 Attempt 保存。
- 简单客观题使用现有 `exact_response.v1`；自由作答保持 `pending_review`。本阶段不将候选题自动发布为组织题库，也不提供成绩解释模型。

## 4. API 与页面

```text
GET  /api/learning/assessments
POST /api/learning/assessments                 # 从 candidate PracticeSet 创建 draft
POST /api/learning/practice-candidates/{id}/materialize-assessment # 确认 Skill 候选并创建/读取 draft
POST /api/learning/assessments/{id}/start      # draft → active
POST /api/learning/assessments/{id}/attempts   # 单题单次作答
POST /api/learning/assessments/{id}/submit     # 所有题已有 Attempt 后 active → submitted
```

- 学习页候选练习卡显示“确认测评”而非“发布题库”；未物化的 Skill 候选同时可显示“确认并创建正式测评”。两者均在用户点击后跳转/定位至独立正式测评区域。
- 正式测评区域持续显示固定版本、题卷状态、每题来源入口、作答状态和可见 Grade；日常练习记录不混入正式测评。
- 所有写操作走同源/CSRF 门禁、Zod 输入校验和当前用户授权重核。

## 5. 验收标准

- 未完成 Unit、非本人候选、已撤权来源、空/篡改题集和跨 Course 请求均不能创建 Assessment。
- 创建后修改/归档候选、资料改名或知识再编译，不改变 Assessment snapshot 与已经提交的 Attempt/Grade。
- 每道 Assessment question 都关联知识点、不可变资源版本和 `wk://source`；来源可继续走现有授权预览。
- Skill 候选的一键确认仍须经已完成 Unit、当前 Course Binding、KnowledgePoint、资源版本和 SourceLocator 的重核；重复请求只读取同一题卷，不重复创建题卷或作答。
- 一道题只能在 active Assessment 中提交一次；缺题不能提交整份测评；submitted 后不能新增 Attempt。
- 客观题重复可重放且结果确定；自由题不自动给分。其他用户无法读取、开始、作答或提交该 Assessment。
- 本切片已通过数据库迁移、领域/API 回归以及 `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm test:e2e`。Skill 候选直达题卷已验证一次性物化和题卷幂等；独立页面已验证登录保护和无控制台错误，带真实课程数据的已登录点击流待作为后续人工验收补齐。

## 6. 明确后置

- `assessment-generate`、组织级审核发布和题库共享。
- 主观模型评分、人工复核工作台、掌握度计算和 AI 报告解释。
- 限时计时、监考、防作弊和跨用户排名。
