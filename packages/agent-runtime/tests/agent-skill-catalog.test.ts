import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AGENT_SKILL_CATALOG_LIMITS,
  createNodeAgentSkillFsAdapter,
  discoverAgentSkillCatalog,
  resolveInstalledAgentSkills,
  type AgentSkillFsAdapter
} from "../src/index";

type FakeNode =
  | { type: "file"; content: string; symlink?: boolean }
  | { type: "directory"; entries: Record<string, FakeNode>; symlink?: boolean };

function fakeAdapter(root: Record<string, FakeNode>): AgentSkillFsAdapter {
  // The fake maps "managed-root/<subpath>" onto the provided root contents;
  // rootDirectory is always a single segment in fake-backed tests.
  function lookup(path: string): FakeNode | null {
    const segments = path.split("/").filter(Boolean).slice(1);
    let node: FakeNode = { type: "directory", entries: root };
    for (const segment of segments) {
      if (node.type !== "directory") return null;
      const next: FakeNode | undefined = node.entries[segment];
      if (!next) return null;
      node = next;
    }
    return node;
  }
  return {
    async listEntryNames(directory) {
      const node = lookup(directory);
      if (!node || node.type !== "directory") throw new Error("ENOENT");
      return Object.keys(node.entries).sort();
    },
    async statEntry(directory, name) {
      const node = lookup(`${directory}/${name}`);
      if (!node) throw new Error("ENOENT");
      return {
        kind: node.type === "directory" ? ("directory" as const) : ("file" as const),
        symlink: Boolean(node.symlink)
      };
    },
    async readFileContent(path, maxBytes) {
      const node = lookup(path);
      if (!node || node.type !== "file") throw new Error("ENOENT");
      if (Buffer.byteLength(node.content, "utf8") > maxBytes) {
        throw new Error("AGENT_SKILL_FILE_TOO_LARGE");
      }
      return node.content;
    }
  };
}

function skillDirectory(
  frontmatter = "name: demo-skill\ndescription: A demo.",
  extra: Record<string, FakeNode> = {}
): FakeNode {
  return {
    type: "directory",
    entries: {
      "SKILL.md": { type: "file", content: `---\n${frontmatter}\n---\n\n正文说明。` },
      ...extra
    }
  };
}

