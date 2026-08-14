import type { FormEvent } from "react";
import type { LearnerProfile } from "@wknowledge/contracts";

export function LearnerProfileForm({
  profile,
  onSave
}: {
  profile: LearnerProfile;
  onSave: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <form className="learning-profile" onSubmit={onSave}>
      <div>
        <p>学习画像 / 仅你的自述</p>
        <h3>让后续计划贴合你的节奏</h3>
        <small>系统观察和 AI 推断会单独保存；当前不会调用模型或 Skill。</small>
      </div>
      <label>
        当前基础
        <select name="currentLevel" defaultValue={profile.declared.currentLevel}>
          <option value="unspecified">暂不说明</option>
          <option value="beginner">入门</option>
          <option value="intermediate">有一定基础</option>
          <option value="advanced">熟练</option>
        </select>
      </label>
      <label>
        每周分钟
        <input
          name="weeklyMinutes"
          type="number"
          min="30"
          max="1680"
          defaultValue={profile.declared.weeklyMinutes}
        />
      </label>
      <label>
        节奏
        <select name="preferredPace" defaultValue={profile.declared.preferredPace}>
          <option value="steady">稳定推进</option>
          <option value="intensive">集中冲刺</option>
          <option value="flexible">灵活安排</option>
        </select>
      </label>
      <label className="learning-profile-note">
        补充说明
        <input
          name="note"
          maxLength={500}
          defaultValue={profile.declared.note}
          placeholder="例如：工作日晚间学习"
        />
      </label>
      <button>保存偏好</button>
    </form>
  );
}
