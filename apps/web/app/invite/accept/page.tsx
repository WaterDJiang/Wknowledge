"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";

function AcceptInvitationForm() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/invitations/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        name: form.get("name"),
        password: form.get("password") || undefined
      })
    });
    if (!response.ok) {
      const result = (await response.json().catch(() => null)) as { message?: string } | null;
      setError(result?.message ?? "接受邀请失败");
      setBusy(false);
      return;
    }
    setAccepted(true);
    setBusy(false);
  }

  return (
    <main className="auth-layout">
      <section className="auth-context">
        <Link className="wordmark inverse" href="/">
          Wknowledge
        </Link>
        <div>
          <p className="eyebrow pale">PRIVATE INVITATION</p>
          <h1>加入受管知识空间。</h1>
        </div>
        <p className="auth-note">邀请只使用一次，原始资料仍由所属空间管理。</p>
      </section>
      <section className="auth-panel">
        {accepted ? (
          <div className="auth-form">
            <header>
              <p className="eyebrow">INVITATION ACCEPTED</p>
              <h2>账号已加入</h2>
              <p>现在可以使用账号登录工作台。</p>
            </header>
            <Link className="button button-primary full" href="/login">
              前往登录 →
            </Link>
          </div>
        ) : (
          <form className="auth-form" onSubmit={accept}>
            <header>
              <p className="eyebrow">ACCEPT INVITATION</p>
              <h2>设置本地账号</h2>
              <p>如果邮箱已有账号，将保留既有密码。</p>
            </header>
            {!token ? <p className="form-error">邀请链接缺少验证信息。</p> : null}
            <label>
              显示名称
              <input name="name" autoComplete="name" required minLength={2} maxLength={80} />
            </label>
            <label>
              密码
              <input
                name="password"
                type="password"
                autoComplete="new-password"
                minLength={8}
                placeholder="已有账号可留空"
              />
            </label>
            {error ? <p className="form-error">{error}</p> : null}
            <button className="button button-primary full" disabled={!token || busy}>
              {busy ? "正在加入…" : "接受邀请 →"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}

export default function AcceptInvitationPage() {
  return (
    <Suspense
      fallback={
        <main className="auth-layout">
          <section className="auth-panel">正在读取邀请…</section>
        </main>
      }
    >
      <AcceptInvitationForm />
    </Suspense>
  );
}
