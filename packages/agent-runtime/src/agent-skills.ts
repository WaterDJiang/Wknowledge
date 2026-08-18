import {
  agentSkillManifestSchema,
  type AgentSkillManifest,
  type SkillManifest
} from "@wknowledge/contracts";

/**
 * Agent Skills compatibility layer (M5-14, ADR 0004/0005).
 *
 * Parses standard `SKILL.md` entries and classifies a skill directory as
 * instruction-only or executable. Pure string/name-level functions only: no
 * filesystem, network, database or credential access — discovery and the
 * tenant-scoped ResourceLoader are later slices. All skill-provided text is
 * untrusted data; nothing parsed here can grant permissions, and executable
 * content without a `wknowledge.manifest.json` contract can never execute.
 */

export interface AgentSkillEntry {
  name: string;
  description: string;
  license?: string;
  body: string;
}

export type AgentSkillClassification =
  | { kind: "instruction-only"; undeclaredExecutableContent: boolean }
  | { kind: "executable"; manifest: AgentSkillManifest };

export interface ClassifyAgentSkillInput {
  skillMarkdown: string;
  manifestJson: string | null;
  entryNames: readonly string[];
}

export interface ClassifiedAgentSkill {
  entry: AgentSkillEntry;
  classification: AgentSkillClassification;
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const KEY_PATTERN = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_LICENSE_LENGTH = 200;
const SCRIPT_EXTENSIONS = [".sh", ".py", ".ts", ".tsx", ".js", ".mjs", ".cjs"] as const;
export const AGENT_SKILL_MANIFEST_FILENAME = "wknowledge.manifest.json";

function skillError(code: string): never {
  throw new Error(code);
}

/**
 * Strips one pair of matching surrounding quotes. v1 accepts single-line
 * scalar values only; escapes are not processed and anything the constrained
 * grammar cannot represent unambiguously fails closed instead of guessing.
 */
function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSkillMarkdown(source: string): AgentSkillEntry {
  if (typeof source !== "string" || source.length === 0)
    skillError("AGENT_SKILL_FRONTMATTER_MISSING");
  const normalized = source.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) skillError("AGENT_SKILL_FRONTMATTER_MISSING");
  const lines = normalized.slice("---\n".length).split("\n");
  const end = lines.indexOf("---");
  if (end === -1) skillError("AGENT_SKILL_FRONTMATTER_UNTERMINATED");
  const body = lines
    .slice(end + 1)
    .join("\n")
    .trim();

  const values = new Map<string, string>();
  for (const line of lines.slice(0, end)) {
    if (line.trim().length === 0) continue;
    if (/^\s/.test(line) || /^-\s/.test(line)) skillError("AGENT_SKILL_FRONTMATTER_UNSUPPORTED");
    const match = KEY_PATTERN.exec(line);
    if (!match) skillError("AGENT_SKILL_FRONTMATTER_INVALID");
    const [, key = "", raw = ""] = match;
    if (values.has(key)) skillError("AGENT_SKILL_FRONTMATTER_INVALID");
    const value = unquote(raw.trim());
    if (value === "|" || value === ">" || value.startsWith("| ") || value.startsWith("> ")) {
      skillError("AGENT_SKILL_FRONTMATTER_UNSUPPORTED");
    }
    values.set(key, value);
  }

  const name = values.get("name");
  if (name === undefined) skillError("AGENT_SKILL_NAME_MISSING");
  if (!NAME_PATTERN.test(name)) skillError("AGENT_SKILL_NAME_INVALID");
  const description = values.get("description");
  if (description === undefined) skillError("AGENT_SKILL_DESCRIPTION_MISSING");
  if (description.length === 0 || description.length > MAX_DESCRIPTION_LENGTH) {
    skillError("AGENT_SKILL_DESCRIPTION_INVALID");
  }
  const license = values.get("license");
  if (license !== undefined && (license.length === 0 || license.length > MAX_LICENSE_LENGTH)) {
    skillError("AGENT_SKILL_LICENSE_INVALID");
  }
  if (body.length === 0) skillError("AGENT_SKILL_BODY_EMPTY");
  return {
    name,
    description,
    ...(license !== undefined ? { license } : {}),
    body
  };
}

