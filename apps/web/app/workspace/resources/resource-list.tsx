"use client";

import {
  PROFILE_LABELS,
  STAGE_LABELS,
  STATUS_LABELS,
  type Resource,
  type ResourceVersionSummary
} from "./resource-types";
import type { WikiCompileProfile } from "@wknowledge/contracts";
import { useState } from "react";

interface ResourceListProps {
  resources: Resource[];
  retryingJobId: string;
  cancellingJobId: string;
  resumingJobId: string;
  busyResourceId: string;
  recompilingResourceId: string;
  versionsByResource: Record<string, ResourceVersionSummary[] | undefined>;
  onRetry(jobId: string): void;
  onCancel(jobId: string): void;
  onResume(jobId: string): void;
  onReplace(resource: Resource, file: File): void;
  onRecompile(resource: Resource, compileProfile: WikiCompileProfile): void;
  onToggleVersions(resourceId: string): void;
}

export function ResourceList({
  resources,
  retryingJobId,
  cancellingJobId,
  resumingJobId,
  busyResourceId,
  recompilingResourceId,
  versionsByResource,
  onRetry,
  onCancel,
  onResume,
  onReplace,
  onRecompile,
  onToggleVersions
}: ResourceListProps) {
  const [recompileProfiles, setRecompileProfiles] = useState<Record<string, WikiCompileProfile>>(
    {}
  );

  function availableRecompileProfiles(resource: Resource) {
    return (["knowledge", "case", "reference"] as const).filter(
      (profile) => profile !== resource.compileProfile
    );
  }

  function selectedRecompileProfile(resource: Resource): WikiCompileProfile {
    const selected = recompileProfiles[resource.id];
    return selected && selected !== resource.compileProfile
      ? selected
      : availableRecompileProfiles(resource)[0]!;
  }

  return (
    <div className="resource-list">
      {resources.length === 0 ? (
        <p className="empty">还没有资料。上传后由 Worker 解析并编译 Wiki。</p>
      ) : (
        resources.map((resource) => (
          <article key={resource.id}>
            <span className={`file-state ${resource.status}`} />
            <div>
              <b>{resource.name}</b>
              <small>
                V{resource.currentVersion} · {PROFILE_LABELS[resource.compileProfile]} ·{" "}
                {STATUS_LABELS[resource.status] ?? resource.status}
              </small>
              {resource.latestJob ? (
                <div className="resource-progress">
                  <div>
                    <span>{STAGE_LABELS[resource.latestJob.stage] ?? "处理中"}</span>
                    <span>{resource.latestJob.progress}%</span>
                  </div>
                  <progress
                    aria-label={`${resource.name}处理进度`}
                    max="100"
                    value={resource.latestJob.progress}
                  />
                  {resource.latestJob.status === "failed" ? (
                    <div className="resource-failure" role="alert">
                      <p>
                        {resource.latestJob.errorCode ?? "RESOURCE_PROCESS_FAILED"}
                        {resource.latestJob.errorMessage
                          ? ` · ${resource.latestJob.errorMessage}`
                          : ""}
                      </p>
                      <button
                        type="button"
                        disabled={retryingJobId === resource.latestJob.id}
                        onClick={() => onRetry(resource.latestJob!.id)}
                      >
                        {retryingJobId === resource.latestJob.id ? "重新排队中…" : "重新处理"}
                      </button>
                    </div>
                  ) : resource.latestJob.status === "cancelled" ? (
                    <div className="resource-failure" role="status">
                      <p>任务已取消。原始资料与已生成的历史内容均未删除。</p>
                      <button
                        type="button"
                        disabled={resumingJobId === resource.latestJob.id}
                        onClick={() => onResume(resource.latestJob!.id)}
                      >
                        {resumingJobId === resource.latestJob.id ? "恢复排队中…" : "恢复处理"}
                      </button>
                    </div>
                  ) : resource.latestJob.status === "queued" ||
                    resource.latestJob.status === "processing" ? (
                    <div className="resource-actions">
                      <button
                        type="button"
                        disabled={cancellingJobId === resource.latestJob.id}
                        onClick={() => onCancel(resource.latestJob!.id)}
                      >
                        {cancellingJobId === resource.latestJob.id ? "取消中…" : "取消处理"}
                      </button>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <div className="resource-version-actions">
                <label>
                  <span>替换文件</span>
                  <input
                    type="file"
                    disabled={busyResourceId === resource.id}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      if (file) onReplace(resource, file);
                      event.currentTarget.value = "";
                    }}
                  />
                </label>
                <button type="button" onClick={() => onToggleVersions(resource.id)}>
                  {versionsByResource[resource.id]
                    ? `收起 ${resource.versionCount} 个版本`
                    : `查看 ${resource.versionCount} 个版本`}
                </button>
              </div>
              <div className="resource-version-actions resource-recompile-actions">
                <label>
                  <span>重新整理为</span>
                  <select
                    aria-label={`选择《${resource.name}》的整理模式`}
                    value={selectedRecompileProfile(resource)}
                    disabled={
                      busyResourceId === resource.id ||
                      recompilingResourceId === resource.id ||
                      resource.latestJob?.status === "queued" ||
                      resource.latestJob?.status === "processing"
                    }
                    onChange={(event) =>
                      setRecompileProfiles((current) => ({
                        ...current,
                        [resource.id]: event.currentTarget.value as WikiCompileProfile
                      }))
                    }
                  >
                    {availableRecompileProfiles(resource).map((profile) => (
                      <option key={profile} value={profile}>
                        {PROFILE_LABELS[profile]}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  disabled={
                    busyResourceId === resource.id ||
                    recompilingResourceId === resource.id ||
                    resource.latestJob?.status === "queued" ||
                    resource.latestJob?.status === "processing"
                  }
                  onClick={() => onRecompile(resource, selectedRecompileProfile(resource))}
                >
                  {recompilingResourceId === resource.id ? "正在创建…" : "重新整理"}
                </button>
                <small>
                  {recompilingResourceId === resource.id
                    ? "正在创建新的整理版本…"
                    : "保留原文件与历史版本"}
                </small>
              </div>
              {versionsByResource[resource.id] ? (
                <ol className="resource-version-list" aria-label={`${resource.name}历史版本`}>
                  {versionsByResource[resource.id]!.map((version) => (
                    <li key={version.id}>
                      <b>V{version.version}</b>
                      <span>{version.originalName}</span>
                      <small>
                        {PROFILE_LABELS[version.compileProfile]} ·{" "}
                        {(version.byteSize / 1024).toFixed(1)} KiB
                        {version.latestJob
                          ? ` · ${STAGE_LABELS[version.latestJob.stage] ?? version.latestJob.stage}`
                          : ""}
                      </small>
                    </li>
                  ))}
                </ol>
              ) : null}
            </div>
            <time>{new Date(resource.updatedAt).toLocaleDateString("zh-CN")}</time>
          </article>
        ))
      )}
    </div>
  );
}