describe("discoverAgentSkillCatalog", () => {
  it("discovers instruction-only and executable skills from an explicit root", async () => {
    const manifest = JSON.stringify({
      runtime: "python-json-cli",
      entry: "scripts/main.py",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      requiredCapabilities: [],
      permissions: { resources: "none", filesystem: "none", network: "deny", approval: "never" },
      limits: { timeoutSeconds: 30, memoryMb: 256, maxModelCalls: 0 }
    });
    const result = await discoverAgentSkillCatalog({
      rootDirectory: "managed-root",
      fs: fakeAdapter({
        "README.md": { type: "file", content: "not a skill" },
        "docs-skill": skillDirectory(),
        "exec-skill": skillDirectory("name: exec-skill\ndescription: Executable.", {
          "wknowledge.manifest.json": { type: "file", content: manifest },
          scripts: { type: "directory", entries: {} }
        })
      })
    });
    expect(result.skills).toHaveLength(2);
    expect(result.skills[0]).toMatchObject({
      directoryName: "docs-skill",
      entry: { name: "demo-skill" },
      classification: { kind: "instruction-only", undeclaredExecutableContent: false }
    });
    expect(result.skills[1]).toMatchObject({
      directoryName: "exec-skill",
      classification: { kind: "executable" }
    });
  });

  it("returns an empty catalog for an empty managed root", async () => {
    const result = await discoverAgentSkillCatalog({
      rootDirectory: "empty-root",
      fs: fakeAdapter({})
    });
    expect(result.skills).toEqual([]);
  });

  it.each([
    {
      label: "a symlinked skill directory",
      root: { demo: { type: "directory", entries: {}, symlink: true } },
      code: "AGENT_SKILL_SYMLINK_REJECTED"
    },
    {
      label: "a directory without SKILL.md",
      root: {
        demo: { type: "directory", entries: { "notes.txt": { type: "file", content: "x" } } }
      },
      code: "AGENT_SKILL_DIRECTORY_INVALID"
    },
    {
      label: "SKILL.md replaced by a directory",
      root: {
        demo: { type: "directory", entries: { "SKILL.md": { type: "directory", entries: {} } } }
      },
      code: "AGENT_SKILL_DIRECTORY_INVALID"
    },
    {
      label: "SKILL.md replaced by a symlink",
      root: {
        demo: {
          type: "directory",
          entries: { "SKILL.md": { type: "file", content: "x", symlink: true } }
        }
      },
      code: "AGENT_SKILL_SYMLINK_REJECTED"
    },
    {
      label: "duplicate skill names across directories",
      root: {
        one: skillDirectory(),
        two: skillDirectory()
      },
      code: "AGENT_SKILL_NAME_CONFLICT"
    },
    {
      label: "an oversize SKILL.md",
      root: {
        demo: {
          type: "directory",
          entries: {
            "SKILL.md": {
              type: "file",
              content: `---\nname: demo\ndescription: x\n---\n\n${"a".repeat(
                AGENT_SKILL_CATALOG_LIMITS.maxSkillMarkdownBytes
              )}`
            }
          }
        }
      },
      code: "AGENT_SKILL_FILE_TOO_LARGE"
    },
    {
      label: "an unsafe directory name",
      root: { "../escape": skillDirectory() },
      code: "AGENT_SKILL_ENTRY_UNSAFE"
    },
    {
      label: "an unsafe entry inside a skill",
      root: {
        demo: skillDirectory("name: demo\ndescription: x", {
          "a/b": { type: "file", content: "x" }
        })
      },
      code: "AGENT_SKILL_ENTRY_UNSAFE"
    },
    {
      label: "an invalid manifest payload",
      root: {
        demo: skillDirectory("name: demo\ndescription: x", {
          "wknowledge.manifest.json": { type: "file", content: "{bad" }
        })
      },
      code: "AGENT_SKILL_MANIFEST_INVALID"
    },
    {
      label: "an invalid SKILL.md frontmatter",
      root: { demo: skillDirectory("description: missing name") },
      code: "AGENT_SKILL_NAME_MISSING"
    }
  ])("rejects $label with $code", async ({ root, code }) => {
    await expect(
      discoverAgentSkillCatalog({ rootDirectory: "managed-root", fs: fakeAdapter(root) })
    ).rejects.toThrow(code);
  });

  it("enforces the skill count limit", async () => {
    const root: Record<string, FakeNode> = {};
    for (let index = 0; index <= AGENT_SKILL_CATALOG_LIMITS.maxSkills; index += 1) {
      root[`skill-${index}`] = skillDirectory(`name: skill-${index}\ndescription: Skill ${index}.`);
    }
    await expect(
      discoverAgentSkillCatalog({ rootDirectory: "managed-root", fs: fakeAdapter(root) })
    ).rejects.toThrow("AGENT_SKILL_CATALOG_LIMIT");
  });
});

