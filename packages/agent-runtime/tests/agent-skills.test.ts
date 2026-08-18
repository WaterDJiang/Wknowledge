import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { skillManifestSchema } from "@wknowledge/contracts";
import {
  AGENT_SKILL_MANIFEST_FILENAME,
  classifyAgentSkill,
  convertLegacySkillManifest,
  parseSkillMarkdown
} from "../src/index";

function skillMarkdown(frontmatter: string, body = "## 工作流\n\n按遗忘曲线组织复习。"): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function validManifest(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    runtime: "python-json-cli",
    entry: "scripts/main.py",
    inputSchema: { type: "object", required: ["goal"] },
    outputSchema: { type: "object" },
    requiredCapabilities: [],
    permissions: {
      resources: "none",
      filesystem: "write-artifacts",
      network: "deny",
      approval: "never"
    },
    limits: { timeoutSeconds: 30, memoryMb: 256, maxModelCalls: 0 },
    ...overrides
  });
}

describe("parseSkillMarkdown", () => {
  it("parses a minimal standard entry", () => {
    expect(
      parseSkillMarkdown(
        skillMarkdown("name: spaced-repetition\ndescription: 用间隔检索安排复习。")
      )
    ).toEqual({
      name: "spaced-repetition",
      description: "用间隔检索安排复习。",
      body: "## 工作流\n\n按遗忘曲线组织复习。"
    });
  });

  it("keeps an optional license and ignores unknown scalar keys", () => {
    const entry = parseSkillMarkdown(
      skillMarkdown(
        "name: pdf-extract\ndescription: Extract text.\nlicense: Apache-2.0\nallowed-tools: none"
      )
    );
    expect(entry).toMatchObject({ name: "pdf-extract", license: "Apache-2.0" });
  });

  it("unquotes a quoted description containing a colon", () => {
    const entry = parseSkillMarkdown(
      skillMarkdown('name: quote-demo\ndescription: "主题: 间隔检索"')
    );
    expect(entry.description).toBe("主题: 间隔检索");
  });

  it("accepts CRLF line endings", () => {
    const source = skillMarkdown("name: crlf-demo\ndescription: Windows 风格。").replace(
      /\n/g,
      "\r\n"
    );
    expect(parseSkillMarkdown(source)).toMatchObject({ name: "crlf-demo" });
  });

  it.each([
    {
      name: "missing frontmatter",
      source: "# Just a heading\n",
      code: "AGENT_SKILL_FRONTMATTER_MISSING"
    },
    {
      name: "unterminated frontmatter",
      source: "---\nname: demo\n",
      code: "AGENT_SKILL_FRONTMATTER_UNTERMINATED"
    },
    {
      name: "missing name",
      source: skillMarkdown("description: no name"),
      code: "AGENT_SKILL_NAME_MISSING"
    },
    {
      name: "uppercase name",
      source: skillMarkdown("name: Demo\ndescription: x"),
      code: "AGENT_SKILL_NAME_INVALID"
    },
    {
      name: "underscore name",
      source: skillMarkdown("name: demo_skill\ndescription: x"),
      code: "AGENT_SKILL_NAME_INVALID"
    },
    {
      name: "leading digit name",
      source: skillMarkdown("name: 1demo\ndescription: x"),
      code: "AGENT_SKILL_NAME_INVALID"
    },
    {
      name: "overlong name",
      source: skillMarkdown(`name: ${"a".repeat(65)}\ndescription: x`),
      code: "AGENT_SKILL_NAME_INVALID"
    },
    {
      name: "missing description",
      source: skillMarkdown("name: demo"),
      code: "AGENT_SKILL_DESCRIPTION_MISSING"
    },
    {
      name: "blank description",
      source: skillMarkdown("name: demo\ndescription:   "),
      code: "AGENT_SKILL_DESCRIPTION_INVALID"
    },
    {
      name: "overlong description",
      source: skillMarkdown(`name: demo\ndescription: ${"x".repeat(1025)}`),
      code: "AGENT_SKILL_DESCRIPTION_INVALID"
    },
    {
      name: "overlong license",
      source: skillMarkdown(`name: demo\ndescription: x\nlicense: ${"l".repeat(201)}`),
      code: "AGENT_SKILL_LICENSE_INVALID"
    },
    {
      name: "indented nested value",
      source: skillMarkdown("name: demo\ndescription: x\nmetadata:\n  key: value"),
      code: "AGENT_SKILL_FRONTMATTER_UNSUPPORTED"
    },
    {
      name: "list item",
      source: skillMarkdown("name: demo\ndescription: x\n- item"),
      code: "AGENT_SKILL_FRONTMATTER_UNSUPPORTED"
    },
    {
      name: "block scalar",
      source: skillMarkdown("name: demo\ndescription: |"),
      code: "AGENT_SKILL_FRONTMATTER_UNSUPPORTED"
    },
    {
      name: "duplicate key",
      source: skillMarkdown("name: demo\ndescription: x\ndescription: y"),
      code: "AGENT_SKILL_FRONTMATTER_INVALID"
    },
    {
      name: "bare key without value",
      source: skillMarkdown("name:\ndescription: x"),
      code: "AGENT_SKILL_NAME_INVALID"
    },
    {
      name: "garbage line",
      source: skillMarkdown("name: demo\ndescription: x\n???"),
      code: "AGENT_SKILL_FRONTMATTER_INVALID"
    },
    {
      name: "empty body",
      source: `---\nname: demo\ndescription: x\n---\n\n   `,
      code: "AGENT_SKILL_BODY_EMPTY"
    }
  ])("rejects $name with $code", ({ source, code }) => {
    expect(() => parseSkillMarkdown(source)).toThrow(code);
  });
});

