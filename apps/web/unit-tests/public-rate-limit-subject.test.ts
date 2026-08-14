import { describe, expect, it } from "vitest";
import { publicRateLimitSubject } from "../lib/request-security";

describe("public rate-limit network identity", () => {
  it("does not let client supplied forwarding headers alter the public subject", () => {
    const suffix = "learner@example.com";
    const directRequest = new Request("http://localhost/api/auth/login");
    const forgedRequest = new Request("http://localhost/api/auth/login", {
      headers: {
        "x-forwarded-for": "203.0.113.8",
        "x-real-ip": "198.51.100.7"
      }
    });
    expect(publicRateLimitSubject(directRequest, suffix)).toBe(
      publicRateLimitSubject(forgedRequest, suffix)
    );
  });

  it("keeps different public business subjects isolated", () => {
    const request = new Request("http://localhost/api/auth/login");
    expect(publicRateLimitSubject(request, "first@example.com")).not.toBe(
      publicRateLimitSubject(request, "second@example.com")
    );
  });
});
