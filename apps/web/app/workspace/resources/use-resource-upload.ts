"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useWorkspace } from "../workspace-shell";

const DIRECT_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

interface UploadSession {
  uploadId: string;
  partSize: number;
  totalParts: number;
  receivedParts: number[];
}

interface ActiveUpload extends UploadSession {
  name: string;
  byteSize: number;
  sha256: string;
}

interface FinalizingUpload {
  uploadId: string;
  name: string;
  jobId: string;
}

interface UploadResponse {
  job?: { id?: string };
  message?: string;
  duplicate?: boolean;
}

async function responseJson(response: Response): Promise<UploadResponse | null> {
  return (await response.json().catch(() => null)) as UploadResponse | null;
}

async function fileSha256(file: File): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("UPLOAD_HASH_UNSUPPORTED");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function useResourceUpload(
  activeId: string,
  refreshResources: () => Promise<void>
): {
  uploading: boolean;
  uploadProgress: number | null;
  finalizingUpload: FinalizingUpload | null;
  upload: (event: FormEvent<HTMLFormElement>) => Promise<void>;
} {
  const { setNotice } = useWorkspace();
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [finalizingUpload, setFinalizingUpload] = useState<FinalizingUpload | null>(null);
  const activeUpload = useRef<ActiveUpload | null>(null);

  useEffect(() => {
    if (!finalizingUpload) return;
    let closed = false;
    const controller = new AbortController();
    const refreshFinalization = async () => {
      try {
        const response = await fetch(`/api/uploads/${finalizingUpload.uploadId}`, {
          signal: controller.signal
        });
        if (!response.ok || closed) return;
        const session = (await response.json()) as {
          upload: { status: string; errorMessage?: string | null };
        };
        if (session.upload.status === "failed" || session.upload.status === "expired") {
          setFinalizingUpload(null);
          if (!closed)
            setNotice(
              session.upload.errorMessage ??
                (session.upload.status === "expired"
                  ? "上传会话已过期，请重新选择文件后提交"
                  : "文件校验入库失败，请重新选择文件后提交")
            );
          return;
        }
        if (session.upload.status !== "completed") return;
        setFinalizingUpload(null);
        await refreshResources();
        if (!closed) setNotice("文件已进入处理队列，处理进度将在资料列表中显示");
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
      }
    };
    void refreshFinalization();
    const timer = window.setInterval(() => void refreshFinalization(), 2000);
    return () => {
      closed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, [finalizingUpload, refreshResources, setNotice]);

  async function uploadDirect(file: File, form: HTMLFormElement) {
    const response = await fetch(`/api/spaces/${activeId}/resources`, {
      method: "POST",
      body: new FormData(form)
    });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data?.message ?? "上传失败");
    setNotice(
      data?.duplicate
        ? "相同文件已存在"
        : `文件完整性校验已进入队列 · ${data?.job?.id?.slice(0, 8) ?? ""}`
    );
    form.reset();
  }

  async function createOrResumeSession(file: File, compileProfile: string, sha256: string) {
    const current = activeUpload.current;
    if (
      current &&
      current.name === file.name &&
      current.byteSize === file.size &&
      current.sha256 === sha256
    ) {
      const response = await fetch(`/api/uploads/${current.uploadId}`);
      if (response.ok) return (await response.json()) as UploadSession;
    }
    const response = await fetch(`/api/spaces/${activeId}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        mimeType: file.type || "application/octet-stream",
        byteSize: file.size,
        sha256,
        compileProfile
      })
    });
    const data = await responseJson(response);
    if (!response.ok) throw new Error(data?.message ?? "无法创建上传会话");
    const session = data as unknown as UploadSession;
    activeUpload.current = { ...session, name: file.name, byteSize: file.size, sha256 };
    return session;
  }

  async function uploadChunked(file: File, form: HTMLFormElement) {
    setNotice("正在计算文件校验值…");
    const sha256 = await fileSha256(file);
    const compileProfile = new FormData(form).get("compileProfile")?.toString() ?? "knowledge";
    const session = await createOrResumeSession(file, compileProfile, sha256);
    const received = new Set(session.receivedParts);
    for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
      if (received.has(partNumber)) continue;
      const start = (partNumber - 1) * session.partSize;
      const response = await fetch(`/api/uploads/${session.uploadId}/parts/${partNumber}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: file.slice(start, Math.min(start + session.partSize, file.size))
      });
      const data = await responseJson(response);
      if (!response.ok) throw new Error(data?.message ?? `第 ${partNumber} 个分片上传失败`);
      received.add(partNumber);
      setUploadProgress(Math.round((received.size / session.totalParts) * 100));
    }
    setNotice("文件已上传，正在校验并进入处理队列…");
    const completed = await fetch(`/api/uploads/${session.uploadId}/complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sha256 })
    });
    const data = await responseJson(completed);
    if (!completed.ok) throw new Error(data?.message ?? "上传完成校验失败");
    if (data?.duplicate) {
      setNotice("相同文件已存在");
    } else {
      const jobId = data?.job?.id ?? "";
      setFinalizingUpload({ uploadId: session.uploadId, name: file.name, jobId });
      setNotice(`完整性校验已进入队列 · ${jobId.slice(0, 8)}`);
    }
    activeUpload.current = null;
    form.reset();
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeId || uploading) return;
    const form = event.currentTarget;
    const file = new FormData(form).get("file");
    if (!(file instanceof File)) {
      setNotice("请选择文件");
      return;
    }
    setUploading(true);
    setUploadProgress(null);
    try {
      if (file.size > DIRECT_UPLOAD_MAX_BYTES) await uploadChunked(file, form);
      else {
        setNotice("上传并排队处理中…");
        await uploadDirect(file, form);
      }
      if (file.size <= DIRECT_UPLOAD_MAX_BYTES) await refreshResources();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? `${error.message}。请保持当前页面并再次提交以续传缺失分片。`
          : "上传服务暂时不可用，请稍后重试"
      );
    } finally {
      setUploading(false);
      setUploadProgress(null);
    }
  }

  return { uploading, uploadProgress, finalizingUpload, upload };
}
