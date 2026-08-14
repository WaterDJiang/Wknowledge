import { lstat, mkdir, open, readFile, readdir, rm, statfs } from "node:fs/promises";
import path from "node:path";

export const BLOB_STORAGE_FULL = "BLOB_STORAGE_FULL";

export function normalizeBlobStoreError(error: unknown): Error {
  if (error instanceof Error && error.message === BLOB_STORAGE_FULL) return error;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOSPC" || code === "EDQUOT") return new Error(BLOB_STORAGE_FULL);
  return error instanceof Error ? error : new Error("BLOB_WRITE_FAILED");
}

export interface BlobStore {
  putImmutable(key: string, data: Uint8Array): Promise<string>;
  putTemporary(key: string, data: Uint8Array): Promise<string>;
  composeTemporary(parts: readonly string[], immutableKey: string): Promise<string>;
  removeTemporary(uri: string): Promise<void>;
  read(uri: string): Promise<Buffer>;
  readRange(uri: string, start: number, end: number): Promise<Buffer>;
  exists(uri: string): Promise<boolean>;
  assertWriteCapacity?(byteSize: number): Promise<void>;
}

export interface LocalBlobInventory {
  listImmutableUris(): Promise<string[]>;
}

function safeRelative(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (normalized.startsWith("../") || normalized === ".." || path.posix.isAbsolute(normalized)) {
    throw new Error("BLOB_PATH_OUTSIDE_ROOT");
  }
  return normalized;
}

export class LocalBlobStore implements BlobStore, LocalBlobInventory {
  constructor(private readonly root: string) {}

  private resolve(relative: string): string {
    return path.join(this.root, safeRelative(relative));
  }

  protected async availableBytes(): Promise<bigint> {
    await mkdir(this.root, { recursive: true });
    const filesystem = await statfs(this.root, { bigint: true });
    return filesystem.bavail * filesystem.bsize;
  }

  async assertWriteCapacity(byteSize: number): Promise<void> {
    if (!Number.isSafeInteger(byteSize) || byteSize <= 0)
      throw new Error("BLOB_WRITE_SIZE_INVALID");
    try {
      if ((await this.availableBytes()) < BigInt(byteSize)) throw new Error(BLOB_STORAGE_FULL);
    } catch {
      throw new Error(BLOB_STORAGE_FULL);
    }
  }

  async putImmutable(key: string, data: Uint8Array): Promise<string> {
    const relative = safeRelative(key);
    const target = this.resolve(relative);
    await this.assertWriteCapacity(data.byteLength);
    try {
      await mkdir(path.dirname(target), { recursive: true });
    } catch (error) {
      throw normalizeBlobStoreError(error);
    }
    const handle = await open(target, "wx").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("BLOB_IMMUTABLE_CONFLICT");
      throw normalizeBlobStoreError(error);
    });
    try {
      await handle.writeFile(data).catch((error) => {
        throw normalizeBlobStoreError(error);
      });
    } finally {
      await handle.close();
    }
    return `local://${relative}`;
  }

  async putTemporary(key: string, data: Uint8Array): Promise<string> {
    const relative = safeRelative(`.temporary/${key}`);
    const target = this.resolve(relative);
    await this.assertWriteCapacity(data.byteLength);
    try {
      await mkdir(path.dirname(target), { recursive: true });
    } catch (error) {
      throw normalizeBlobStoreError(error);
    }
    const handle = await open(target, "wx").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EEXIST") throw new Error("BLOB_TEMPORARY_CONFLICT");
      throw normalizeBlobStoreError(error);
    });
    try {
      await handle.writeFile(data).catch((error) => {
        throw normalizeBlobStoreError(error);
      });
    } finally {
      await handle.close();
    }
    return `local://${relative}`;
  }

  async composeTemporary(parts: readonly string[], immutableKey: string): Promise<string> {
    const chunks = await Promise.all(
      parts.map(async (uri) => {
        if (!uri.startsWith("local://.temporary/")) throw new Error("BLOB_TEMPORARY_URI_INVALID");
        return this.read(uri);
      })
    );
    return this.putImmutable(immutableKey, Buffer.concat(chunks));
  }

  async removeTemporary(uri: string): Promise<void> {
    if (!uri.startsWith("local://.temporary/")) throw new Error("BLOB_TEMPORARY_URI_INVALID");
    await rm(this.resolve(uri.slice("local://".length)), { force: true });
  }

  async read(uri: string): Promise<Buffer> {
    if (!uri.startsWith("local://")) throw new Error("BLOB_URI_UNSUPPORTED");
    return readFile(this.resolve(uri.slice("local://".length)));
  }

  async readRange(uri: string, start: number, end: number): Promise<Buffer> {
    if (!uri.startsWith("local://")) throw new Error("BLOB_URI_UNSUPPORTED");
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
      throw new Error("BLOB_RANGE_INVALID");
    }
    const handle = await open(this.resolve(uri.slice("local://".length)), "r");
    try {
      const file = await handle.stat();
      if (!file.isFile() || end >= file.size) throw new Error("BLOB_RANGE_OUT_OF_BOUNDS");
      const bytes = Buffer.allocUnsafe(end - start + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, start);
      if (bytesRead !== bytes.byteLength) throw new Error("BLOB_RANGE_OUT_OF_BOUNDS");
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async exists(uri: string): Promise<boolean> {
    if (!uri.startsWith("local://")) return false;
    return lstat(this.resolve(uri.slice("local://".length))).then(
      (value) => value.isFile(),
      () => false
    );
  }

  async listImmutableUris(): Promise<string[]> {
    const uris: string[] = [];
    const collect = async (relative: string): Promise<void> => {
      let entries;
      try {
        entries = await readdir(this.resolve(relative), { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const child = relative ? path.posix.join(relative, entry.name) : entry.name;
        if (entry.isDirectory()) {
          if (child !== ".temporary") await collect(child);
        } else if (entry.isFile()) {
          uris.push(`local://${child}`);
        }
      }
    };
    await collect("");
    return uris.sort();
  }
}
