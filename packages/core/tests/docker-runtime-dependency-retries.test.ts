import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Docker runtime dependency installation", () => {
  it("uses host DNS only while installing verified APT dependencies", async () => {
    const dockerfile = await readFile(path.join(root, "deploy", "Dockerfile"), "utf8");

    expect(dockerfile).toContain("RUN --network=host npm install --global pnpm@10.29.3");
    expect(dockerfile).not.toContain("corepack");
    expect(dockerfile).toContain("RUN --network=host pnpm install --frozen-lockfile");
    expect(dockerfile).toContain("https://mirrors.aliyun.com/debian");
    expect(dockerfile).toContain("https://deb.debian.org/debian");
    expect(dockerfile).toContain("bootstrap_runtime_certificates() {");
    expect(dockerfile).toContain("install_runtime_dependencies() {");
    expect(dockerfile).toContain("if ! install_runtime_dependencies; then");
    expect(dockerfile).toContain("apt-get -o Acquire::Retries=3 update");
    expect(dockerfile).toContain(
      "apt-get -o Acquire::Retries=3 install -y --no-install-recommends"
    );
    expect(dockerfile).toContain("rm -rf /var/lib/apt/lists/*");
    expect(dockerfile).not.toContain("--allow-unauthenticated");
    expect(dockerfile).not.toContain("Acquire::https::Verify-Peer=false");
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

  it("prevents one-shot Compose containers from consuming the SSH deployment script", async () => {
    const deployScript = await readFile(path.join(root, "deploy", "alicloud", "deploy.sh"), "utf8");

    expect(deployScript).toContain(
      "run --rm --no-deps --entrypoint sh web -c 'mkdir -p /app/data/spaces /app/data/blobs' </dev/null"
    );
    expect(deployScript).toContain(
      '"${compose[@]}" --profile operations run --rm preflight </dev/null'
    );
    expect(deployScript).toContain('"${compose[@]}" up --detach --wait --remove-orphans');
    expect(deployScript).toContain('echo "DEPLOY_SUCCEEDED revision=$revision"');
  });

  it("keeps checkout content readable for the non-root runtime user", async () => {
    const dockerfile = await readFile(path.join(root, "deploy", "Dockerfile"), "utf8");
    const deployScript = await readFile(path.join(root, "deploy", "alicloud", "deploy.sh"), "utf8");

    expect(deployScript).toContain('chmod 600 "$runtime_env"\n\n# 保持运行时凭据');
    expect(deployScript).toContain('umask 022\n\nif [[ ! -d "$app_dir/.git" ]]');
    expect(deployScript).toContain('chmod 644 "$app_dir/deploy/nginx/wknowledge.conf"');
    expect(dockerfile).toContain("chown -R wknowledge:wknowledge /app");
  });
});
