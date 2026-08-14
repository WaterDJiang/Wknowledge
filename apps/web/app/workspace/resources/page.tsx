"use client";

import { useCallback, useEffect, useState } from "react";
import { processingJobSchema, type WikiCompileProfile } from "@wknowledge/contracts";
import { ResourceList } from "./resource-list";
import { type Resource, type ResourceVersionSummary } from "./resource-types";
import { useResourceUpload } from "./use-resource-upload";
import { useWorkspace } from "../workspace-shell";

export default function ResourcesPage() {
  const { activeId, setNotice } = useWorkspace();
  const [loaded, setLoaded] = useState<{ spaceId: string; resources: Resource[] }>({
    spaceId: "",
    resources: []
  });
  const [retryingJobId, setRetryingJobId] = useState("");
  const [cancellingJobId, setCancellingJobId] = useState("");
  const [resumingJobId, setResumingJobId] = useState("");
  const [replacingResourceId, setReplacingResourceId] = useState("");
  const [recompilingResourceId, setRecompilingResourceId] = useState("");
  const [versionsByResource, setVersionsByResource] = useState<
    Record<string, ResourceVersionSummary[] | undefined>
  >({});
  const resources = loaded.spaceId === activeId ? loaded.resources : [];

  const refreshResources = useCallback(async () => {
    if (!activeId) return;
    const response = await fetch(`/api/spaces/${activeId}/resources`);
    if (!response.ok) throw new Error("RESOURCE_LIST_FAILED");
    const data = (await response.json()) as { resources: Resource[] };
    setLoaded({ spaceId: activeId, resources: data.resources });
  }, [activeId]);
  const { uploading, uploadProgress, finalizingUpload, upload } = useResourceUpload(
    activeId,
    refreshResources
  );

  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    void fetch(`/api/spaces/${activeId}/resources`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("RESOURCE_LIST_FAILED");
        return (await response.json()) as { resources: Resource[] };
      })
      .then((data) => setLoaded({ spaceId: activeId, resources: data.resources }))
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setNotice("资料列表读取失败");
      });
    return () => controller.abort();
  }, [activeId, setNotice]);

  const liveJobKey = resources
    .flatMap((resource) =>
      resource.latestJob &&
      !["completed", "failed", "cancelled"].includes(resource.latestJob.status)
        ? [resource.latestJob.id]
        : []
    )
    .sort()
    .join(",");

  useEffect(() => {
    if (!activeId || !liveJobKey) return;
    const sources = liveJobKey.split(",").map((jobId) => {
      const source = new EventSource(`/api/jobs/${jobId}/events`);
      source.addEventListener("progress", (event) => {
        const parsed = processingJobSchema.safeParse(JSON.parse((event as MessageEvent).data));
        if (!parsed.success || parsed.data.spaceId !== activeId) return;
        const job = parsed.data;
        setLoaded((current) => {
          if (current.spaceId !== activeId) return current;
          return {
            ...current,
            resources: current.resources.map((resource) =>
              resource.latestJob?.id === job.id
                ? {
                    ...resource,
                    status:
                      job.status === "completed"
                        ? "ready"
                        : job.status === "failed"
                          ? "failed"
                          : job.status,
                    latestJob: job
                  }
                : resource
            )
          };
        });
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          source.close();
          setNotice(
            job.status === "completed"
              ? "资料处理完成，可进入知识库查看"
              : job.status === "cancelled"
                ? "资料处理已取消，可随时恢复"
                : `资料处理失败 · ${job.errorCode ?? "RESOURCE_PROCESS_FAILED"}`
          );
          void refreshResources().catch(() => setNotice("最终资料状态刷新失败"));
        }
      });
      source.onerror = () => setNotice("处理进度连接中断，正在自动重连…");
      return source;
    });
    return () => sources.forEach((source) => source.close());
  }, [activeId, liveJobKey, refreshResources, setNotice]);

  async function updateJob(jobId: string, action: "retry" | "cancel" | "resume") {
    const setters = {
      retry: setRetryingJobId,
      cancel: setCancellingJobId,
      resume: setResumingJobId
    };
    if (retryingJobId || cancellingJobId || resumingJobId) return;
    setters[action](jobId);
    const labels = { retry: "正在重新排队…", cancel: "正在取消处理…", resume: "正在恢复处理…" };
    const success = { retry: "任务已重新排队", cancel: "已请求取消处理", resume: "任务已恢复排队" };
    setNotice(labels[action]);
    try {
      const response = await fetch(`/api/jobs/${jobId}/${action}`, { method: "POST" });
      const data = (await response.json().catch(() => null)) as { message?: string } | null;
      if (!response.ok) {
        setNotice(data?.message ?? `${success[action]}失败`);
        return;
      }
      await refreshResources();
      setNotice(success[action]);
    } catch {
      setNotice("任务服务暂时不可用，请稍后再试");
    } finally {
      setters[action]("");
    }
  }

  async function toggleVersions(resourceId: string) {
    if (versionsByResource[resourceId]) {
      setVersionsByResource((current) => ({ ...current, [resourceId]: undefined }));
      return;
    }
    try {
      const response = await fetch(`/api/resources/${resourceId}/versions`);
      if (!response.ok) throw new Error("RESOURCE_VERSIONS_FAILED");
      const data = (await response.json()) as { versions: ResourceVersionSummary[] };
      setVersionsByResource((current) => ({ ...current, [resourceId]: data.versions }));
    } catch {
      setNotice("历史版本读取失败");
    }
  }

  async function replaceResource(resource: Resource, file: File) {
    if (replacingResourceId) return;
    setReplacingResourceId(resource.id);
    setNotice("正在创建新的资料版本…");
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("compileProfile", resource.compileProfile);
      const response = await fetch(`/api/resources/${resource.id}/versions`, {
        method: "POST",
        body: form
      });
      const data = (await response.json().catch(() => null)) as {
        duplicate?: boolean;
        job?: { id?: string };
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "替换资料失败");
      setNotice(
        data?.duplicate
          ? "该资料版本已存在"
          : `已创建新版本并进入处理队列 · ${data?.job?.id?.slice(0, 8) ?? ""}`
      );
      setVersionsByResource((current) => ({ ...current, [resource.id]: undefined }));
      await refreshResources();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "替换资料失败，请稍后重试");
    } finally {
      setReplacingResourceId("");
    }
  }

  async function recompileResource(resource: Resource, compileProfile: WikiCompileProfile) {
    if (recompilingResourceId || compileProfile === resource.compileProfile) return;
    setRecompilingResourceId(resource.id);
    setNotice(
      `正在创建“${compileProfile === "knowledge" ? "知识提炼" : compileProfile === "case" ? "案例整理" : "资料归档"}”版本…`
    );
    try {
      const response = await fetch(`/api/resources/${resource.id}/recompile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ compileProfile })
      });
      const data = (await response.json().catch(() => null)) as {
        duplicate?: boolean;
        job?: { id?: string };
        message?: string;
      } | null;
      if (!response.ok) throw new Error(data?.message ?? "重新整理资料失败");
      setNotice(
        data?.duplicate
          ? "该整理模式的资料版本已存在"
          : `已创建新整理版本并进入处理队列 · ${data?.job?.id?.slice(0, 8) ?? ""}`
      );
      setVersionsByResource((current) => ({ ...current, [resource.id]: undefined }));
      await refreshResources();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "重新整理资料失败，请稍后重试");
    } finally {
      setRecompilingResourceId("");
    }
  }

  return (
    <section className="panel upload-panel">
      <div className="panel-head">
        <div>
          <span>01</span>
          <h2>资料处理台</h2>
        </div>
        <small>{resources.length} 份资料</small>
      </div>
      <form className="dropzone" onSubmit={(event) => void upload(event)}>
        <input
          name="file"
          type="file"
          accept=".txt,.md,.markdown,.csv,.pdf,.docx,.pptx,.xlsx,.png,.jpg,.jpeg,.webp,.wav,.mp3,.m4a,.mp4"
          required
          disabled={!activeId || uploading}
        />
        <div className="upload-intro">
          <b>选择资料并上传</b>
          <p>
            TXT · MD · PDF · DOCX · PPTX · XLSX · PNG · JPG · WEBP · MP4 · WAV · MP3 ·
            M4A（音频需启用语音转文字）
          </p>
          <small>
            图片将本地识别文字和区域；MP4 可提取媒体结构和时间定位；音频会按时间转写。大于 8 MiB
            的可用类型自动分片上传。
          </small>
        </div>
        <fieldset className="compile-profile-picker">
          <legend>整理成什么</legend>
          <label>
            <input name="compileProfile" type="radio" value="knowledge" defaultChecked />
            <span>
              <b>知识提炼</b>
              <small>拆成可检索主题</small>
            </span>
          </label>
          <label>
            <input name="compileProfile" type="radio" value="case" />
            <span>
              <b>案例整理</b>
              <small>保留案例结构</small>
            </span>
          </label>
          <label>
            <input name="compileProfile" type="radio" value="reference" />
            <span>
              <b>资料归档</b>
              <small>忠实材料索引</small>
            </span>
          </label>
        </fieldset>
        {uploadProgress !== null ? (
          <div className="upload-transfer-progress" role="status">
            <div>
              <span>正在传输文件</span>
              <span>{uploadProgress}%</span>
            </div>
            <progress aria-label="文件上传进度" max="100" value={uploadProgress} />
          </div>
        ) : null}
        {finalizingUpload ? (
          <div className="upload-transfer-progress upload-finalization-progress" role="status">
            <div>
              <span>{finalizingUpload.name}</span>
              <span>校验入库中</span>
            </div>
            <progress aria-label="文件完整性校验和入库进度" />
            <small>
              正在校验完整性并生成不可变版本，随后会显示资料处理进度
              {finalizingUpload.jobId ? ` · ${finalizingUpload.jobId.slice(0, 8)}` : ""}
            </small>
          </div>
        ) : null}
        <button className="button button-primary" disabled={!activeId || uploading}>
          {uploading ? "正在上传…" : "开始处理"}
        </button>
      </form>
      <ResourceList
        resources={resources}
        retryingJobId={retryingJobId}
        cancellingJobId={cancellingJobId}
        resumingJobId={resumingJobId}
        busyResourceId={replacingResourceId}
        recompilingResourceId={recompilingResourceId}
        versionsByResource={versionsByResource}
        onRetry={(jobId) => void updateJob(jobId, "retry")}
        onCancel={(jobId) => void updateJob(jobId, "cancel")}
        onResume={(jobId) => void updateJob(jobId, "resume")}
        onReplace={(resource, file) => void replaceResource(resource, file)}
        onRecompile={(resource, compileProfile) => void recompileResource(resource, compileProfile)}
        onToggleVersions={(resourceId) => void toggleVersions(resourceId)}
      />
    </section>
  );
}
