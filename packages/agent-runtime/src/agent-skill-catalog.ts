import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentSkillInstallationSnapshot } from "@wknowledge/contracts";
import { AGENT_SKILL_MANIFEST_FILENAME, classifyAgentSkill } from "./agent-skills";
import type { AgentSkillClassification, AgentSkillEntry } from "./agent-skills";

/**
 * Tenant-scoped Agent Skills catalog (M5-14, ADR 0004 decision 4).
 *
 * Discovery reads one explicit managed root per invocation — never a default
 * path, never the server home directory. Every directory under the root must
 * be a well-formed skill; ambiguous or tampered shapes (symlinks, duplicate
 * skill names, oversized entries) fail closed with stable error codes.
 * `resolveInstalledAgentSkills` then applies the organization installation
 * snapshots: only installed skills become visible, disabled snapshots are
 * revocations, and any content drift from the pinned digest fails closed.
 */

export interface AgentSkillFsAdapter {
  listEntryNames(directory: string): Promise<readonly string[]>;
  statEntry(
    directory: string,
    name: string
  ): Promise<{ kind: "file" | "directory"; symlink: boolean }>;
  readFileContent(path: string, maxBytes: number): Promise<string>;
}

export interface AgentSkillCatalogEntry {
  directoryName: string;
  entry: AgentSkillEntry;
  classification: AgentSkillClassification;
  /**
   * Pins the discovered content: the sorted top-level entry listing plus the
   * SKILL.md and (when present) manifest bytes. Adding or removing entries —
   * e.g. a silently dropped-in scripts/ directory — changes the digest even
   * when the two files stay identical. Deeper file contents are pinned by the
   * execution admission, not by the catalog digest.
   */
  digest: string;
}

export interface ResolvedInstalledAgentSkill {
  entry: AgentSkillCatalogEntry;
  snapshot: AgentSkillInstallationSnapshot;
}

export interface DiscoverAgentSkillCatalogInput {
  rootDirectory: string;
  fs: AgentSkillFsAdapter;
}

export const AGENT_SKILL_CATALOG_LIMITS = {
  maxRootEntries: 1024,
  maxSkills: 256,
  maxSkillEntries: 1024,
  maxSkillMarkdownBytes: 1_048_576,
  maxManifestBytes: 262_144
} as const;

function catalogError(code: string): never {
  throw new Error(code);
}

function isUnsafeEntryName(name: string): boolean {
  return (
    name.length === 0 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  );
}

function childPath(directory: string, name: string): string {
  return `${directory}/${name}`;
}

/**
 * Deterministic content digest over what discovery actually observed. Used at
 * install time (snapshot creation) and at resolution time (drift check), so
 * both sides hash the exact same byte sequence.
 */
