"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type FormEvent,
  type ReactNode,
  type SetStateAction
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

interface SpaceRow {
  space: { id: string; name: string; description: string };
  role: string;
}

interface CurrentUser {
  id: string;
  name: string;
  email: string;
}

interface WorkspaceContextValue {
  spaces: SpaceRow[];
  activeId: string;
  activeSpace: SpaceRow["space"] | null;
  activeRole: string;
  notice: string;
  setNotice: Dispatch<SetStateAction<string>>;
}

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

const NAV_ITEMS: Array<{ href: string; label: string; badge?: string }> = [
  { href: "/workspace/resources", label: "资料库" },
  { href: "/workspace/wiki", label: "知识库" },
  { href: "/workspace/query", label: "知识问答" },
  { href: "/workspace/assistant", label: "对话助手" },
  { href: "/workspace/learning", label: "学习计划" }
];

const PAGE_META: Record<string, { kicker: string; title: string }> = {
  "/workspace/resources": { kicker: "RESOURCE LIBRARY", title: "资料库" },
  "/workspace/wiki": { kicker: "MARKDOWN WIKI", title: "知识库" },
  "/workspace/query": { kicker: "GROUNDED QUERY", title: "知识问答" },
  "/workspace/assistant": { kicker: "AGENT WORKSPACE", title: "对话助手" },
  "/workspace/learning": { kicker: "LEARNING", title: "学习计划" },
  "/workspace/learning/content": { kicker: "LEARNING / CONTENT", title: "内容与计划" },
  "/workspace/learning/course": { kicker: "LEARNING / COURSE", title: "课程原文" },
  "/workspace/learning/practice": { kicker: "LEARNING / PRACTICE", title: "练习与测评" },
  "/workspace/learning/reports": { kicker: "LEARNING / REPORTS", title: "学习报告" },
  "/workspace/learning/assessments": { kicker: "FORMAL ASSESSMENT", title: "正式测评" },
  "/workspace/source": { kicker: "SOURCE PREVIEW", title: "原资料" },
  "/workspace/settings": { kicker: "SYSTEM CONTROL", title: "系统设置" }
};

export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext);
  if (!context) throw new Error("WORKSPACE_CONTEXT_MISSING");
  return context;
}

export function WorkspaceShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [spaces, setSpaces] = useState<SpaceRow[]>([]);
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [activeId, setActiveId] = useState("");
  const [notice, setNotice] = useState("正在读取空间…");

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      fetch("/api/spaces", { signal: controller.signal }),
      fetch("/api/auth/me", { signal: controller.signal })
    ])
      .then(async ([spacesResponse, userResponse]) => {
        if (spacesResponse.status === 401 || userResponse.status === 401) {
          router.replace("/login");
          return null;
        }
        if (!spacesResponse.ok || !userResponse.ok) throw new Error("WORKSPACE_BOOTSTRAP_FAILED");
        const [spaceData, userData] = await Promise.all([
          spacesResponse.json() as Promise<{ spaces: SpaceRow[] }>,
          userResponse.json() as Promise<{ user: CurrentUser }>
        ]);
        return { spaceData, userData };
      })
      .then((data) => {
        if (!data) return;
        setSpaces(data.spaceData.spaces);
        setUser(data.userData.user);
        setActiveId((current) => current || data.spaceData.spaces[0]?.space.id || "");
        setNotice(data.spaceData.spaces.length ? "系统就绪" : "创建第一个知识空间");
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        setNotice("知识空间读取失败");
      });
    return () => controller.abort();
  }, [router]);

  useEffect(() => {
    if (window.location.hash) window.history.replaceState(null, "", pathname);
  }, [pathname]);

  async function createSpace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: form.get("name"),
        description: "私有知识空间",
        dataPolicy: "local_only"
      })
    });
    if (!response.ok) {
      setNotice("空间创建失败");
      return;
    }
    const result = (await response.json()) as { space: SpaceRow["space"] };
    event.currentTarget.reset();
    setSpaces((current) => [...current, { space: result.space, role: "owner" }]);
    setActiveId(result.space.id);
    setNotice("空间已创建");
  }

  const activeMembership = spaces.find(({ space }) => space.id === activeId);
  const activeSpace = activeMembership?.space ?? null;
  const activeRole = activeMembership?.role ?? "";
  const pageMeta = PAGE_META[pathname] ?? { kicker: "WORKSPACE", title: "工作台" };

  return (
    <WorkspaceContext.Provider
      value={{ spaces, activeId, activeSpace, activeRole, notice, setNotice }}
    >
      <main className="workspace-shell">
        <aside className="sidebar">
          <Link className="wordmark inverse" href="/">
            Wknowledge
          </Link>
          <div className="side-group">
            <p>知识空间</p>
            {spaces.map(({ space }) => (
              <button
                key={space.id}
                className={activeId === space.id ? "space-link active" : "space-link"}
                onClick={() => setActiveId(space.id)}
              >
                <i />
                {space.name}
              </button>
            ))}
          </div>
          <form className="mini-create" onSubmit={createSpace}>
            <input name="name" placeholder="新空间名称" minLength={2} required />
            <button aria-label="创建空间">＋</button>
          </form>
          <nav className="side-nav" aria-label="工作台功能">
            {NAV_ITEMS.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  className={active ? "active" : ""}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                >
                  {item.label}
                  {item.badge ? <span>{item.badge}</span> : null}
                </Link>
              );
            })}
          </nav>
          <div className="sidebar-account">
            <div className="user-identity">
              <span className="user-avatar" aria-hidden="true">
                {(user?.name || user?.email || "W").slice(0, 1).toUpperCase()}
              </span>
              <span className="user-copy">
                <strong>{user?.name ?? "正在读取用户"}</strong>
                <small>{user?.email ?? ""}</small>
              </span>
            </div>
            <Link
              className={
                pathname === "/workspace/settings"
                  ? "settings-shortcut active"
                  : "settings-shortcut"
              }
              href="/workspace/settings"
              aria-label="系统设置"
              aria-current={pathname === "/workspace/settings" ? "page" : undefined}
              title="系统设置"
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M12 15.25A3.25 3.25 0 1 0 12 8.75a3.25 3.25 0 0 0 0 6.5Z" />
                <path d="M19.18 13.06c.04-.35.07-.7.07-1.06s-.03-.71-.07-1.06l2.04-1.59-2-3.46-2.51 1.01a7.73 7.73 0 0 0-1.84-1.06L14.5 3.16h-4l-.37 2.68A7.73 7.73 0 0 0 8.29 6.9L5.78 5.89l-2 3.46 2.04 1.59c-.04.35-.07.7-.07 1.06s.03.71.07 1.06l-2.04 1.59 2 3.46 2.51-1.01c.56.44 1.18.8 1.84 1.06l.37 2.68h4l.37-2.68a7.73 7.73 0 0 0 1.84-1.06l2.51 1.01 2-3.46-2.04-1.59Z" />
              </svg>
              <span>设置</span>
            </Link>
            <div className="deployment-state">
              <span>
                <i /> 私有部署
              </span>
              <small>Markdown-first / no vectors</small>
            </div>
          </div>
        </aside>

        <section className="workspace-main">
          <header className="workspace-head">
            <div>
              <p className="eyebrow">{pageMeta.kicker}</p>
              <h1>{pageMeta.title}</h1>
              <p className="workspace-context-name">{activeSpace?.name ?? "尚无知识空间"}</p>
            </div>
            <span className="notice">● {notice}</span>
          </header>
          <div className="workspace-page">{children}</div>
        </section>
      </main>
    </WorkspaceContext.Provider>
  );
}
