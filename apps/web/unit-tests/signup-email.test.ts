import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignupCodeEmailSender } from "../lib/signup-email";

afterEach(() => vi.unstubAllGlobals());

describe("signup email delivery", () => {
  it("sends the verification code through Resend", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const sender = createSignupCodeEmailSender({
      WKNOWLEDGE_RESEND_API_KEY: "re_test",
      WKNOWLEDGE_EMAIL_FROM: "Wknowledge <noreply@example.com>"
    });

    await sender({ email: "learner@example.com", code: "123456" });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer re_test" })
      })
    );
  });

  it("fails closed without a sender or SMTP authentication", async () => {
    await expect(
      createSignupCodeEmailSender({})({ email: "learner@example.com", code: "123456" })
    ).rejects.toThrow("EMAIL_DELIVERY_NOT_CONFIGURED");
    await expect(
      createSignupCodeEmailSender({
        WKNOWLEDGE_SMTP_HOST: "smtp.example.com",
        WKNOWLEDGE_EMAIL_FROM: "Wknowledge <noreply@example.com>"
      })({ email: "learner@example.com", code: "123456" })
    ).rejects.toThrow("SMTP_AUTH_REQUIRED");
  });
});
