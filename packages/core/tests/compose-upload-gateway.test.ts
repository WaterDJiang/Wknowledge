import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Compose upload gateway", () => {
  it("keeps Next internal and bounds direct multipart bodies at the public gateway", async () => {
    const [compose, gateway] = await Promise.all([
      readFile(path.join(root, "docker-compose.yml"), "utf8"),
      readFile(path.join(root, "deploy", "nginx", "wknowledge.conf"), "utf8")
    ]);
    const webService = compose.match(/\n {2}web:\n([\s\S]*?)\n {2}worker:/)?.[1];
    const gatewayService = compose.match(/\n {2}gateway:\n([\s\S]*?)\n {2}web:/)?.[1];

    expect(webService).toBeDefined();
    expect(gatewayService).toBeDefined();
    expect(webService).not.toMatch(/^\s*ports:\s*$/m);
    expect(gatewayService).toContain('"${WKNOWLEDGE_HTTP_HOST_PORT:-3000}:3000"');
    expect(gatewayService).toContain('user: "101:101"');
    expect(gatewayService).toContain("read_only: true");
    expect(gateway).toContain("client_max_body_size 9m;");
    expect(gateway).toContain("proxy_pass http://web:3000;");
    expect(gateway).toContain("map $http_x_forwarded_proto $wknowledge_client_scheme");
    expect(gateway).toContain("proxy_set_header X-Forwarded-Proto $wknowledge_client_scheme;");
  });
});
