import Link from "next/link";

const pipeline = [
  ["01", "原始资料", "文件不可变，版本与哈希留档"],
  ["02", "结构化解析", "正文、节点与精确位置分离"],
  ["03", "Wiki 编译", "Markdown 事实源，原子发布"],
  ["04", "有据回答", "先索引，再页面，最终回源"]
];

export default function Home() {
  return (
    <main className="landing-shell">
      <nav className="topbar">
        <Link className="wordmark" href="/">
          Wknowledge
        </Link>
        <div className="nav-actions">
          <span className="system-state">
            <i /> 本地优先
          </span>
          <Link className="button button-quiet" href="/login">
            登录
          </Link>
        </div>
      </nav>

      <section className="hero-grid">
        <div className="hero-copy">
          <p className="eyebrow">PRIVATE KNOWLEDGE ATELIER / 0.1</p>
          <h1>
            让每个答案，
            <br />
            都能回到原文。
          </h1>
          <p className="hero-lead">
            上传资料，编译为可阅读、可检索、可校正的 Markdown
            Wiki。知识正文留在你的系统里，引用精确到页码、时间点和单元格。
          </p>
          <div className="hero-actions">
            <Link className="button button-primary" href="/login">
              进入知识工作台 <span>↗</span>
            </Link>
            <a className="text-link" href="#method">
              查看工作方式 ↓
            </a>
          </div>
        </div>
        <aside className="index-card" aria-label="索引示例">
          <div className="index-head">
            <span>KNOWLEDGE INDEX</span>
            <span>42 pages</span>
          </div>
          <div className="index-query">
            怎样安排间隔学习？<kbd>⌘ ↵</kbd>
          </div>
          <div className="index-section">
            <p>ROUTED TO / LEARNING SCIENCE</p>
            <article className="result active">
              <b>间隔效应与检索练习</b>
              <span>概念 · 3 个来源</span>
            </article>
            <article className="result">
              <b>遗忘曲线的使用边界</b>
              <span>主题 · 2 个来源</span>
            </article>
          </div>
          <blockquote>
            “不要只重读；在即将遗忘时主动提取。”<cite>学习科学.pdf · 第 27 页</cite>
          </blockquote>
          <div className="locator-strip">
            <span>PDF</span>
            <code>p.27 / bbox 0.12, 0.31…</code>
            <button>打开原文 ↗</button>
          </div>
        </aside>
      </section>

      <section className="method" id="method">
        <header>
          <p className="eyebrow">THE METHOD</p>
          <h2>简单的检索结构，严格的证据链。</h2>
        </header>
        <div className="pipeline">
          {pipeline.map(([number, title, detail]) => (
            <article key={number}>
              <span>{number}</span>
              <h3>{title}</h3>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
