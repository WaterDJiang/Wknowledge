import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileWiki, initializeSpace } from "@wknowledge/wiki";
import {
  createBoundKnowledgeComponent,
  runBoundKnowledgeAgent,
  type KnowledgeScopeRef
} from "../src/index";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

async function compiledSpace(input: {
  resourceName: string;
  nodeContent: string;
  nodeId?: string;
}): Promise<{ spaceId: string; spaceRoot: string; versionId: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "wknowledge-component-"));
  roots.push(root);
  const spaceId = randomUUID();
  const versionId = randomUUID();
  const nodeId = input.nodeId ?? input.resourceName;
  const spaceRoot = await initializeSpace(root, spaceId);
  await compileWiki(spaceRoot, {
    spaceId,
    resourceVersionId: versionId,
    resourceName: input.resourceName,
    profile: "knowledge",
    nodes: [
      {
        schemaVersion: 1,
        id: nodeId,
        kind: "paragraph",
        content: input.nodeContent,
        order: 0,
        locator: { type: "document", resourceVersionId: versionId, nodeId },
        metadata: {}
      }
    ]
  });
  return { spaceId, spaceRoot, versionId };
}

function componentWith(scopes: readonly KnowledgeScopeRef[], rootsBySpace: Map<string, string>) {
  const openSource = vi.fn(
    async (input: {
      scope: KnowledgeScopeRef;
      evidenceId: string;
      sourceIndex: number;
      sourceRef: string;
    }) => ({
      bindingId: input.scope.bindingId,
      spaceId: input.scope.spaceId,
      evidenceId: input.evidenceId,
      sourceIndex: input.sourceIndex,
      sourceRef: input.sourceRef
    })
  );
  const component = createBoundKnowledgeComponent({
    scopes,
    resolveSpaceRoot: async (scope) => {
      const root = rootsBySpace.get(scope.spaceId);
      if (root === undefined) throw new Error("SPACE_ROOT_UNRESOLVED");
      return root;
    },
    openSource
  });
  return { component, openSource };
}

describe("knowledge component equivalence with the existing bound agent", () => {
  it("produces the identical merged EvidenceBundle across bound spaces", async () => {
    const first = await compiledSpace({
      resourceName: "first",
      nodeContent: "间隔检索应在第一空间每天练习。"
    });
    const second = await compiledSpace({
      resourceName: "second",
      nodeContent: "间隔检索应在第二空间每周复盘。"
    });
    const rootsBySpace = new Map([
      [first.spaceId, first.spaceRoot],
      [second.spaceId, second.spaceRoot]
    ]);
    const contexts = [
      { bindingId: "binding-first", spaceId: first.spaceId, spaceRoot: first.spaceRoot },
      { bindingId: "binding-second", spaceId: second.spaceId, spaceRoot: second.spaceRoot }
    ];
    const run = await runBoundKnowledgeAgent(randomUUID(), contexts, "间隔检索");
    const { component } = componentWith(
      contexts.map(({ bindingId, spaceId }) => ({
        bindingId,
        kind: "space" as const,
        spaceId,
        label: `空间 ${bindingId}`
      })),
      rootsBySpace
    );
    const bundle = await component.search({ question: "间隔检索" });
    expect(bundle).toEqual(run.result.evidence);
    expect(bundle.items.length).toBeGreaterThan(0);
    expect(bundle.items.map(({ id }) => id).every((id) => id.includes("__"))).toBe(true);
    expect(bundle.embeddingCalls).toBe(0);
  });

  it("honors resource-version filters identically", async () => {
    const space = await compiledSpace({
      resourceName: "selected",
      nodeContent: "间隔检索应在选中资料中每天练习。",
      nodeId: "selected"
    });
    const root = space.spaceRoot.slice(0, space.spaceRoot.lastIndexOf("/"));
    const spaceRoot2 = space.spaceRoot;
    const excludedVersionId = randomUUID();
    await compileWiki(spaceRoot2, {
      spaceId: space.spaceId,
      resourceVersionId: excludedVersionId,
      resourceName: "excluded.md",
      profile: "knowledge",
      nodes: [
        {
          schemaVersion: 1,
          id: "excluded",
          kind: "paragraph",
          content: "间隔检索应在未选资料中每周练习。",
          order: 0,
          locator: { type: "document", resourceVersionId: excludedVersionId, nodeId: "excluded" },
          metadata: {}
        }
      ]
    });
    void root;
    const contexts = [
      {
        bindingId: "binding-version",
        spaceId: space.spaceId,
        spaceRoot: spaceRoot2,
        filter: { resourceVersionIds: [space.versionId] }
      }
    ];
    const run = await runBoundKnowledgeAgent(randomUUID(), contexts, "间隔检索");
    const { component } = componentWith(
      [
        {
          bindingId: "binding-version",
          kind: "resource-version",
          spaceId: space.spaceId,
          label: "固定资料版本",
          filter: { resourceVersionIds: [space.versionId] }
        }
      ],
      new Map([[space.spaceId, spaceRoot2]])
    );
    const bundle = await component.search({ question: "间隔检索" });
    expect(bundle).toEqual(run.result.evidence);
    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0]?.sourceRefs.join(" ")).toContain(space.versionId);
    expect(bundle.items[0]?.text).not.toContain("每周练习");
  });

  it("keeps the honest refusal identical when nothing matches", async () => {
    const space = await compiledSpace({
      resourceName: "quantum",
      nodeContent: "薛定谔方程描述量子态演化。"
    });
    const run = await runBoundKnowledgeAgent(
      randomUUID(),
      [{ bindingId: "binding", spaceId: space.spaceId, spaceRoot: space.spaceRoot }],
      "怎样做好红烧肉？"
    );
    const { component } = componentWith(
      [
        {
          bindingId: "binding",
          kind: "space",
          spaceId: space.spaceId,
          label: "量子空间"
        }
      ],
      new Map([[space.spaceId, space.spaceRoot]])
    );
    const bundle = await component.search({ question: "怎样做好红烧肉？" });
    expect(bundle).toEqual(run.result.evidence);
    expect(bundle.items).toEqual([]);
  });
});

