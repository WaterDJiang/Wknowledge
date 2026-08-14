import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Wknowledge · 私有知识工作台",
  description: "可追溯的多模态知识与学习平台"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}
