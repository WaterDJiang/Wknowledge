import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Docker runtime dependency installation", () => {
  it("uses host DNS only while installing verified APT dependencies", async () => {
    const dockerfile = await readFile(path.join(root, "deploy", "Dockerfile"), "utf8");

    expect(dockerfile).toContain("RUN --network=host corepack enable");
    expect(dockerfile).toContain("RUN --network=host pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("http://mirrors.aliyun.com/debian");
    expect(dockerfile).toContain("apt-get -o Acquire::Retries=3 update");
    expect(dockerfile).toContain(
      "apt-get -o Acquire::Retries=3 install -y --no-install-recommends"
    );
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/*");
    expect(dockerfile).not.toContain("--allow-unauthenticated");
  });

  it("builds the shared runtime image with the required BuildKit entitlement", async () => {
    const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8");
    const deployScript = await readFile(path.join(root, "deploy", "alicloud", "deploy.sh"), "utf8");

    expect(deployScript).toContain("docker buildx build --allow network.host --load");
    expect(deployScript).not.toContain('"${compose[@]}" build');
    expect(compose).toContain('image: "wknowledge-app:${WKNOWLEDGE_RELEASE_VERSION:?');
  });

  it("keeps the deployment SSH connection alive during slow first builds", async () => {
    const workflow = await readFile(
      path.join(root, ".github", "workflows", "deploy-alicloud.yml"),
      "utf8"
    );

    expect(workflow).toContain("ServerAliveInterval=30");
    expect(workflow).toContain("ServerAliveCountMax=120");
  });
});
