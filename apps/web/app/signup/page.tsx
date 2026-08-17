"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export default function SignupPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function sendCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const response = await fetch("/api/auth/signup/send-code", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email })
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as { message?: string } | null;
      setError(value?.message ?? "验证码发送失败");
      setBusy(false);
      return;
    }
    setSent(true);
    setBusy(false);
  }

  async function completeSignup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/auth/signup/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        code: form.get("code"),
        name: form.get("name"),
        password: form.get("password")
      })
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => null)) as { message?: string } | null;
      setError(value?.message ?? "注册失败");
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
          <p className="eyebrow pale">OPEN TRIAL</p>
          <h1>
            用你的资料，
            <br />
            建立自己的知识库。
          </h1>
        </div>
        <p className="auth-note">邮箱验证 · 独立空间 · 随时开始</p>
      </section>
      <section className="auth-panel">
        {sent ? (
          <form className="auth-form" onSubmit={completeSignup}>
            <header>
              <p className="eyebrow">VERIFY EMAIL</p>
              <h2>完成注册</h2>
              <p>验证码已发送至 {email}，10 分钟内有效。</p>
            </header>
            <label>
              验证码
              <input
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                required
              />
            </label>
            <label>
              显示名称
              <input name="name" autoComplete="name" minLength={2} maxLength={80} required />
            </label>
            <label>
              设置密码
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                required
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="button button-primary full" disabled={busy}>
              {busy ? "正在创建…" : "创建试用空间 →"}
            </button>
          </form>
        ) : (
          <form className="auth-form" onSubmit={sendCode}>
            <header>
              <p className="eyebrow">START TRIAL</p>
              <h2>开始免费试用</h2>
              <p>验证邮箱后，我们会为你创建独立的个人知识空间。</p>
            </header>
            <label>
              邮箱
              <input
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="button button-primary full" disabled={busy}>
              {busy ? "发送中…" : "发送验证码 →"}
            </button>
            <p className="auth-note">
              已有账号？<Link href="/login">登录</Link>
            </p>
          </form>
        )}
      </section>
    </main>
  );
}
