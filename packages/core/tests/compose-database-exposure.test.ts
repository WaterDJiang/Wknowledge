import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

describe("Compose database exposure", () => {
  it("requires an explicit password, keeps PostgreSQL internal, and makes host access dev-only", async () => {
    const [compose, developmentCompose, environmentExample] = await Promise.all([
      readFile(path.join(root, "docker-compose.yml"), "utf8"),
      readFile(path.join(root, "docker-compose.dev.yml"), "utf8"),
      readFile(path.join(root, ".env.example"), "utf8")
    ]);

    const postgresService = compose.match(/\n {2}postgres:\n([\s\S]*?)\n {2}migrate:/)?.[1];
    expect(postgresService).toBeDefined();
    expect(compose).toContain("${POSTGRES_PASSWORD:?POSTGRES_PASSWORD must be set}");
    expect(compose).not.toContain(":-wknowledge");
    expect(postgresService).not.toMatch(/^\s*ports:\s*$/m);
    expect(postgresService).not.toContain("5432:5432");
    expect(developmentCompose).toContain('"127.0.0.1:${WKNOWLEDGE_POSTGRES_HOST_PORT:-5432}:5432"');
    expect(environmentExample).not.toMatch(/^DATABASE_URL=postgres(?:ql)?:\/\//m);
    expect(environmentExample).not.toMatch(/^POSTGRES_PASSWORD=\S+/m);
  });
});
