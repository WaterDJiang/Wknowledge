"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LEARNING_NAVIGATION = [
  { href: "/workspace/learning", label: "概览" },
  { href: "/workspace/learning/content", label: "内容与计划" },
  { href: "/workspace/learning/course", label: "课程原文" },
  { href: "/workspace/learning/practice", label: "练习与测评" },
  { href: "/workspace/learning/reports", label: "学习报告" }
];

export function LearningNavigation() {
  const pathname = usePathname();
  return (
    <nav className="learning-subnav" aria-label="学习功能">
      {LEARNING_NAVIGATION.map((item) => {
        const active = pathname === item.href;
        return (
          <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined}>
            {item.label}
          </Link>
        );
      })}
      <Link href="/workspace/learning/assessments">正式测评</Link>
    </nav>
  );
}
