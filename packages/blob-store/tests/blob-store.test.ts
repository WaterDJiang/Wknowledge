import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BLOB_STORAGE_FULL, LocalBlobStore, normalizeBlobStoreError } from "../src/index";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

class CapacityLimitedLocalBlobStore extends LocalBlobStore {
  constructor(
    root: string,
    private readonly capacityBytes: bigint
  ) {
    super(root);
  }

  protected override async availableBytes(): Promise<bigint> {
    return this.capacityBytes;
  }
}

class FailingCapacityLocalBlobStore extends LocalBlobStore {
  protected override async availableBytes(): Promise<bigint> {
    throw new Error("statfs unavailable");
  }
}

class FullReadDeniedLocalBlobStore extends LocalBlobStore {
  override async read(): Promise<Buffer> {
    throw new Error("FULL_BLOB_READ_FORBIDDEN");
  }
}

describe("LocalBlobStore", () => {
  it("normalizes only storage capacity errors", () => {
    expect(
      normalizeBlobStoreError(Object.assign(new Error("disk full"), { code: "ENOSPC" }))
    ).toMatchObject({
      message: BLOB_STORAGE_FULL
    });
    expect(
      normalizeBlobStoreError(Object.assign(new Error("quota"), { code: "EDQUOT" }))
    ).toMatchObject({
      message: BLOB_STORAGE_FULL
    });
    expect(
      normalizeBlobStoreError(Object.assign(new Error("read only"), { code: "EROFS" }))
    ).toMatchObject({
      message: "read only"
    });
  });

  it("writes an immutable blob", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-blob-"));
    roots.push(root);
    const store = new LocalBlobStore(root);
    const uri = await store.putImmutable("space/version/source.txt", Buffer.from("hello"));
    expect((await store.read(uri)).toString()).toBe("hello");
    await expect(
      store.putImmutable("space/version/source.txt", Buffer.from("changed"))
    ).rejects.toThrow("BLOB_IMMUTABLE_CONFLICT");
  });

  it("reads only the requested immutable byte range without using full-blob read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-blob-"));
    roots.push(root);
    const store = new FullReadDeniedLocalBlobStore(root);
    const uri = await store.putImmutable("space/version/source.txt", Buffer.from("0123456789"));
    await expect(store.readRange(uri, 2, 5)).resolves.toEqual(Buffer.from("2345"));
    await expect(store.readRange(uri, 10, 10)).rejects.toThrow("BLOB_RANGE_OUT_OF_BOUNDS");
  });

  it("rejects writes before touching disk when the local volume lacks capacity", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-blob-"));
    roots.push(root);
    const store = new CapacityLimitedLocalBlobStore(root, 3n);
    await expect(
      store.putImmutable("space/version/source.txt", Buffer.from("four"))
    ).rejects.toThrow(BLOB_STORAGE_FULL);
    await expect(store.putTemporary("upload/part-1", Buffer.from("four"))).rejects.toThrow(
      BLOB_STORAGE_FULL
    );
    await expect(store.listImmutableUris()).resolves.toEqual([]);
    await expect(store.exists("local://.temporary/upload/part-1")).resolves.toBe(false);
  });

  it("does not disclose capacity diagnostics when checking the local volume fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-blob-"));
    roots.push(root);
    const store = new FailingCapacityLocalBlobStore(root);
    await expect(
      store.putImmutable("space/version/source.txt", Buffer.from("data"))
    ).rejects.toThrow(BLOB_STORAGE_FULL);
    await expect(store.listImmutableUris()).resolves.toEqual([]);
  });

  it("rejects traversal", async () => {
    const store = new LocalBlobStore(tmpdir());
    await expect(store.putImmutable("../escape", Buffer.from("x"))).rejects.toThrow(
      "BLOB_PATH_OUTSIDE_ROOT"
    );
  });

  it("composes temporary parts into an immutable blob and removes only temporary data", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-blob-"));
    roots.push(root);
    const store = new LocalBlobStore(root);
    const first = await store.putTemporary("upload/part-1", Buffer.from("hello "));
    const second = await store.putTemporary("upload/part-2", Buffer.from("world"));
    const immutable = await store.composeTemporary([first, second], "space/v1/source.txt");
    expect((await store.read(immutable)).toString()).toBe("hello world");
    await store.removeTemporary(first);
    expect(await store.exists(first)).toBe(false);
    expect((await store.read(immutable)).toString()).toBe("hello world");
  });

  it("lists only immutable regular files without following temporary entries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-blob-"));
    roots.push(root);
    const store = new LocalBlobStore(root);
    await store.putImmutable("space/v1/source.md", Buffer.from("source"));
    await store.putImmutable("space/v2/source.md", Buffer.from("source"));
    await store.putTemporary("upload/part-1", Buffer.from("temporary"));
    await expect(store.listImmutableUris()).resolves.toEqual([
      "local://space/v1/source.md",
      "local://space/v2/source.md"
    ]);
  });
});
