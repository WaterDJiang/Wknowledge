"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") })
    });
    if (!response.ok) {
      const result = (await response.json()) as { message?: string };
      setError(result.message ?? "登录失败");
      setBusy(false);
      return;
    }
    router.push("/workspace");
  }

  return (
    <main className="auth-layout">
      <section className="auth-context">
        <Link className="wordmark inverse" href="/">
          Wknowledge
        </Link>
        <div>
          <p className="eyebrow pale">PRIVATE DEPLOYMENT</p>
          <h1>
            知识属于你。
            <br />
            证据也属于你。
          </h1>
        </div>
        <p className="auth-note">本地账号 · HttpOnly 会话 · 空间级权限</p>
      </section>
      <section className="auth-panel">
        <form className="auth-form" onSubmit={submit}>
          <header>
            <p className="eyebrow">WELCOME BACK</p>
            <h2>登录工作台</h2>
            <p>使用管理员创建的账号继续。</p>
          </header>
          <label>
            邮箱
            <input
              name="email"
              type="email"
              autoComplete="email"
              placeholder="name@company.com"
              required
            />
          </label>
          <label>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              minLength={8}
              required
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button className="button button-primary full" disabled={busy}>
            {busy ? "验证中…" : "登录 →"}
          </button>
          <p className="auth-note">
            还没有账号？<Link href="/signup">开始免费试用</Link>
          </p>
        </form>
      </section>
    </main>
  );
}
