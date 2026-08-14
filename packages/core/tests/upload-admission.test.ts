import { describe, expect, it } from "vitest";
import type { BlobStore } from "@wknowledge/blob-store";
import {
  createChunkedUploadSession,
  uploadResource,
  validateUploadInput,
  type JobQueue
} from "../src/index";

const validText = {
  name: "学习笔记.txt",
  mimeType: "text/plain",
  bytes: new TextEncoder().encode("可回查的学习资料。")
};

function uint16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function officeZip(options: {
  name: string;
  additionalNames?: string[];
  compressedSize?: number;
  uncompressedSize?: number;
  flags?: number;
}): Uint8Array {
  const names = [options.name, ...(options.additionalNames ?? [])];
  const compressedSize = options.compressedSize ?? 0;
  const uncompressedSize = options.uncompressedSize ?? 0;
  const flags = options.flags ?? 0;
  const local: number[] = [];
  const central: number[] = [];
  for (const name of names) {
    const nameBytes = new TextEncoder().encode(name);
    const localOffset = local.length;
    local.push(
      ...uint32(0x04034b50),
      ...uint16(20),
      ...uint16(flags),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(compressedSize),
      ...uint32(uncompressedSize),
      ...uint16(nameBytes.byteLength),
      ...uint16(0),
      ...nameBytes
    );
    central.push(
      ...uint32(0x02014b50),
      ...uint16(20),
      ...uint16(20),
      ...uint16(flags),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(compressedSize),
      ...uint32(uncompressedSize),
      ...uint16(nameBytes.byteLength),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(localOffset),
      ...nameBytes
    );
  }
  return Uint8Array.from([
    ...local,
    ...central,
    ...uint32(0x06054b50),
    ...uint16(0),
    ...uint16(0),
    ...uint16(names.length),
    ...uint16(names.length),
    ...uint32(central.length),
    ...uint32(local.length),
    ...uint16(0)
  ]);
}

