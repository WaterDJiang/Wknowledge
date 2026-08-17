import { expect, test } from "@playwright/test";

test("signup verification fields start empty and remain readable on a narrow dark panel", async ({
  page
}) => {
  await page.route("**/api/auth/signup/send-code", async (route) => {
    await route.fulfill({ status: 200, contentType: "application/json", body: '{"ok":true}' });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/signup");
  await page.getByLabel("邮箱").fill("trial@example.com");
  await page.getByRole("button", { name: "发送验证码 →" }).click();

  const code = page.getByLabel("验证码");
  await expect(code).toBeVisible();
  await expect(code).toHaveValue("");
  await expect(code).not.toHaveValue("trial@example.com");
  await expect(page.getByLabel("显示名称")).toBeVisible();
  await expect(page.getByLabel("设置密码")).toBeVisible();
  await expect(page.locator(".auth-panel")).toHaveCSS("background-color", "rgb(21, 23, 36)");
  await expect(code).toHaveCSS("background-color", "rgb(247, 248, 255)");
  await expect(code).toHaveCSS("color", "rgb(21, 25, 42)");
});

test("password login routes directly into the workspace", async ({ page }) => {
  await page.route("**/api/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"user":{"id":"user-1","email":"trial@example.com","name":"试用用户"}}'
    });
  });
  await page.route("**/api/auth/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"user":{"id":"user-1","email":"trial@example.com","name":"试用用户"}}'
    });
  });
  await page.route("**/api/spaces", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: '{"spaces":[{"space":{"id":"space-1","name":"我的知识库","description":"个人试用知识空间"},"role":"owner"}]}'
    });
  });
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("trial@example.com");
  await page.getByLabel("密码").fill("trial-password");
  await page.getByRole("button", { name: "登录 →" }).click();

  await expect(page).toHaveURL(/\/workspace\/resources$/);
  await expect(page.getByRole("heading", { name: "资料库" })).toBeVisible();
});