export function classifyAgentSkill(input: ClassifyAgentSkillInput): ClassifiedAgentSkill {
  const entry = parseSkillMarkdown(input.skillMarkdown);
  if (input.entryNames.includes(AGENT_SKILL_MANIFEST_FILENAME)) {
    if (typeof input.manifestJson !== "string" || input.manifestJson.trim().length === 0) {
      skillError("AGENT_SKILL_MANIFEST_INVALID");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.manifestJson);
    } catch {
      skillError("AGENT_SKILL_MANIFEST_INVALID");
    }
    const manifest = agentSkillManifestSchema.safeParse(parsed);
    if (!manifest.success) skillError("AGENT_SKILL_MANIFEST_INVALID");
    return { entry, classification: { kind: "executable", manifest: manifest.data } };
  }
  // Top-level heuristic on the directory listing: a scripts/ directory or a
  // top-level script file marks executable content. Without the manifest
  // contract such content is flagged and can never be admitted for execution.
  const undeclaredExecutableContent = input.entryNames.some(
    (name) => name === "scripts" || SCRIPT_EXTENSIONS.some((extension) => name.endsWith(extension))
  );
  return { entry, classification: { kind: "instruction-only", undeclaredExecutableContent } };
}

/**
 * Legacy `skill.json` entrypoints that map onto a supported dynamic runtime.
 * Builtin worker dispatch (`index.ts`) and internal worker entrypoints
 * (`worker:*`) deliberately do NOT become executable manifests: their
 * execution moves to the Tool Registry and domain components instead.
 */
const LEGACY_DYNAMIC_RUNTIME_ENTRIES: Record<string, string> = {
  "typescript-json-cli": "run.mjs",
  "python-json-cli": "run.py"
};

export interface ConvertedLegacySkill {
  skillMarkdown: string;
  manifestJson: string | null;
  conversion: {
    sourceFormat: "skill.json";
    sourceVersion: string;
    sourceDigest: string;
    sourceEntrypoint: string;
    executable: boolean;
  };
}

function formatNetwork(network: string[] | "deny"): string {
  return network === "deny" ? "deny" : network.join("、");
}

export function convertLegacySkillManifest(manifest: SkillManifest): ConvertedLegacySkill {
  if (!NAME_PATTERN.test(manifest.id)) skillError("AGENT_SKILL_CONVERSION_INVALID");
  if (
    manifest.description.includes("\n") ||
    manifest.description.length === 0 ||
    manifest.description.length > MAX_DESCRIPTION_LENGTH
  ) {
    skillError("AGENT_SKILL_CONVERSION_INVALID");
  }

  const entryFile = LEGACY_DYNAMIC_RUNTIME_ENTRIES[manifest.entrypoint];
  const manifestJson =
    entryFile !== undefined
      ? `${JSON.stringify(
          {
            runtime: manifest.entrypoint,
            entry: entryFile,
            inputSchema: manifest.inputSchema,
            outputSchema: manifest.outputSchema,
            requiredCapabilities: manifest.requiredCapabilities,
            permissions: manifest.permissions,
            limits: manifest.limits,
            artifacts: []
          },
          null,
          2
        )}\n`
      : null;

  const body = [
    "> 本文件由 `skill.json`（版本 " +
      manifest.version +
      "，digest `" +
      manifest.digest +
      "`）自动迁移生成，不是作者手写的工作流说明。执行契约以同目录 `wknowledge.manifest.json`（如存在）与平台安装快照为准。",
    "",
    "## 迁移自 skill.json 的结构化契约",
    "",
    "- 资源范围：" + manifest.permissions.resources,
    "- 文件系统：" + manifest.permissions.filesystem,
    "- 网络：" + formatNetwork(manifest.permissions.network),
    "- 审批策略：" + manifest.permissions.approval,
    "- 限额：超时 " +
      manifest.limits.timeoutSeconds +
      " 秒 · 内存 " +
      manifest.limits.memoryMb +
      " MB · 模型调用上限 " +
      manifest.limits.maxModelCalls,
    "- 所需模型能力：" + (manifest.requiredCapabilities.join("、") || "无"),
    "- 旧执行入口：`" + manifest.entrypoint + "`"
  ].join("\n");

  return {
    skillMarkdown: `---\nname: ${manifest.id}\ndescription: ${manifest.description}\n---\n\n${body}\n`,
    manifestJson,
    conversion: {
      sourceFormat: "skill.json",
      sourceVersion: manifest.version,
      sourceDigest: manifest.digest,
      sourceEntrypoint: manifest.entrypoint,
      executable: manifestJson !== null
    }
  };
}
