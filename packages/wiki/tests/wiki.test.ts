import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  compileWiki,
  decideWikiConflict,
  declareWikiConflict,
  decideWikiPageProposal,
  getWikiConflict,
  getWikiPageChangeProposal,
  getWikiPage,
  initializeSpace,
  lintWikiDirectory,
  listWikiPageChangeProposals,
  listWikiConflicts,
  listWikiPageRevisions,
  listWikiPages,
  locatorRef,
  parseLocatorRef,
  queryWiki,
  queryWikiEvidence,
  recoverWikiPublicationArtifacts,
  recoverWikiPublicationArtifactsInDataRoot,
  reviewWikiPage,
  renderCompiledContent
} from "../src/index";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
);

describe("markdown wiki", () => {
  it("renders formal nodes without undefined headings", () => {
    const versionId = randomUUID();
    const content = renderCompiledContent([
      {
        schemaVersion: 1,
        id: "heading-1",
        kind: "heading",
        title: "章节",
        content: "章节",
        order: 0,
        locator: { type: "document", resourceVersionId: versionId, nodeId: "heading-1" },
        metadata: { level: 1 }
      },
      {
        schemaVersion: 1,
        id: "paragraph-1",
        kind: "paragraph",
        content: "段落正文",
        parentId: "heading-1",
        order: 1,
        locator: { type: "document", resourceVersionId: versionId, nodeId: "paragraph-1" },
        metadata: {}
      }
    ]);
    expect(content).toBe("# 章节\n\n段落正文\n");
    expect(content).not.toContain("undefined");
  });

  it("compiles idempotently, routes from index and preserves source location", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const locator = { type: "pdf" as const, resourceVersionId: versionId, page: 7 };
    const input = {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "学习科学.pdf",
      profile: "reference" as const,
      nodes: [
        {
          schemaVersion: 1 as const,
          id: "p7",
          kind: "paragraph" as const,
          title: "检索练习",
          content: "间隔检索有助于长期记忆。",
          order: 0,
          locator,
          metadata: { tags: ["学习"] }
        }
      ],
      compiledAt: new Date("2026-08-12T00:00:00.000Z")
    };
    await compileWiki(spaceRoot, input);
    await compileWiki(spaceRoot, input);
    await expect(
      readFile(path.join(spaceRoot, "wiki", "publish-manifest.json"), "utf8")
    ).resolves.toContain('"operation": "compile"');
    expect(await lintWikiDirectory(path.join(spaceRoot, "wiki"))).toEqual([]);
    const result = await queryWiki(spaceRoot, "怎样通过检索练习改善记忆？");
    expect(result.refused).toBe(false);
    expect(result.citations).toHaveLength(1);
    expect(parseLocatorRef(result.citations[0]!.sourceRefs[0]!)).toEqual(locator);
    expect(parseLocatorRef(locatorRef(locator))).toEqual(locator);
  });

  it("refuses unsupported answers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceRoot = await initializeSpace(root, randomUUID());
    expect((await queryWiki(spaceRoot, "量子力学")).refused).toBe(true);
  });

  it("builds a clean evidence bundle without embedding calls", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "学习科学.md",
      profile: "knowledge",
      nodes: [
        {
          schemaVersion: 1,
          id: "memory",
          kind: "paragraph",
          title: "检索练习",
          content: "间隔检索有助于长期记忆。",
          order: 0,
          locator: { type: "document", resourceVersionId: versionId, nodeId: "memory" },
          metadata: {}
        }
      ]
    });
    const separatedVersionId = randomUUID();
    await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: separatedVersionId,
      resourceName: "知识管理.md",
      profile: "knowledge",
      nodes: [
        {
          schemaVersion: 1,
          id: "separated",
          kind: "heading",
          title: "内容分域",
          content: "资料库管理原始文件，知识库管理知识页面。",
          order: 0,
          locator: {
            type: "document",
            resourceVersionId: separatedVersionId,
            nodeId: "separated"
          },
          metadata: { level: 1 }
        }
      ]
    });
    const partialVersionId = randomUUID();
    await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: partialVersionId,
      resourceName: "DeepSeek 指南.md",
      profile: "reference",
      nodes: [
        {
          schemaVersion: 1,
          id: "partial",
          kind: "paragraph",
          content: "如何使用个人知识库提升工作效率。",
          order: 0,
          locator: {
            type: "document",
            resourceVersionId: partialVersionId,
            nodeId: "partial"
          },
          metadata: {}
        }
      ]
    });

    const bundle = await queryWikiEvidence(spaceRoot, "怎样改善长期记忆？");
    expect(bundle.embeddingCalls).toBe(0);
    expect(bundle.items).toHaveLength(1);
    expect(bundle.items[0]).toMatchObject({ id: "evidence-01", pageType: "topic" });
    expect(bundle.items[0]?.text).toContain("间隔检索");
    expect(bundle.items[0]?.text).not.toContain("wk://");
    expect(bundle.items[0]?.text).not.toContain("> 来源：");
    const separated = await queryWikiEvidence(spaceRoot, "资料库和知识库如何分工？");
    expect(separated.items.map(({ pageTitle }) => pageTitle)).toEqual(["内容分域"]);
    expect((await queryWikiEvidence(spaceRoot, "薛定谔方程如何描述量子态？")).items).toEqual([]);
    expect((await queryWikiEvidence(spaceRoot, "量子力学")).items).toEqual([]);
    expect(
      (await queryWikiEvidence(spaceRoot, "What is tomorrow's weather in London?")).items
    ).toEqual([]);
  });

  it("compiles knowledge, case and reference profiles into distinct page types", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const versionId = randomUUID();
    const nodes = Array.from({ length: 18 }, (_, index) => ({
      schemaVersion: 1 as const,
      id: `page-${index + 1}`,
      kind: "paragraph" as const,
      title: `第 ${index + 1} 页`,
      content: `第 ${index + 1} 页的学习材料内容`,
      order: index,
      locator: { type: "pdf" as const, resourceVersionId: versionId, page: index + 1 },
      metadata: { pageNumber: index + 1 }
    }));

    const knowledgeInput = {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "学习手册.pdf",
      profile: "knowledge" as const,
      nodes,
      compiledAt: new Date("2026-08-12T00:00:00.000Z")
    };
    const knowledge = await compileWiki(spaceRoot, knowledgeInput);
    const repeatedKnowledge = await compileWiki(spaceRoot, knowledgeInput);
    expect(knowledge.pages.filter(({ type }) => type === "topic")).toHaveLength(3);
    expect(repeatedKnowledge.pages).toEqual(knowledge.pages);
    expect(await listWikiPages(spaceRoot, { types: ["topic"] })).toHaveLength(3);
    expect((await listWikiPages(spaceRoot, { types: ["topic"] }))[0]?.sourceCount).toBe(8);

    const caseVersionId = randomUUID();
    const caseResult = await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: caseVersionId,
      resourceName: "项目复盘.md",
      profile: "case",
      nodes: [
        {
          ...nodes[0]!,
          id: "case-source",
          order: 0,
          locator: { type: "document", resourceVersionId: caseVersionId, nodeId: "case-source" }
        }
      ]
    });
    expect(caseResult.pages).toMatchObject([{ type: "case" }]);

    const referenceVersionId = randomUUID();
    const referenceResult = await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: referenceVersionId,
      resourceName: "参考资料.txt",
      profile: "reference",
      nodes: [
        {
          ...nodes[0]!,
          id: "reference-source",
          order: 0,
          locator: {
            type: "document",
            resourceVersionId: referenceVersionId,
            nodeId: "reference-source"
          }
        }
      ]
    });
    expect(referenceResult.pages).toMatchObject([{ type: "material" }]);
  });

  it("splits a long heading section into stable, independently searchable topic pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const nodes = [
      {
        schemaVersion: 1 as const,
        id: "section-main",
        kind: "heading" as const,
        title: "学习策略",
        content: "学习策略",
        order: 0,
        locator: {
          type: "document" as const,
          resourceVersionId: versionId,
          nodeId: "section-main"
        },
        metadata: { level: 1 }
      },
      ...Array.from({ length: 17 }, (_, index) => ({
        schemaVersion: 1 as const,
        id: `strategy-${index + 1}`,
        kind: "paragraph" as const,
        content: `学习方法第 ${index + 1} 条：按计划完成练习并回顾反馈。`,
        order: index + 1,
        locator: {
          type: "document" as const,
          resourceVersionId: versionId,
          nodeId: `strategy-${index + 1}`
        },
        metadata: {}
      }))
    ];
    const input = {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "学习策略长文.md",
      profile: "knowledge" as const,
      nodes,
      compiledAt: new Date("2026-08-13T12:00:00.000Z")
    };

    const first = await compileWiki(spaceRoot, input);
    const second = await compileWiki(spaceRoot, input);
    const topics = first.pages.filter(({ type }) => type === "topic");
    expect(topics).toHaveLength(3);
    expect(second.pages).toEqual(first.pages);
    expect(topics.map(({ pageId }) => pageId)).toEqual([
      `topic-${versionId}-section-main`,
      `topic-${versionId}-section-main-part-02`,
      `topic-${versionId}-section-main-part-03`
    ]);
    const pages = await Promise.all(topics.map(({ pageId }) => getWikiPage(spaceRoot, pageId)));
    expect(pages.every((page) => page && page.sourceRefs.length <= 8)).toBe(true);
    expect((await queryWikiEvidence(spaceRoot, "学习方法")).items).toHaveLength(3);
  });

  it("lists, filters and reads published pages by stable id", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "学习科学.pdf",
      profile: "reference",
      nodes: [
        {
          schemaVersion: 1,
          id: "p7",
          kind: "paragraph",
          title: "检索练习",
          content: "间隔检索有助于长期记忆。",
          order: 0,
          locator: { type: "pdf", resourceVersionId: versionId, page: 7 },
          metadata: { tags: ["学习"] }
        }
      ],
      compiledAt: new Date("2026-08-12T00:00:00.000Z")
    });

    const all = await listWikiPages(spaceRoot);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      id: `material-${versionId}`,
      title: "学习科学.pdf",
      status: "draft",
      sourceCount: 1
    });
    expect(all[0]?.excerpt).toContain("间隔检索");
    expect(await listWikiPages(spaceRoot, { search: "长期记忆" })).toHaveLength(1);
    expect(await listWikiPages(spaceRoot, { search: "量子力学" })).toEqual([]);
    expect(await listWikiPages(spaceRoot, { status: "reviewed" })).toEqual([]);

    const page = await getWikiPage(spaceRoot, `material-${versionId}`);
    expect(page?.content).toContain("# 学习科学.pdf");
    expect(page?.sourceRefs).toHaveLength(1);
  });

  it("does not resolve unknown ids or path traversal as wiki pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceRoot = await initializeSpace(root, randomUUID());
    expect(await getWikiPage(spaceRoot, "missing-page")).toBeNull();
    expect(await getWikiPage(spaceRoot, "../KNOWLEDGE.md")).toBeNull();
    expect(await getWikiPage(spaceRoot, "/etc/passwd")).toBeNull();
  });

  it("locks human-reviewed pages against recompilation until they are reopened", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const reviewerId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const baseInput = {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "审核资料.md",
      profile: "reference" as const,
      nodes: [
        {
          schemaVersion: 1 as const,
          id: "review-source",
          kind: "paragraph" as const,
          content: "人工确认的第一版正文。",
          order: 0,
          locator: {
            type: "document" as const,
            resourceVersionId: versionId,
            nodeId: "review-source"
          },
          metadata: {}
        }
      ],
      compiledAt: new Date("2026-08-13T01:00:00.000Z")
    };
    const first = await compileWiki(spaceRoot, baseInput);
    const pageId = first.pages[0]!.pageId;

    const approved = await reviewWikiPage(spaceRoot, {
      pageId,
      action: "approve",
      reviewerId,
      reviewedAt: new Date("2026-08-13T02:00:00.000Z")
    });
    expect(approved).toMatchObject({
      id: pageId,
      status: "reviewed",
      humanVerified: true,
      reviewedBy: reviewerId,
      reviewedAt: "2026-08-13T02:00:00.000Z"
    });

    const protectedResult = await compileWiki(spaceRoot, {
      ...baseInput,
      nodes: [{ ...baseInput.nodes[0]!, content: "机器重新编译的第二版正文。" }],
      compiledAt: new Date("2026-08-13T03:00:00.000Z")
    });
    expect(protectedResult.reviewLockedPageIds).toEqual([pageId]);
    expect((await getWikiPage(spaceRoot, pageId))?.content).toContain("人工确认的第一版正文");
    expect((await getWikiPage(spaceRoot, pageId))?.content).not.toContain("机器重新编译");

    const reopened = await reviewWikiPage(spaceRoot, {
      pageId,
      action: "reopen",
      reviewerId,
      reviewedAt: new Date("2026-08-13T04:00:00.000Z")
    });
    expect(reopened).toMatchObject({ status: "draft", humanVerified: false });
    expect(reopened?.reviewedAt).toBeUndefined();
    expect(reopened?.reviewedBy).toBeUndefined();

    const recompiled = await compileWiki(spaceRoot, {
      ...baseInput,
      nodes: [{ ...baseInput.nodes[0]!, content: "重新打开后允许发布的第三版正文。" }],
      compiledAt: new Date("2026-08-13T05:00:00.000Z")
    });
    expect(recompiled.reviewLockedPageIds).toEqual([]);
    expect((await getWikiPage(spaceRoot, pageId))?.content).toContain("重新打开后允许发布");
  });

  it("stores an idempotent change proposal and snapshots when an approved page changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const reviewerId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const baseInput = {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "版本审核资料.md",
      profile: "reference" as const,
      nodes: [
        {
          schemaVersion: 1 as const,
          id: "version-source",
          kind: "paragraph" as const,
          content: "已审核的基础内容。",
          order: 0,
          locator: {
            type: "document" as const,
            resourceVersionId: versionId,
            nodeId: "version-source"
          },
          metadata: {}
        }
      ],
      compiledAt: new Date("2026-08-13T06:00:00.000Z")
    };
    const first = await compileWiki(spaceRoot, baseInput);
    const pageId = first.pages[0]!.pageId;
    await reviewWikiPage(spaceRoot, {
      pageId,
      action: "approve",
      reviewerId,
      reviewedAt: new Date("2026-08-13T06:01:00.000Z")
    });
    expect(await listWikiPageRevisions(spaceRoot, pageId)).toHaveLength(1);

    const changedInput = {
      ...baseInput,
      nodes: [{ ...baseInput.nodes[0]!, content: "候选版本增加了新的结论。" }],
      compiledAt: new Date("2026-08-13T06:02:00.000Z")
    };
    const protectedResult = await compileWiki(spaceRoot, changedInput);
    expect(protectedResult.reviewLockedPageIds).toEqual([pageId]);
    expect(protectedResult.changeProposals).toHaveLength(1);
    expect(protectedResult.changeProposals[0]).toMatchObject({ pageId, status: "pending" });
    expect((await getWikiPage(spaceRoot, pageId))?.content).toContain("已审核的基础内容");

    await compileWiki(spaceRoot, changedInput);
    const proposals = await listWikiPageChangeProposals(spaceRoot, pageId);
    expect(proposals).toHaveLength(1);
    const proposal = await getWikiPageChangeProposal(spaceRoot, pageId, proposals[0]!.id);
    expect(
      proposal?.diff.some((line) => line.type === "removed" && line.text.includes("基础内容"))
    ).toBe(true);
    expect(
      proposal?.diff.some((line) => line.type === "added" && line.text.includes("新的结论"))
    ).toBe(true);

    const accepted = await decideWikiPageProposal(spaceRoot, {
      pageId,
      proposalId: proposals[0]!.id,
      action: "accept",
      reviewerId,
      reviewedAt: new Date("2026-08-13T06:03:00.000Z")
    });
    expect(accepted.page).toMatchObject({ status: "reviewed", humanVerified: true });
    expect(accepted.page.content).toContain("候选版本增加了新的结论");
    expect(accepted.proposal.status).toBe("accepted");
    expect(await listWikiPageRevisions(spaceRoot, pageId)).toHaveLength(3);
  });

  it("rejects a change proposal without changing the published page", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const reviewerId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const input = {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "拒绝提案资料.md",
      profile: "reference" as const,
      nodes: [
        {
          schemaVersion: 1 as const,
          id: "reject-source",
          kind: "paragraph" as const,
          content: "已发布内容保持不变。",
          order: 0,
          locator: {
            type: "document" as const,
            resourceVersionId: versionId,
            nodeId: "reject-source"
          },
          metadata: {}
        }
      ]
    };
    const pageId = (await compileWiki(spaceRoot, input)).pages[0]!.pageId;
    await reviewWikiPage(spaceRoot, { pageId, action: "approve", reviewerId });
    await compileWiki(spaceRoot, {
      ...input,
      nodes: [{ ...input.nodes[0]!, content: "这段候选内容不应发布。" }]
    });
    const proposal = (await listWikiPageChangeProposals(spaceRoot, pageId))[0]!;
    const result = await decideWikiPageProposal(spaceRoot, {
      pageId,
      proposalId: proposal.id,
      action: "reject",
      reviewerId
    });
    expect(result.proposal.status).toBe("rejected");
    expect(result.page.content).toContain("已发布内容保持不变");
    expect(result.page.content).not.toContain("不应发布");
  });

  it("marks an old proposal stale instead of overwriting a newer reviewed page", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const reviewerId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const input = {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "过期提案资料.md",
      profile: "reference" as const,
      nodes: [
        {
          schemaVersion: 1 as const,
          id: "stale-source",
          kind: "paragraph" as const,
          content: "初始已审核内容。",
          order: 0,
          locator: {
            type: "document" as const,
            resourceVersionId: versionId,
            nodeId: "stale-source"
          },
          metadata: {}
        }
      ]
    };
    const pageId = (await compileWiki(spaceRoot, input)).pages[0]!.pageId;
    await reviewWikiPage(spaceRoot, { pageId, action: "approve", reviewerId });
    await compileWiki(spaceRoot, {
      ...input,
      nodes: [{ ...input.nodes[0]!, content: "旧候选内容。" }]
    });
    const proposal = (await listWikiPageChangeProposals(spaceRoot, pageId))[0]!;

    await reviewWikiPage(spaceRoot, { pageId, action: "reopen", reviewerId });
    await compileWiki(spaceRoot, {
      ...input,
      nodes: [{ ...input.nodes[0]!, content: "人工重新审核的新内容。" }]
    });
    await reviewWikiPage(spaceRoot, { pageId, action: "approve", reviewerId });

    await expect(
      decideWikiPageProposal(spaceRoot, {
        pageId,
        proposalId: proposal.id,
        action: "accept",
        reviewerId
      })
    ).rejects.toThrow("WIKI_PROPOSAL_BASE_STALE");
    expect((await getWikiPage(spaceRoot, pageId))?.content).toContain("人工重新审核的新内容");
    expect((await getWikiPageChangeProposal(spaceRoot, pageId, proposal.id))?.status).toBe("stale");
  });

  it("keeps conflicting source facts in parallel until an editor resolves them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const reviewerId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const leftVersionId = randomUUID();
    const rightVersionId = randomUUID();
    const leftPageId = (
      await compileWiki(spaceRoot, {
        spaceId,
        resourceVersionId: leftVersionId,
        resourceName: "结论 A.md",
        profile: "reference",
        nodes: [
          {
            schemaVersion: 1,
            id: "left-fact",
            kind: "paragraph",
            content: "检索练习应当每天完成一次。",
            order: 0,
            locator: { type: "document", resourceVersionId: leftVersionId, nodeId: "left-fact" },
            metadata: {}
          }
        ]
      })
    ).pages[0]!.pageId;
    const rightPageId = (
      await compileWiki(spaceRoot, {
        spaceId,
        resourceVersionId: rightVersionId,
        resourceName: "结论 B.md",
        profile: "reference",
        nodes: [
          {
            schemaVersion: 1,
            id: "right-fact",
            kind: "paragraph",
            content: "检索练习不应每天完成一次。",
            order: 0,
            locator: { type: "document", resourceVersionId: rightVersionId, nodeId: "right-fact" },
            metadata: {}
          }
        ]
      })
    ).pages[0]!.pageId;

    const conflict = await declareWikiConflict(spaceRoot, {
      leftPageId,
      rightPageId,
      actorUserId: reviewerId,
      createdAt: new Date("2026-08-13T08:00:00.000Z")
    });
    expect(conflict).toMatchObject({ status: "open", leftPageId, rightPageId });
    expect(conflict.left.sourceRefs).toHaveLength(1);
    expect((await getWikiPage(spaceRoot, leftPageId))?.status).toBe("conflicted");
    expect((await getWikiPage(spaceRoot, rightPageId))?.conflictIds).toContain(conflict.id);
    expect(
      (await queryWikiEvidence(spaceRoot, "检索练习每天完成"))?.items.every(
        (item) => item.conflicted
      )
    ).toBe(true);
    await expect(
      declareWikiConflict(spaceRoot, {
        leftPageId: rightPageId,
        rightPageId: leftPageId,
        actorUserId: reviewerId
      })
    ).rejects.toThrow("WIKI_CONFLICT_ALREADY_OPEN");

    const parallel = await decideWikiConflict(spaceRoot, {
      conflictId: conflict.id,
      action: "keep_parallel",
      actorUserId: reviewerId,
      decidedAt: new Date("2026-08-13T08:01:00.000Z")
    });
    expect(parallel.status).toBe("parallel");
    expect((await getWikiPage(spaceRoot, leftPageId))?.status).toBe("conflicted");
    expect(await listWikiConflicts(spaceRoot)).toHaveLength(1);
    expect((await getWikiConflict(spaceRoot, conflict.id))?.right.content).toContain("不应每天");
  });

  it("can select one conflicting fact and retires the other without losing the conflict snapshot", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const reviewerId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const makePage = async (name: string, content: string) => {
      const resourceVersionId = randomUUID();
      return (
        await compileWiki(spaceRoot, {
          spaceId,
          resourceVersionId,
          resourceName: name,
          profile: "reference",
          nodes: [
            {
              schemaVersion: 1,
              id: `node-${name === "左侧.md" ? "left" : "right"}`,
              kind: "paragraph",
              content,
              order: 0,
              locator: { type: "document", resourceVersionId, nodeId: "fact" },
              metadata: {}
            }
          ]
        })
      ).pages[0]!.pageId;
    };
    const leftPageId = await makePage("左侧.md", "左侧结论。");
    const rightPageId = await makePage("右侧.md", "右侧结论。");
    const conflict = await declareWikiConflict(spaceRoot, {
      leftPageId,
      rightPageId,
      actorUserId: reviewerId
    });
    const resolved = await decideWikiConflict(spaceRoot, {
      conflictId: conflict.id,
      action: "select_right",
      actorUserId: reviewerId
    });
    expect(resolved).toMatchObject({ status: "resolved", resolution: "select_right" });
    expect((await getWikiPage(spaceRoot, leftPageId))?.status).toBe("deprecated");
    expect((await getWikiPage(spaceRoot, rightPageId))?.status).toBe("reviewed");
    expect((await getWikiConflict(spaceRoot, conflict.id))?.left.content).toContain("左侧结论");
  });

  it("rejects invalid review state transitions and unknown pages", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceRoot = await initializeSpace(root, randomUUID());
    await expect(
      reviewWikiPage(spaceRoot, {
        pageId: "missing-page",
        action: "approve",
        reviewerId: randomUUID()
      })
    ).rejects.toThrow("WIKI_PAGE_NOT_FOUND");
  });

  it("restores an abandoned wiki backup and removes only stale publish artifacts", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceRoot = path.join(root, randomUUID());
    const backup = path.join(spaceRoot, ".wiki-backup-interrupted");
    const staleStaging = path.join(spaceRoot, ".wiki-staging-stale");
    const freshStaging = path.join(spaceRoot, ".wiki-staging-active");
    await mkdir(path.join(backup, "topics"), { recursive: true });
    await writeFile(path.join(backup, "index.md"), "# Recovered index\n");
    await writeFile(path.join(backup, "topics", "recovered.md"), "# Recovered page\n");
    await mkdir(staleStaging, { recursive: true });
    await mkdir(freshStaging, { recursive: true });
    const staleTime = new Date(Date.now() - 4 * 60 * 60 * 1_000);
    await utimes(backup, staleTime, staleTime);
    await utimes(staleStaging, staleTime, staleTime);

    const recovered = await recoverWikiPublicationArtifacts(spaceRoot);

    expect(recovered.restoredBackup).toBe(".wiki-backup-interrupted");
    expect(recovered.removedArtifacts).toContain(".wiki-staging-stale");
    await expect(readFile(path.join(spaceRoot, "wiki", "index.md"), "utf8")).resolves.toContain(
      "Recovered index"
    );
    await expect(stat(staleStaging)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(freshStaging)).isDirectory()).toBe(true);
  });

  it("recovers abandoned artifacts for managed spaces during worker startup without scanning others", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-root-"));
    roots.push(root);
    const spaceId = randomUUID();
    const spaceRoot = path.join(root, spaceId);
    const backup = path.join(spaceRoot, ".wiki-backup-startup");
    const unrelated = path.join(root, "not-a-managed-space", ".wiki-backup-untouched");
    await mkdir(path.join(backup, "topics"), { recursive: true });
    await writeFile(path.join(backup, "index.md"), "# Startup recovered index\n");
    await mkdir(unrelated, { recursive: true });
    const staleTime = new Date(Date.now() - 4 * 60 * 60 * 1_000);
    await utimes(backup, staleTime, staleTime);

    const recovered = await recoverWikiPublicationArtifactsInDataRoot(root);

    expect(recovered).toEqual([
      {
        spaceId,
        recovery: { restoredBackup: ".wiki-backup-startup", removedArtifacts: [] }
      }
    ]);
    await expect(readFile(path.join(spaceRoot, "wiki", "index.md"), "utf8")).resolves.toContain(
      "Startup recovered index"
    );
    expect((await stat(unrelated)).isDirectory()).toBe(true);
  });

  it("queries a multi-page PDF material without failing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const versionId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: versionId,
      resourceName: "DeepSeek 从零到精通.pdf",
      profile: "reference",
      nodes: Array.from({ length: 64 }, (_, index) => ({
        schemaVersion: 1 as const,
        id: `page-${index + 1}`,
        kind: "paragraph" as const,
        title: `第 ${index + 1} 页`,
        content: index === 5 ? "DeepSeek 是一个大语言模型相关工具。" : `第 ${index + 1} 页内容`,
        order: index,
        locator: { type: "pdf" as const, resourceVersionId: versionId, page: index + 1 },
        metadata: { pageNumber: index + 1 }
      }))
    });

    const result = await queryWiki(spaceRoot, "DeepSeek 是什么？");
    expect(result.refused).toBe(false);
    expect(result.citations[0]?.sourceRefs).toHaveLength(64);
    expect(result.answer).toContain("DeepSeek");
  });

  it("keeps internal locators and single-character matches out of query answers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wknowledge-wiki-"));
    roots.push(root);
    const spaceId = randomUUID();
    const spaceRoot = await initializeSpace(root, spaceId);
    const relevantVersionId = randomUUID();
    await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: relevantVersionId,
      resourceName: "DeepSeek 指南.pdf",
      profile: "reference",
      nodes: [
        {
          schemaVersion: 1,
          id: "page-1",
          kind: "paragraph",
          title: "模型介绍",
          content: "DeepSeek 是面向开发者的大语言模型工具。",
          order: 0,
          locator: { type: "pdf", resourceVersionId: relevantVersionId, page: 1 },
          metadata: { pageNumber: 1 }
        }
      ]
    });
    const unrelatedVersionId = randomUUID();
    await compileWiki(spaceRoot, {
      spaceId,
      resourceVersionId: unrelatedVersionId,
      resourceName: "古诗选集.pdf",
      profile: "reference",
      nodes: [
        {
          schemaVersion: 1,
          id: "page-1",
          kind: "paragraph",
          title: "诗歌",
          content: "这是一首与人工智能无关的诗歌。",
          order: 0,
          locator: { type: "pdf", resourceVersionId: unrelatedVersionId, page: 1 },
          metadata: { pageNumber: 1 }
        }
      ]
    });

    const result = await queryWiki(spaceRoot, "DeepSeek是什么？");
    expect(result.citations.map(({ title }) => title)).toEqual(["DeepSeek 指南.pdf"]);
    expect(result.answer).not.toContain("wk://");
    expect(result.answer).not.toContain("> 来源：");
  });
});
