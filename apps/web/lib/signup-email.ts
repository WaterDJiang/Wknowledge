import { connect as connectNet, type Socket } from "node:net";
import { connect as connectTls } from "node:tls";

type Environment = Record<string, string | undefined>;

export function createSignupCodeEmailSender(env: Environment = process.env) {
  return async ({ email, code }: { email: string; code: string }) => {
    const subject = "Wknowledge 注册验证码";
    const html = `<p>你的 Wknowledge 注册验证码是：</p><p style="font-size:32px;font-weight:700;letter-spacing:8px">${code}</p><p>验证码将在 10 分钟后失效。若非本人操作，请忽略此邮件。</p>`;
    if (env.WKNOWLEDGE_SMTP_HOST?.trim()) {
      await sendWithSmtp(env, { email, subject, html });
      return;
    }
    await sendWithResend(env, { email, subject, html });
  };
}

async function sendWithResend(
  env: Environment,
  input: { email: string; subject: string; html: string }
) {
  const apiKey = env.WKNOWLEDGE_RESEND_API_KEY?.trim();
  const from = env.WKNOWLEDGE_EMAIL_FROM?.trim();
  if (!apiKey || !from) throw new Error("EMAIL_DELIVERY_NOT_CONFIGURED");
  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [input.email], subject: input.subject, html: input.html })
    });
  } catch {
    throw new Error("EMAIL_DELIVERY_FAILED");
  }
  if (!response.ok) throw new Error("EMAIL_DELIVERY_FAILED");
}

async function sendWithSmtp(
  env: Environment,
  input: { email: string; subject: string; html: string }
) {
  const host = env.WKNOWLEDGE_SMTP_HOST?.trim();
  const from = env.WKNOWLEDGE_EMAIL_FROM?.trim();
  const username = env.WKNOWLEDGE_SMTP_USERNAME?.trim();
  const password = env.WKNOWLEDGE_SMTP_PASSWORD ?? "";
  if (!host || !from) throw new Error("EMAIL_DELIVERY_NOT_CONFIGURED");
  if (!username || !password.trim()) throw new Error("SMTP_AUTH_REQUIRED");
  const requestedPort = Number(env.WKNOWLEDGE_SMTP_PORT ?? "587");
  const port = Number.isInteger(requestedPort) && requestedPort > 0 ? requestedPort : 587;
  const client = await SmtpClient.connect({
    host,
    port,
    tlsInsecure: env.WKNOWLEDGE_SMTP_TLS_INSECURE === "true"
  });
  try {
    await client.ehlo();
    if (port !== 465) {
      if (!client.supportsStartTls) throw new Error("SMTP_STARTTLS_REQUIRED");
      await client.startTls();
      await client.ehlo();
    }
    await client.authPlain(username, password);
    await client.send({ from, to: input.email, subject: input.subject, html: input.html });
    await client.quit();
  } finally {
    client.close();
  }
}

class SmtpClient {
  supportsStartTls = false;
  #buffer = "";
  #pending:
    | { expected: number; resolve: (lines: string[]) => void; reject: (error: Error) => void }
    | undefined;

  private constructor(
    private socket: Socket,
    private readonly host: string,
    private readonly tlsInsecure: boolean
  ) {
    this.listen(socket);
  }

  static async connect(input: { host: string; port: number; tlsInsecure: boolean }) {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate =
        input.port === 465
          ? connectTls(
              {
                host: input.host,
                port: input.port,
                servername: input.host,
                rejectUnauthorized: !input.tlsInsecure
              },
              () => resolve(candidate)
            )
          : connectNet(input.port, input.host, () => resolve(candidate));
      candidate.setTimeout(30_000);
      candidate.once("error", reject);
      candidate.once("timeout", () => reject(new Error("SMTP_TIMEOUT")));
    });
    const client = new SmtpClient(socket, input.host, input.tlsInsecure);
    await client.expect(220);
    return client;
  }

  async ehlo() {
    const lines = await this.command("EHLO wknowledge.local", 250);
    this.supportsStartTls = lines.some((line) => /\bSTARTTLS\b/i.test(line));
  }

  async startTls() {
    await this.command("STARTTLS", 220);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const candidate = connectTls(
        { socket: this.socket, servername: this.host, rejectUnauthorized: !this.tlsInsecure },
        () => resolve(candidate)
      );
      candidate.once("error", reject);
    });
    this.socket = socket;
    this.listen(socket);
  }

  authPlain(username: string, password: string) {
    return this.command(
      `AUTH PLAIN ${Buffer.from(`\0${username}\0${password}`).toString("base64")}`,
      235
    );
  }

  async send(input: { from: string; to: string; subject: string; html: string }) {
    await this.command(`MAIL FROM:<${input.from}>`, 250);
    await this.command(`RCPT TO:<${input.to}>`, 250);
    await this.command("DATA", 354);
    const message = [
      `From: ${input.from}`,
      `To: ${input.to}`,
      `Subject: ${input.subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=UTF-8",
      "",
      input.html
    ].join("\r\n");
    await this.command(`${escapeSmtpData(message)}\r\n.`, 250);
  }

  quit() {
    return this.command("QUIT", 221);
  }

  close() {
    this.socket.destroy();
  }

  private listen(socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.#buffer += chunk;
      this.flush();
    });
    socket.on("error", (error) => {
      this.#pending?.reject(error);
      this.#pending = undefined;
    });
  }

  private command(value: string, expected: number) {
    this.socket.write(`${value}\r\n`);
    return this.expect(expected);
  }

  private expect(expected: number): Promise<string[]> {
    return new Promise((resolve, reject) => {
      this.#pending = { expected, resolve, reject };
      this.flush();
    });
  }

  private flush() {
    if (!this.#pending) return;
    const lines = this.#buffer.split("\r\n");
    if (lines.length < 2) return;
    const complete = lines.slice(0, -1);
    const last = complete.at(-1) ?? "";
    if (!/^\d{3} /.test(last)) return;
    this.#buffer = lines.at(-1) ?? "";
    const pending = this.#pending;
    this.#pending = undefined;
    if (!last.startsWith(String(pending.expected))) {
      pending.reject(new Error("SMTP_UNEXPECTED_RESPONSE"));
      return;
    }
    pending.resolve(complete);
  }
}

function escapeSmtpData(message: string): string {
  return message
    .replace(/\r?\n/g, "\r\n")
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}