describe("upload file admission", () => {
  it("accepts supported text, PDF and Office signatures before any persistence", () => {
    expect(() => validateUploadInput(validText)).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "资料.pdf",
        mimeType: "application/pdf",
        bytes: new TextEncoder().encode("%PDF-1.7\n")
      })
    ).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "课程.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: officeZip({ name: "word/", additionalNames: ["word/document.xml"] })
      })
    ).not.toThrow();
  });

  it("admits only matching PNG, JPEG and WebP image signatures", () => {
    expect(() =>
      validateUploadInput({
        name: "学习海报.png",
        mimeType: "image/png",
        bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      })
    ).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "学习海报.jpg",
        mimeType: "image/jpeg",
        bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
      })
    ).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "学习海报.webp",
        mimeType: "image/webp",
        bytes: Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
      })
    ).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "伪造图片.png",
        mimeType: "image/png",
        bytes: Uint8Array.from([0xff, 0xd8, 0xff])
      })
    ).toThrow("UPLOAD_MIME_MISMATCH");
  });

  it("admits supported audio only with an explicit ASR readiness grant and matching signatures", () => {
    const wav = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    const mp3 = Uint8Array.from([0x49, 0x44, 0x33, 4, 0, 0]);
    const m4a = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(() =>
      validateUploadInput({ name: "课堂录音.wav", mimeType: "audio/wav", bytes: wav })
    ).toThrow("UPLOAD_MIME_UNSUPPORTED");
    expect(() =>
      validateUploadInput({
        name: "课堂录音.wav",
        mimeType: "audio/wav",
        bytes: wav,
        allowAudioAsr: true
      })
    ).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "伪装.wav",
        mimeType: "audio/wav",
        bytes: new Uint8Array(12),
        allowAudioAsr: true
      })
    ).toThrow("UPLOAD_MIME_MISMATCH");
    expect(() =>
      validateUploadInput({ name: "课堂录音.mp3", mimeType: "audio/mpeg", bytes: mp3 })
    ).toThrow("UPLOAD_MIME_UNSUPPORTED");
    expect(() =>
      validateUploadInput({
        name: "课堂录音.mp3",
        mimeType: "audio/mpeg",
        bytes: mp3,
        allowAudioAsr: true
      })
    ).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "课堂录音.m4a",
        mimeType: "audio/x-m4a",
        bytes: m4a,
        allowAudioAsr: true
      })
    ).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "伪装.m4a",
        mimeType: "audio/mp4",
        bytes: new Uint8Array(12),
        allowAudioAsr: true
      })
    ).toThrow("UPLOAD_MIME_MISMATCH");
  });

  it("admits MP4 only when MIME, extension and ISO base media container signature agree", () => {
    const mp4 = Uint8Array.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    expect(() =>
      validateUploadInput({ name: "课程视频.mp4", mimeType: "video/mp4", bytes: mp4 })
    ).not.toThrow();
    expect(() =>
      validateUploadInput({
        name: "伪造视频.mp4",
        mimeType: "video/mp4",
        bytes: new Uint8Array(12)
      })
    ).toThrow("UPLOAD_MIME_MISMATCH");
    expect(() =>
      validateUploadInput({ name: "课程视频.mp4", mimeType: "audio/wav", bytes: mp4 })
    ).toThrow("UPLOAD_MIME_MISMATCH");
  });

  it("does not let a chunked WAV session bypass ASR readiness", async () => {
    await expect(
      createChunkedUploadSession({
        spaceId: "11111111-1111-4111-8111-111111111111",
        userId: "22222222-2222-4222-8222-222222222222",
        name: "课堂录音.wav",
        mimeType: "audio/wav",
        byteSize: 8 * 1024 * 1024 + 1,
        sha256: "a".repeat(64),
        compileProfile: "knowledge"
      })
    ).rejects.toThrow("ASR_PROVIDER_REQUIRED");
  });

  it("rejects unsafe names before BlobStore, database or queue work", () => {
    expect(() => validateUploadInput({ ...validText, name: "../学习笔记.txt" })).toThrow(
      "UPLOAD_NAME_INVALID"
    );
    expect(() => validateUploadInput({ ...validText, name: "学习/笔记.txt" })).toThrow(
      "UPLOAD_NAME_INVALID"
    );
  });

  it("does not open BlobStore or the queue when upload admission fails", async () => {
    let blobWrites = 0;
    let queuePublishes = 0;
    const blobStore: BlobStore = {
      putImmutable: async () => {
        blobWrites += 1;
        return "local://should-not-exist";
      },
      putTemporary: async () => "local://.temporary/should-not-exist",
      composeTemporary: async () => "local://should-not-exist",
      removeTemporary: async () => undefined,
      read: async () => Buffer.alloc(0),
      readRange: async () => Buffer.alloc(0),
      exists: async () => false
    };
    const queue: JobQueue = {
      publish: async () => {
        queuePublishes += 1;
        return "00000000-0000-4000-8000-000000000000";
      },
      cancel: async () => false,
      resume: async () => false
    };

    await expect(
      uploadResource(
        {
          spaceId: "11111111-1111-4111-8111-111111111111",
          userId: "22222222-2222-4222-8222-222222222222",
          ...validText,
          name: "../学习笔记.txt",
          compileProfile: "knowledge"
        },
        blobStore,
        queue
      )
    ).rejects.toThrow("UPLOAD_NAME_INVALID");
    expect(blobWrites).toBe(0);
    expect(queuePublishes).toBe(0);
  });

  it("rejects extension, MIME and signature mismatches", () => {
    expect(() =>
      validateUploadInput({ ...validText, name: "学习笔记.pdf", mimeType: "text/plain" })
    ).toThrow("UPLOAD_MIME_MISMATCH");
    expect(() =>
      validateUploadInput({
        name: "伪装.pdf",
        mimeType: "application/pdf",
        bytes: new TextEncoder().encode("不是 PDF")
      })
    ).toThrow("UPLOAD_MIME_MISMATCH");
    expect(() =>
      validateUploadInput({
        name: "伪装.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: new TextEncoder().encode("不是 ZIP")
      })
    ).toThrow("UPLOAD_MIME_MISMATCH");
    expect(() => validateUploadInput({ ...validText, bytes: Uint8Array.from([0xff]) })).toThrow(
      "UPLOAD_MIME_MISMATCH"
    );
  });

  it("rejects unsafe Office archive entries before persistence", () => {
    const office = {
      name: "课程.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    };
    expect(() =>
      validateUploadInput({ ...office, bytes: officeZip({ name: "../word/document.xml" }) })
    ).toThrow("UPLOAD_ARCHIVE_UNSAFE");
    expect(() =>
      validateUploadInput({ ...office, bytes: officeZip({ name: "word/vbaProject.bin" }) })
    ).toThrow("UPLOAD_ARCHIVE_UNSAFE");
    expect(() =>
      validateUploadInput({
        ...office,
        bytes: officeZip({ name: "word/document.xml", flags: 1 })
      })
    ).toThrow("UPLOAD_ARCHIVE_UNSAFE");
    expect(() =>
      validateUploadInput({
        ...office,
        bytes: officeZip({ name: "word/document.xml", compressedSize: 1, uncompressedSize: 101 })
      })
    ).toThrow("UPLOAD_ARCHIVE_UNSAFE");
    expect(() =>
      validateUploadInput({ ...office, bytes: officeZip({ name: "word/other.xml" }) })
    ).toThrow("UPLOAD_ARCHIVE_UNSAFE");
  });
});