export function computeAgentSkillCatalogDigest(input: {
  entryNames: readonly string[];
  skillMarkdown: string;
  manifestJson: string | null;
}): string {
  const hash = createHash("sha256");
  for (const name of [...input.entryNames].sort()) {
    hash.update(name, "utf8");
    hash.update("\0");
  }
  hash.update("SKILL.md\0");
  hash.update(input.skillMarkdown, "utf8");
  hash.update("\0");
  if (input.manifestJson !== null) {
    hash.update(`${AGENT_SKILL_MANIFEST_FILENAME}\0`);
    hash.update(input.manifestJson, "utf8");
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function readRegularFile(
  input: DiscoverAgentSkillCatalogInput,
  skillDirectory: string,
  fileName: string,
  maxBytes: number
): Promise<string> {
  const stats = await input.fs.statEntry(skillDirectory, fileName);
  if (stats.symlink) catalogError("AGENT_SKILL_SYMLINK_REJECTED");
  if (stats.kind !== "file") catalogError("AGENT_SKILL_DIRECTORY_INVALID");
  return input.fs.readFileContent(childPath(skillDirectory, fileName), maxBytes);
}

export async function discoverAgentSkillCatalog(
  input: DiscoverAgentSkillCatalogInput
): Promise<{ skills: readonly AgentSkillCatalogEntry[] }> {
  if (typeof input.rootDirectory !== "string" || input.rootDirectory.trim().length === 0) {
    catalogError("AGENT_SKILL_ROOT_INVALID");
  }
  const rootEntries = await input.fs.listEntryNames(input.rootDirectory);
  if (rootEntries.length > AGENT_SKILL_CATALOG_LIMITS.maxRootEntries) {
    catalogError("AGENT_SKILL_CATALOG_LIMIT");
  }

  const skills: AgentSkillCatalogEntry[] = [];
  const names = new Set<string>();
  for (const directoryName of rootEntries) {
    if (isUnsafeEntryName(directoryName)) catalogError("AGENT_SKILL_ENTRY_UNSAFE");
    const stats = await input.fs.statEntry(input.rootDirectory, directoryName);
    if (stats.symlink) catalogError("AGENT_SKILL_SYMLINK_REJECTED");
    if (stats.kind === "file") continue;

    if (skills.length >= AGENT_SKILL_CATALOG_LIMITS.maxSkills) {
      catalogError("AGENT_SKILL_CATALOG_LIMIT");
    }
    const skillDirectory = childPath(input.rootDirectory, directoryName);
    const skillEntries = await input.fs.listEntryNames(skillDirectory);
    if (skillEntries.length > AGENT_SKILL_CATALOG_LIMITS.maxSkillEntries) {
      catalogError("AGENT_SKILL_CATALOG_LIMIT");
    }
    for (const entryName of skillEntries) {
      if (isUnsafeEntryName(entryName)) catalogError("AGENT_SKILL_ENTRY_UNSAFE");
    }
    if (!skillEntries.includes("SKILL.md")) catalogError("AGENT_SKILL_DIRECTORY_INVALID");

    const skillMarkdown = await readRegularFile(
      input,
      skillDirectory,
      "SKILL.md",
      AGENT_SKILL_CATALOG_LIMITS.maxSkillMarkdownBytes
    );
    const manifestJson = skillEntries.includes(AGENT_SKILL_MANIFEST_FILENAME)
      ? await readRegularFile(
          input,
          skillDirectory,
          AGENT_SKILL_MANIFEST_FILENAME,
          AGENT_SKILL_CATALOG_LIMITS.maxManifestBytes
        )
      : null;

    const { entry, classification } = classifyAgentSkill({
      skillMarkdown,
      manifestJson,
      entryNames: skillEntries
    });
    if (names.has(entry.name)) catalogError("AGENT_SKILL_NAME_CONFLICT");
    names.add(entry.name);
    skills.push({
      directoryName,
      entry,
      classification,
      digest: computeAgentSkillCatalogDigest({
        entryNames: skillEntries,
        skillMarkdown,
        manifestJson
      })
    });
  }
  return { skills };
}

/**
 * Applies organization installation snapshots to a discovered catalog
 * (ADR 0004 decision 4: the ResourceLoader only returns skills the
 * organization installed and still has enabled).
 *
 * - A snapshot for a skill missing from the managed root fails closed: an
 *   installed skill disappearing is a tamper signal, not a silent downgrade.
 * - Any digest drift from the pinned snapshot fails closed.
 * - Disabled snapshots revoke the skill (filtered, not an error).
 * - Catalog skills without a snapshot are invisible to this organization.
 */
export function resolveInstalledAgentSkills(input: {
  snapshots: readonly AgentSkillInstallationSnapshot[];
  skills: readonly AgentSkillCatalogEntry[];
}): { skills: readonly ResolvedInstalledAgentSkill[] } {
  const byName = new Map<string, AgentSkillInstallationSnapshot>();
  for (const snapshot of input.snapshots) {
    if (byName.has(snapshot.skillName)) catalogError("AGENT_SKILL_SNAPSHOT_INVALID");
    byName.set(snapshot.skillName, snapshot);
  }
  const catalogByName = new Map(input.skills.map((skill) => [skill.entry.name, skill]));

  const resolved: ResolvedInstalledAgentSkill[] = [];
  for (const [name, snapshot] of byName) {
    if (!snapshot.enabled) continue;
    const catalogEntry = catalogByName.get(name);
    if (!catalogEntry) catalogError("AGENT_SKILL_SNAPSHOT_UNRESOLVED");
    if (catalogEntry.digest !== snapshot.digest) catalogError("AGENT_SKILL_SNAPSHOT_DRIFT");
    resolved.push({ entry: catalogEntry, snapshot });
  }
  resolved.sort((left, right) => left.entry.entry.name.localeCompare(right.entry.entry.name));
  return { skills: resolved };
}

export function createNodeAgentSkillFsAdapter(): AgentSkillFsAdapter {
  return {
    async listEntryNames(directory) {
      return (await readdir(directory)).sort();
    },
    async statEntry(directory, name) {
      const stats = await lstat(join(directory, name));
      return {
        kind: stats.isDirectory() ? "directory" : "file",
        symlink: stats.isSymbolicLink()
      };
    },
    async readFileContent(path, maxBytes) {
      const handle = await open(path, "r");
      try {
        const size = (await handle.stat()).size;
        if (size > maxBytes) catalogError("AGENT_SKILL_FILE_TOO_LARGE");
        const buffer = Buffer.alloc(size);
        if (size > 0) await handle.read(buffer, 0, size, 0);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        } catch {
          catalogError("AGENT_SKILL_CONTENT_INVALID_UTF8");
        }
      } finally {
        await handle.close();
      }
    }
  };
}