describe("knowledge component read and source boundaries", () => {
  async function searchedComponent() {
    const space = await compiledSpace({
      resourceName: "memory",
      nodeContent: "间隔检索应每天练习。"
    });
    const { component, openSource } = componentWith(
      [
        {
          bindingId: "binding",
          kind: "space",
          spaceId: space.spaceId,
          label: "记忆空间"
        }
      ],
      new Map([[space.spaceId, space.spaceRoot]])
    );
    const bundle = await component.search({ question: "间隔检索" });
    return { component, openSource, bundle };
  }

  it("reads only excerpts of the current filtered bundle", async () => {
    const { component, bundle } = await searchedComponent();
    const id = bundle.items[0]!.id;
    const pages = await component.read({ evidenceIds: [id, "unknown-id"] });
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ evidenceId: id });
    expect(pages[0]!.content).toBe(bundle.items[0]!.text);
    expect(pages[0]!.content.length).toBeGreaterThan(0);
    expect(pages[0]!.sourceRefs.length).toBeGreaterThan(0);
    expect(pages[0]!.sourceRefs.every((ref) => ref.startsWith("wk://"))).toBe(true);
  });

  it("rejects reads before a search and malformed id lists", async () => {
    const { component, bundle } = await searchedComponent();
    const fresh = componentWith(
      [
        {
          bindingId: "binding-2",
          kind: "space",
          spaceId: "00000000-0000-4000-8000-000000000000",
          label: "空"
        }
      ],
      new Map()
    );
    await expect(fresh.component.read({ evidenceIds: ["evidence-01"] })).rejects.toThrow(
      "KNOWLEDGE_READ_BEFORE_SEARCH"
    );
    const id = bundle.items[0]!.id;
    await expect(
      component.read({ evidenceIds: Array.from({ length: 11 }, () => id) })
    ).rejects.toThrow("KNOWLEDGE_READ_INPUT_INVALID");
    await expect(component.read({ evidenceIds: [] })).rejects.toThrow(
      "KNOWLEDGE_READ_INPUT_INVALID"
    );
  });

  it("opens only sources that belong to evidence the caller received", async () => {
    const { component, openSource, bundle } = await searchedComponent();
    const item = bundle.items[0]!;
    const preview = await component.openSource({
      evidenceId: item.id,
      sourceIndex: 0
    });
    expect(preview.evidenceId).toBe(item.id);
    expect(preview.sourceRef).toBe(item.sourceRefs[0]);
    expect(preview.bindingId).toBe("binding");
    await expect(
      component.openSource({ evidenceId: item.id, sourceIndex: item.sourceRefs.length })
    ).rejects.toThrow("KNOWLEDGE_SOURCE_INDEX_INVALID");
    await expect(
      component.openSource({ evidenceId: "missing__evidence-01", sourceIndex: 0 })
    ).rejects.toThrow("KNOWLEDGE_SOURCE_NOT_IN_BUNDLE");
    expect(openSource).toHaveBeenCalledTimes(1);
  });

  it("lists scopes without leaking host paths", async () => {
    const { component } = await searchedComponent();
    const scopes = await component.listScopes();
    expect(scopes).toEqual([
      {
        bindingId: "binding",
        kind: "space",
        spaceId: expect.any(String),
        label: "记忆空间"
      }
    ]);
    expect(JSON.stringify(scopes)).not.toContain("spaceRoot");
    expect(JSON.stringify(scopes)).not.toContain(tmpdir());
  });
});

describe("knowledge component scope validation", () => {
  function scope(bindingId: string, label = "空间"): KnowledgeScopeRef {
    return {
      bindingId,
      kind: "space",
      spaceId: "00000000-0000-4000-8000-000000000001",
      label
    };
  }

  function withScopes(scopes: KnowledgeScopeRef[]) {
    return createBoundKnowledgeComponent({
      scopes,
      resolveSpaceRoot: async () => "/unused",
      openSource: async (input) => ({
        bindingId: input.scope.bindingId,
        spaceId: input.scope.spaceId,
        evidenceId: input.evidenceId,
        sourceIndex: input.sourceIndex,
        sourceRef: input.sourceRef
      })
    });
  }

  it.each([
    { label: "no scopes", scopes: [] },
    {
      label: "duplicate binding ids",
      scopes: [scope("binding"), scope("binding")]
    },
    { label: "a blank label", scopes: [scope("binding", " ")] }
  ])("rejects $label", ({ scopes }) => {
    expect(() => withScopes(scopes)).toThrow("AGENT_CONTEXT_INVALID");
  });

  it("rejects nine scopes", () => {
    expect(() => withScopes(Array.from({ length: 9 }, (_, i) => scope(`binding-${i}`)))).toThrow(
      "AGENT_CONTEXT_INVALID"
    );
  });
});
