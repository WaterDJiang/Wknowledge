import { expect, test } from "@playwright/test";

const hasDatabase = Boolean(process.env.DATABASE_URL);

test("landing page explains traceable knowledge workflow", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /让每个答案/ })).toBeVisible();
  await expect(page.getByText("简单的检索结构，严格的证据链。")).toBeVisible();
});

test("wiki pages API requires authentication", async ({ request }) => {
  const response = await request.get("/api/spaces/11111111-1111-4111-8111-111111111111/wiki/pages");
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("agent session APIs and workspace route require authentication", async ({ page, request }) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const bindingId = "22222222-2222-4222-8222-222222222222";
  for (const path of ["/api/agent-sessions", `/api/agent-sessions/${sessionId}`]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
  const contextOptions = await request.get(
    `/api/agent-sessions/${sessionId}/context-options?spaceId=33333333-3333-4333-8333-333333333333`
  );
  expect(contextOptions.status()).toBe(401);
  await expect(contextOptions.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const initialContextOptions = await request.get(
    "/api/agent-context-options?spaceId=33333333-3333-4333-8333-333333333333"
  );
  expect(initialContextOptions.status()).toBe(401);
  await expect(initialContextOptions.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  for (const requestPath of [
    "/api/agent-sessions",
    `/api/agent-sessions/${sessionId}/context-bindings`
  ]) {
    const response = await request.post(requestPath, { data: {} });
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
  const removeBinding = await request.delete(
    `/api/agent-sessions/${sessionId}/context-bindings/${bindingId}`
  );
  expect(removeBinding.status()).toBe(401);
  await expect(removeBinding.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const message = await request.post(`/api/agent-sessions/${sessionId}/messages`, {
    data: { message: "请总结这个知识空间" }
  });
  expect(message.status()).toBe(401);
  await expect(message.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const run = await request.post(`/api/agent-sessions/${sessionId}/runs`, {
    data: { message: "请总结这个知识空间" }
  });
  expect(run.status()).toBe(401);
  await expect(run.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const stop = await request.post(`/api/agent-runs/${sessionId}/stop`);
  expect(stop.status()).toBe(401);
  await expect(stop.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const replay = await request.get(`/api/agent-runs/${sessionId}/events`);
  expect(replay.status()).toBe(401);
  await expect(replay.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });

  await page.goto("/workspace/assistant");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
});

test("model budget settings API requires authentication", async ({ request }) => {
  const response = await request.get("/api/settings/model-budget");
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("audit export settings APIs require authentication", async ({ request }) => {
  for (const path of ["/api/settings/audit-export", "/api/settings/audit-export/status"]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
});

test("learning workbench routes redirect unauthenticated visitors to login", async ({ page }) => {
  for (const path of [
    "/workspace/learning",
    "/workspace/learning/content",
    "/workspace/learning/course",
    "/workspace/learning/practice",
    "/workspace/learning/reports",
    "/workspace/learning/assessments"
  ]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
  }
});

test("source locator APIs require authentication", async ({ request }) => {
  for (const path of [
    "/api/source-locators/resolve?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1",
    "/api/source-locators/content?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1",
    "/api/source-locators/media-transcript?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1",
    "/api/source-locators/keyframes?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1",
    "/api/source-locators/keyframes/keyframe-001?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1",
    "/api/source-locators/pdf-region?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1%26bbox%3D1%2C2%2C3%2C4",
    "/api/source-locators/pdf-region/page?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1%26bbox%3D1%2C2%2C3%2C4",
    "/api/source-locators/sheet-preview?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1",
    "/api/source-locators/slide-preview?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1",
    "/api/source-locators/image-preview?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1"
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
});

test("wiki review API requires authentication", async ({ request }) => {
  const response = await request.patch(
    "/api/spaces/11111111-1111-4111-8111-111111111111/wiki/pages/test-page/review",
    { data: { action: "approve" } }
  );
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("wiki change proposal APIs require authentication", async ({ request }) => {
  const base = "/api/spaces/11111111-1111-4111-8111-111111111111/wiki/pages/test-page/proposals";
  for (const requestPath of [base, `${base}/proposal-111111111111111111111111`]) {
    const response = await request.get(requestPath);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
  const response = await request.patch(`${base}/proposal-111111111111111111111111`, {
    data: { action: "accept" }
  });
  expect(response.status()).toBe(401);
  await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("wiki conflict APIs require authentication", async ({ request }) => {
  const base = "/api/spaces/11111111-1111-4111-8111-111111111111/wiki/conflicts";
  const read = await request.get(`${base}/conflict-111111111111111111111111`);
  expect(read.status()).toBe(401);
  await expect(read.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const create = await request.post(base, {
    data: { leftPageId: "left-page", rightPageId: "right-page" }
  });
  expect(create.status()).toBe(401);
  await expect(create.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const decide = await request.patch(`${base}/conflict-111111111111111111111111`, {
    data: { action: "keep_parallel" }
  });
  expect(decide.status()).toBe(401);
  await expect(decide.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("job retry API requires authentication", async ({ request }) => {
  for (const action of ["retry", "cancel", "resume"]) {
    const response = await request.post(`/api/jobs/11111111-1111-4111-8111-111111111111/${action}`);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
});

test("chunked upload APIs require authentication", async ({ request }) => {
  const session = await request.post("/api/spaces/11111111-1111-4111-8111-111111111111/uploads", {
    data: {
      name: "large.md",
      mimeType: "text/markdown",
      byteSize: 9 * 1024 * 1024,
      sha256: "a".repeat(64),
      compileProfile: "knowledge"
    }
  });
  expect(session.status()).toBe(401);
  await expect(session.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const status = await request.get("/api/uploads/11111111-1111-4111-8111-111111111111");
  expect(status.status()).toBe(401);
  await expect(status.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const part = await request.put("/api/uploads/11111111-1111-4111-8111-111111111111/parts/1", {
    data: "part"
  });
  expect(part.status()).toBe(401);
  await expect(part.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const complete = await request.post(
    "/api/uploads/11111111-1111-4111-8111-111111111111/complete",
    { data: { sha256: "a".repeat(64) } }
  );
  expect(complete.status()).toBe(401);
  await expect(complete.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("resource version APIs require authentication", async ({ request }) => {
  const resourceId = "11111111-1111-4111-8111-111111111111";
  const read = await request.get(`/api/resources/${resourceId}/versions`);
  expect(read.status()).toBe(401);
  await expect(read.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const replace = await request.post(`/api/resources/${resourceId}/versions`, { multipart: {} });
  expect(replace.status()).toBe(401);
  await expect(replace.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  const recompile = await request.post(`/api/resources/${resourceId}/recompile`, {
    data: { compileProfile: "knowledge" }
  });
  expect(recompile.status()).toBe(401);
  await expect(recompile.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("model, skill, run and queue settings APIs require authentication", async ({ request }) => {
  for (const path of [
    "/api/settings/model-providers",
    "/api/settings/skills",
    "/api/settings/query-runs",
    "/api/settings/queue-health",
    "/api/settings/operations-health",
    "/api/settings/blob-audit",
    "/api/settings/storage-usage"
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
  const redrive = await request.post("/api/settings/queue-health/redrive", { data: { limit: 25 } });
  expect(redrive.status()).toBe(401);
  await expect(redrive.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
});

test("agent Skill policy and approval APIs require authentication", async ({ request }) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const approvalId = "22222222-2222-4222-8222-222222222222";
  for (const path of [
    `/api/agent-sessions/${sessionId}/skills`,
    `/api/agent-sessions/${sessionId}/skill-approvals`,
    `/api/agent-approvals/${approvalId}/decision`
  ]) {
    const response = path.endsWith("/skills") ? await request.get(path) : await request.post(path);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
});

test("SkillRun APIs require authentication", async ({ request }) => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  for (const response of [
    await request.get(`/api/agent-sessions/${sessionId}/skill-runs`),
    await request.post(`/api/agent-sessions/${sessionId}/skill-runs`, { data: {} }),
    await request.get(`/api/skill-runs/${runId}`)
  ]) {
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
});

test("learning content and plan APIs require authentication", async ({ request }) => {
  const planId = "11111111-1111-4111-8111-111111111111";
  const responses = [
    await request.get("/api/learning/content-options"),
    await request.get("/api/learning/plan-candidates"),
    await request.get("/api/learning/practice-candidates"),
    await request.get("/api/learning/plans"),
    await request.get("/api/learning/active"),
    await request.get("/api/learning/course/active"),
    await request.get("/api/learning/practice"),
    await request.get("/api/learning/assessments"),
    await request.get("/api/learning/report/active"),
    await request.get("/api/learning/report/snapshots"),
    await request.get(`/api/learning/report/snapshots/${planId}`),
    await request.get(`/api/learning/report/snapshots/${planId}/artifacts/png`),
    await request.get("/api/learning/review/mistakes"),
    await request.get("/api/learning/reviews/free-response"),
    await request.post("/api/learning/plans", { data: {} }),
    await request.post(`/api/learning/plan-candidates/${planId}/materialize`, { data: {} }),
    await request.post(`/api/learning/practice-candidates/${planId}/materialize`, { data: {} }),
    await request.post(`/api/learning/practice-candidates/${planId}/materialize-assessment`, {
      data: {}
    }),
    await request.post("/api/learning/report/active/snapshots", { data: {} }),
    await request.post(`/api/learning/plans/${planId}/confirm`),
    await request.post("/api/learning/practice", { data: {} }),
    await request.post(`/api/learning/reviews/free-response/${planId}`, { data: {} }),
    await request.post("/api/learning/assessments", { data: {} }),
    await request.post(`/api/learning/assessments/${planId}/start`),
    await request.post(`/api/learning/assessments/${planId}/attempts`, { data: {} }),
    await request.post(`/api/learning/assessments/${planId}/submit`),
    await request.post("/api/learning/practice/11111111-1111-4111-8111-111111111111/attempts", {
      data: {}
    }),
    await request.post("/api/learning/events", { data: {} })
  ];
  for (const response of responses) {
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
});

test("learner profile APIs require authentication", async ({ request }) => {
  for (const response of [
    await request.get("/api/learners/me"),
    await request.put("/api/learners/me", { data: {} })
  ]) {
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
});

test("access management APIs require authentication", async ({ request }) => {
  for (const path of [
    "/api/settings/users",
    "/api/settings/invitations",
    "/api/spaces/11111111-1111-4111-8111-111111111111/members"
  ]) {
    const response = await request.get(path);
    expect(response.status()).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: "AUTH_REQUIRED" });
  }
  const accept = await request.post("/api/invitations/accept", {
    headers: { origin: "http://127.0.0.1:3000" },
    data: { token: "x".repeat(43), name: "邀请用户", password: "password-123" }
  });
  if (hasDatabase) {
    expect(accept.status()).toBe(409);
    await expect(accept.json()).resolves.toMatchObject({ code: "INVITATION_INVALID" });
  } else {
    expect(accept.status()).toBe(503);
    await expect(accept.json()).resolves.toMatchObject({ code: "REQUEST_GUARD_UNAVAILABLE" });
  }
});

test("public write APIs reject cross-site and missing-origin requests", async ({ request }) => {
  const payload = { token: "x".repeat(43), name: "邀请用户", password: "password-123" };
  const crossSite = await request.post("/api/invitations/accept", {
    headers: { origin: "https://untrusted.example" },
    data: payload
  });
  expect(crossSite.status()).toBe(403);
  await expect(crossSite.json()).resolves.toMatchObject({ code: "CSRF_ORIGIN_DENIED" });

  const missingOrigin = await request.post("/api/invitations/accept", { data: payload });
  expect(missingOrigin.status()).toBe(403);
  await expect(missingOrigin.json()).resolves.toMatchObject({ code: "CSRF_ORIGIN_REQUIRED" });
});

test("direct workspace feature routes enforce login instead of returning not found", async ({
  page
}) => {
  await page.goto("/workspace/wiki");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "登录工作台" })).toBeVisible();
  await page.goto("/workspace/settings");
  await expect(page).toHaveURL(/\/login$/);
  await page.goto(
    "/workspace/source?ref=wk%3A%2F%2Fsource%2F11111111-1111-4111-8111-111111111111%3Fpage%3D1"
  );
  await expect(page).toHaveURL(/\/login$/);
});