describe("classifyAgentSkill", () => {
  it("classifies a docs-only skill as instruction-only without executable content", () => {
    const result = classifyAgentSkill({
      skillMarkdown: skillMarkdown("name: docs-demo\ndescription: Reading only."),
      manifestJson: null,
      entryNames: ["SKILL.md", "references", "assets"]
    });
    expect(result.classification).toEqual({
      kind: "instruction-only",
      undeclaredExecutableContent: false
    });
  });

  it.each([
    { label: "a scripts directory", entryNames: ["SKILL.md", "scripts", "references"] },
    { label: "a top-level python file", entryNames: ["SKILL.md", "run.py"] },
    { label: "a top-level shell file", entryNames: ["SKILL.md", "helper.sh"] }
  ])(
    "flags undeclared executable content from $label but keeps it instruction-only",
    ({ entryNames }) => {
      const result = classifyAgentSkill({
        skillMarkdown: skillMarkdown("name: scripts-demo\ndescription: Has scripts."),
        manifestJson: null,
        entryNames
      });
      expect(result.classification).toEqual({
        kind: "instruction-only",
        undeclaredExecutableContent: true
      });
    }
  );

  it("classifies a skill with a valid manifest as executable", () => {
    const result = classifyAgentSkill({
      skillMarkdown: skillMarkdown("name: exec-demo\ndescription: Runs a script."),
      manifestJson: validManifest(),
      entryNames: ["SKILL.md", AGENT_SKILL_MANIFEST_FILENAME, "scripts"]
    });
    expect(result.classification).toEqual({
      kind: "executable",
      manifest: expect.objectContaining({
        runtime: "python-json-cli",
        entry: "scripts/main.py",
        artifacts: []
      })
    });
  });

  it.each([
    { label: "manifest declared but not provided", manifestJson: null },
    { label: "manifest empty", manifestJson: "  " },
    { label: "manifest not JSON", manifestJson: "{not json" },
    { label: "unknown runtime", manifestJson: validManifest({ runtime: "bash" }) },
    {
      label: "entry with parent traversal",
      manifestJson: validManifest({ entry: "scripts/../../main.py" })
    },
    { label: "absolute entry", manifestJson: validManifest({ entry: "/etc/main.py" }) },
    { label: "backslash entry", manifestJson: validManifest({ entry: "scripts\\main.py" }) },
    {
      label: "artifacts with traversal",
      manifestJson: validManifest({ artifacts: ["../out.bin"] })
    },
    {
      label: "limits out of range",
      manifestJson: validManifest({
        limits: { timeoutSeconds: 0, memoryMb: 256, maxModelCalls: 0 }
      })
    },
    {
      label: "invalid permissions enum",
      manifestJson: validManifest({
        permissions: {
          resources: "everything",
          filesystem: "read",
          network: "deny",
          approval: "never"
        }
      })
    }
  ])("rejects an executable claim when $label", ({ manifestJson }) => {
    expect(() =>
      classifyAgentSkill({
        skillMarkdown: skillMarkdown("name: bad-exec\ndescription: Bad contract."),
        manifestJson,
        entryNames: ["SKILL.md", AGENT_SKILL_MANIFEST_FILENAME, "scripts"]
      })
    ).toThrow("AGENT_SKILL_MANIFEST_INVALID");
  });
});

describe("agent skills privilege guard", () => {
  it("keeps the parser pure: no node builtins, env access or non-contract imports", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/agent-skills.ts", import.meta.url)),
      "utf8"
    );
    expect(source).not.toMatch(/\bnode:/);
    expect(source).not.toMatch(/process\.env/);
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(
        specifier.startsWith("./") || specifier === "@wknowledge/contracts",
        `unexpected import ${specifier}`
      ).toBe(true);
    }
  });
});

