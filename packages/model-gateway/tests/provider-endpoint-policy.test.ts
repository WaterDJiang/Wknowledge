import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  assertProviderEndpoint,
  pinnedProviderFetch,
  providerEndpointPolicyFromEnvironment
} from "../src/index";

describe("provider endpoint policy", () => {
  it("rejects unallowlisted local metadata endpoints before any request", async () => {
    await expect(
      assertProviderEndpoint(
        "http://169.254.169.254/latest/meta-data",
        "local",
        providerEndpointPolicyFromEnvironment({})
      )
    ).rejects.toThrow("MODEL_PROVIDER_ENDPOINT_DENIED");
  });

  it("rejects cloud endpoints without HTTPS or an explicit host allowlist", async () => {
    const policy = providerEndpointPolicyFromEnvironment({
      WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST: "models.example.test"
    });
    await expect(
      assertProviderEndpoint("http://models.example.test/v1", "cloud", policy)
    ).rejects.toThrow("MODEL_PROVIDER_ENDPOINT_DENIED");
    await expect(
      assertProviderEndpoint("https://other.example.test/v1", "cloud", policy)
    ).rejects.toThrow("MODEL_PROVIDER_ENDPOINT_DENIED");
  });

  it("rejects an allowlisted cloud hostname that resolves to a private address", async () => {
    const policy = providerEndpointPolicyFromEnvironment({
      WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST: "models.example.test"
    });
    await expect(
      assertProviderEndpoint("https://models.example.test/v1", "cloud", policy, async () => [
        { address: "169.254.169.254" }
      ])
    ).rejects.toThrow("MODEL_PROVIDER_ENDPOINT_DENIED");
  });

  it("rejects IPv4-mapped IPv6 DNS results for every denied IPv4 range", async () => {
    const policy = providerEndpointPolicyFromEnvironment({
      WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST: "models.example.test"
    });
    for (const address of [
      "::ffff:172.16.0.1",
      "::ffff:100.64.0.1",
      "::ffff:198.18.0.1",
      "::ffff:ac10:1",
      "0:0:0:0:0:ffff:6440:1",
      "::ffff:c612:1"
    ]) {
      await expect(
        assertProviderEndpoint("https://models.example.test/v1", "cloud", policy, async () => [
          { address }
        ])
      ).rejects.toThrow("MODEL_PROVIDER_ENDPOINT_DENIED");
    }
  });

  it("keeps an allowlisted cloud hostname with a public DNS result available", async () => {
    const policy = providerEndpointPolicyFromEnvironment({
      WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST: "models.example.test"
    });
    await expect(
      assertProviderEndpoint("https://models.example.test/v1", "cloud", policy, async () => [
        { address: "8.8.8.8" }
      ])
    ).resolves.toMatchObject({ hostname: "models.example.test" });
  });

  it("uses the validated address for the actual request instead of system DNS", async () => {
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ host: request.headers.host, method: request.method }));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TEST_SERVER_ADDRESS_MISSING");
    try {
      const response = await pinnedProviderFetch(
        `http://does-not-exist.example.test:${address.port}/models`,
        { headers: { "x-provider-test": "pinned" }, redirect: "error" },
        "127.0.0.1"
      );
      await expect(response.json()).resolves.toEqual({
        host: `does-not-exist.example.test:${address.port}`,
        method: "GET"
      });
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