describe("createNodeAgentSkillFsAdapter", () => {
  it("discovers a real temp directory and rejects tampered content", async () => {
    const root = await mkdtemp(join(tmpdir(), "wknowledge-skills-"));
    try {
      await writeFile(join(root, "README.md"), "not a skill");
      await mkdir(join(root, "real-skill"));
      await writeFile(
        join(root, "real-skill", "SKILL.md"),
        "---\nname: real-skill\ndescription: From disk.\n---\n\n正文。"
      );
      await mkdir(join(root, "linked-skill"));
      await writeFile(
        join(root, "linked-skill", "SKILL.md"),
        "---\nname: linked-name\ndescription: Another.\n---\n\n正文。"
      );
      await symlink(join(root, "real-skill"), join(root, "symlinked-skill"));

      await expect(
        discoverAgentSkillCatalog({ rootDirectory: root, fs: createNodeAgentSkillFsAdapter() })
      ).rejects.toThrow("AGENT_SKILL_SYMLINK_REJECTED");

      await rm(join(root, "symlinked-skill"));
      const pair = await discoverAgentSkillCatalog({
        rootDirectory: root,
        fs: createNodeAgentSkillFsAdapter()
      });
      expect(pair.skills).toHaveLength(2);

      await rm(join(root, "linked-skill"), { recursive: true });
      const result = await discoverAgentSkillCatalog({
        rootDirectory: root,
        fs: createNodeAgentSkillFsAdapter()
      });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]).toMatchObject({
        directoryName: "real-skill",
        entry: { name: "real-skill" },
        classification: { kind: "instruction-only" }
      });

      await rm(join(root, "real-skill"), { recursive: true });
      await mkdir(join(root, "big-skill"));
      const oversize = Buffer.alloc(AGENT_SKILL_CATALOG_LIMITS.maxSkillMarkdownBytes + 1, 97);
      await writeFile(
        join(root, "big-skill", "SKILL.md"),
        `---\nname: big-skill\ndescription: x\n---\n\n${oversize.toString("utf8")}`
      );
      await expect(
        discoverAgentSkillCatalog({ rootDirectory: root, fs: createNodeAgentSkillFsAdapter() })
      ).rejects.toThrow("AGENT_SKILL_FILE_TOO_LARGE");

      await rm(join(root, "big-skill"), { recursive: true });
      await mkdir(join(root, "binary-skill"));
      const invalid = Buffer.concat([
        Buffer.from("---\nname: binary-skill\ndescription: x\n---\n\n", "utf8"),
        Buffer.from([0xff, 0xfe, 0xff])
      ]);
      await writeFile(join(root, "binary-skill", "SKILL.md"), invalid);
      await expect(
        discoverAgentSkillCatalog({ rootDirectory: root, fs: createNodeAgentSkillFsAdapter() })
      ).rejects.toThrow("AGENT_SKILL_CONTENT_INVALID_UTF8");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("agent skill catalog privilege guard", () => {
  it("limits the catalog module to local fs access without network, env or database", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/agent-skill-catalog.ts", import.meta.url)),
      "utf8"
    );
    const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(
        specifier.startsWith("./") ||
          specifier === "node:fs/promises" ||
          specifier === "node:path" ||
          specifier === "node:crypto" ||
          specifier === "@wknowledge/contracts",
        `unexpected import ${specifier}`
      ).toBe(true);
    }
    expect(source).not.toMatch(/\bnode:(net|http|https|dns|tls|child_process)\b/);
    expect(source).not.toMatch(/process\.env/);
    expect(source).not.toMatch(/getDatabase|pg-boss/);
  });
});

function snapshotOf(skill: { entry: { name: string }; digest: string }, overrides = {}) {
  return {
    id: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
    organizationId: "1a1a1a1a-1a1a-4a1a-8a1a-1a1a1a1a1a1a",
    skillName: skill.entry.name,
    version: "1.0.0",
    digest: skill.digest,
    sourceFormat: "agent-skills-directory",
    publisher: "admin",
    installedAt: "2026-08-18T00:00:00.000Z",
    enabled: true,
    executable: false,
    ...overrides
  };
}