function legacyManifest(overrides: Record<string, unknown> = {}) {
  return skillManifestSchema.parse({
    id: "legacy-demo",
    version: "1.2.0",
    digest: `sha256:${"a".repeat(64)}`,
    description: "旧格式技能的描述。",
    inputSchema: { type: "object", required: ["goal"] },
    outputSchema: { type: "object" },
    requiredCapabilities: [],
    permissions: {
      resources: "selected",
      filesystem: "read",
      network: "deny",
      approval: "never"
    },
    limits: { timeoutSeconds: 60, memoryMb: 256, maxModelCalls: 1 },
    entrypoint: "typescript-json-cli",
    ...overrides
  });
}

describe("convertLegacySkillManifest", () => {
  it("converts a dynamic runtime manifest to an executable skill", () => {
    const converted = convertLegacySkillManifest(legacyManifest());
    expect(converted.manifestJson).not.toBeNull();
    const manifest = JSON.parse(converted.manifestJson ?? "{}");
    expect(manifest).toMatchObject({
      runtime: "typescript-json-cli",
      entry: "run.mjs",
      artifacts: [],
      permissions: {
        resources: "selected",
        filesystem: "read",
        network: "deny",
        approval: "never"
      },
      limits: { timeoutSeconds: 60, memoryMb: 256, maxModelCalls: 1 }
    });
    const classified = classifyAgentSkill({
      skillMarkdown: converted.skillMarkdown,
      manifestJson: converted.manifestJson,
      entryNames: ["SKILL.md", AGENT_SKILL_MANIFEST_FILENAME, "run.mjs"]
    });
    expect(classified.classification).toMatchObject({ kind: "executable" });
    expect(converted.conversion).toEqual({
      sourceFormat: "skill.json",
      sourceVersion: "1.2.0",
      sourceDigest: `sha256:${"a".repeat(64)}`,
      sourceEntrypoint: "typescript-json-cli",
      executable: true
    });
  });

  it.each([
    { label: "a builtin worker handler", entrypoint: "index.ts" },
    { label: "an internal worker dispatch", entrypoint: "worker:learning-generation" }
  ])(
    "converts $label to instruction-only without inventing an execution contract",
    ({ entrypoint }) => {
      const converted = convertLegacySkillManifest(legacyManifest({ entrypoint }));
      expect(converted.manifestJson).toBeNull();
      expect(converted.conversion.executable).toBe(false);
      const classified = classifyAgentSkill({
        skillMarkdown: converted.skillMarkdown,
        manifestJson: null,
        entryNames: ["SKILL.md", "index.ts"]
      });
      expect(classified.classification).toEqual({
        kind: "instruction-only",
        undeclaredExecutableContent: true
      });
    }
  );

  it("round-trips the generated SKILL.md through the standard parser", () => {
    const converted = convertLegacySkillManifest(legacyManifest());
    const entry = parseSkillMarkdown(converted.skillMarkdown);
    expect(entry.name).toBe("legacy-demo");
    expect(entry.description).toBe("旧格式技能的描述。");
    expect(entry.body).toContain("1.2.0");
    expect(entry.body).toContain(`sha256:${"a".repeat(64)}`);
  });

  it.each([
    { label: "a leading-digit id", overrides: { id: "1demo" } },
    { label: "a multiline description", overrides: { description: "line\nbreak" } },
    { label: "an overlong description", overrides: { description: "x".repeat(1025) } }
  ])("rejects $label against the SKILL.md contract", ({ overrides }) => {
    expect(() => convertLegacySkillManifest(legacyManifest(overrides))).toThrow(
      "AGENT_SKILL_CONVERSION_INVALID"
    );
  });

  it("converts every real builtin skill.json fixture", () => {
    const builtinRoot = fileURLToPath(new URL("../../../skills/builtin", import.meta.url));
    const directories = readdirSync(builtinRoot, { withFileTypes: true }).filter((entry) =>
      entry.isDirectory()
    );
    expect(directories.length).toBeGreaterThanOrEqual(5);
    for (const directory of directories) {
      const manifest = skillManifestSchema.parse(
        JSON.parse(readFileSync(`${builtinRoot}/${directory.name}/skill.json`, "utf8"))
      );
      const converted = convertLegacySkillManifest(manifest);
      const entry = parseSkillMarkdown(converted.skillMarkdown);
      expect(entry.name, directory.name).toBe(manifest.id);
      expect(converted.manifestJson, directory.name).toBeNull();
      expect(converted.conversion.sourceDigest, directory.name).toBe(manifest.digest);
    }
  });
});
