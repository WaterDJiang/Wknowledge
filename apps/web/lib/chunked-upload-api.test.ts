import { describe, expect, it } from "vitest";
import { chunkedUploadError } from "./chunked-upload-api";

describe("chunked upload errors", () => {
  it("returns a safe 507 response for a confirmed storage capacity failure", async () => {
    const response = chunkedUploadError(new Error("BLOB_STORAGE_FULL"));
    const body = (await response.json()) as { code: string; message: string; suggestion?: string };
    expect(response.status).toBe(507);
    expect(body).toEqual({
      code: "BLOB_STORAGE_FULL",
      message: "存储空间不足，暂时无法保存文件",
      suggestion: "请联系管理员释放空间后重新提交",
      requestId: expect.any(String)
    });
  });

  it("returns a safe 507 response when the organization quota is exhausted", async () => {
    const response = chunkedUploadError(new Error("STORAGE_QUOTA_EXCEEDED"));
    const body = (await response.json()) as { code: string; message: string; suggestion?: string };
    expect(response.status).toBe(507);
    expect(body).toEqual({
      code: "STORAGE_QUOTA_EXCEEDED",
      message: "组织存储额度不足，暂时无法创建上传",
      suggestion: "请联系管理员清理资料或调整额度后重试",
      requestId: expect.any(String)
    });
  });
});