describe("catalog digest", () => {
  function discover(root: Record<string, FakeNode>) {
    return discoverAgentSkillCatalog({ rootDirectory: "managed-root", fs: fakeAdapter(root) });
  }

  it("is stable across identical discoveries and changes when content changes", async () => {
    const base = discover({
      demo: skillDirectory("name: demo\ndescription: x", {
        references: { type: "directory", entries: {} }
      })
    });
    const repeat = discover({
      demo: skillDirectory("name: demo\ndescription: x", {
        references: { type: "directory", entries: {} }
      })
    });
    expect((await base).skills[0]?.digest).toBe((await repeat).skills[0]?.digest);
    expect((await base).skills[0]?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it.each([
    {
      label: "SKILL.md content changes",
      mutate: (entries: Record<string, FakeNode>) => {
        entries["SKILL.md"] = {
          type: "file",
          content: "---\nname: demo\ndescription: y\n---\n\n正文。"
        };
      }
    },
    {
      label: "an entry is silently added",
      mutate: (entries: Record<string, FakeNode>) => {
        entries["scripts"] = { type: "directory", entries: {} };
      }
    },
    {
      label: "an entry is removed",
      mutate: (entries: Record<string, FakeNode>) => {
        delete entries["references"];
      }
    }
  ])("changes when $label", async ({ mutate }) => {
    const entries: Record<string, FakeNode> = {
      "SKILL.md": { type: "file", content: "---\nname: demo\ndescription: x\n---\n\n正文。" },
      references: { type: "directory", entries: {} }
    };
    const before = (await discover({ demo: { type: "directory", entries: { ...entries } } }))
      .skills[0]?.digest;
    mutate(entries);
    const after = (await discover({ demo: { type: "directory", entries } })).skills[0]?.digest;
    expect(after).not.toBe(before);
  });
});

describe("resolveInstalledAgentSkills", () => {
  async function catalogWith(root: Record<string, FakeNode>) {
    const { skills } = await discoverAgentSkillCatalog({
      rootDirectory: "managed-root",
      fs: fakeAdapter(root)
    });
    return skills;
  }

  it("serves only installed and enabled skills with the pinned digest", async () => {
    const skills = await catalogWith({
      installed: skillDirectory("name: installed-skill\ndescription: x"),
      stranger: skillDirectory("name: stranger-skill\ndescription: x")
    });
    const installed = skills.find((skill) => skill.entry.name === "installed-skill");
    expect(installed).toBeDefined();
    const result = resolveInstalledAgentSkills({
      snapshots: [snapshotOf(installed!)],
      skills
    });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      entry: { entry: { name: "installed-skill" } },
      snapshot: { version: "1.0.0", enabled: true }
    });
  });

  it("filters disabled snapshots as revocations without failing", async () => {
    const skills = await catalogWith({
      demo: skillDirectory("name: demo\ndescription: x")
    });
    const result = resolveInstalledAgentSkills({
      snapshots: [snapshotOf(skills[0]!, { enabled: false })],
      skills
    });
    expect(result.skills).toEqual([]);
  });

  it.each([
    {
      label: "an installed skill disappears from the managed root",
      code: "AGENT_SKILL_SNAPSHOT_UNRESOLVED"
    },
    {
      label: "content drifts from the pinned digest",
      code: "AGENT_SKILL_SNAPSHOT_DRIFT"
    }
  ])("fails closed when $label", async ({ code }) => {
    const skills = await catalogWith({
      demo: skillDirectory("name: demo\ndescription: x")
    });
    const snapshot =
      code === "AGENT_SKILL_SNAPSHOT_DRIFT"
        ? snapshotOf(skills[0]!, { digest: `sha256:${"b".repeat(64)}` })
        : snapshotOf(skills[0]!);
    const catalog =
      code === "AGENT_SKILL_SNAPSHOT_UNRESOLVED"
        ? await catalogWith({
            other: skillDirectory("name: other-skill\ndescription: x")
          })
        : skills;
    expect(() => resolveInstalledAgentSkills({ snapshots: [snapshot], skills: catalog })).toThrow(
      code
    );
  });

  it("rejects duplicate snapshots for one skill name", async () => {
    const skills = await catalogWith({
      demo: skillDirectory("name: demo\ndescription: x")
    });
    expect(() =>
      resolveInstalledAgentSkills({
        snapshots: [snapshotOf(skills[0]!), snapshotOf(skills[0]!)],
        skills
      })
    ).toThrow("AGENT_SKILL_SNAPSHOT_INVALID");
  });
});
