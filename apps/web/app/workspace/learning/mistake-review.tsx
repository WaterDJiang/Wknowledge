import Link from "next/link";
import type { PracticeMistakeReviewItem } from "@wknowledge/contracts";

export function PracticeMistakeReview({ items }: { items: PracticeMistakeReviewItem[] }) {
  return (
    <section className="learning-section practice-mistake-review">
      <header>
        <div>
          <p>07 / 错题回顾</p>
          <h3>从最近一次客观判定回到原文</h3>
          <small>只显示当前仍需回顾的基础题；再次答对后会从这里移除。</small>
        </div>
        <b>{items.length} 题待回顾</b>
      </header>
      {items.length ? (
        <div className="practice-mistake-list">
          {items.map((item, index) => (
            <article key={item.practiceAttemptId}>
              <header>
                <span>{String(index + 1).padStart(2, "0")} · 需要回顾</span>
                <small>
                  {item.grade.score}/{item.grade.maximumScore} · V{item.questionVersion}
                </small>
              </header>
              <p>{item.prompt}</p>
              <details>
                <summary>查看本次作答</summary>
                <p>{item.response}</p>
              </details>
              <div>
                <Link
                  href={`/workspace/source?ref=${encodeURIComponent(item.sourceRef)}`}
                  target="_blank"
                >
                  回到原文依据 ↗
                </Link>
                <Link href="/workspace/learning/practice#practice-candidates">重新作答 ↗</Link>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="empty">当前没有需要回顾的客观题。自由作答仍会在人工复核后单独处理。</p>
      )}
    </section>
  );
}
