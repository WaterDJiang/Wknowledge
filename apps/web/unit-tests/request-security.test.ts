import { describe, expect, it } from "vitest";
import { requireSameOrigin } from "../lib/request-security";

describe("same-origin request guard", () => {
  it("accepts the external HTTPS origin forwarded by a trusted reverse proxy", () => {
    const request = new Request("http://web:3000/api/auth/login", {
      headers: {
        host: "knowledge.wattter.cn",
        origin: "https://knowledge.wattter.cn",
        "x-forwarded-proto": "https"
      }
    });

    expect(requireSameOrigin(request)).toBeNull();
  });

  it("keeps rejecting a different external origin behind the reverse proxy", () => {
    const request = new Request("http://web:3000/api/auth/login", {
      headers: {
        host: "knowledge.wattter.cn",
        origin: "https://untrusted.example",
        "x-forwarded-proto": "https"
      }
    });

    expect(requireSameOrigin(request)).not.toBeNull();
  });
});
