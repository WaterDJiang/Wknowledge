"use client";

import { WikiBrowser } from "../wiki-browser";
import { useWorkspace } from "../workspace-shell";

export default function WikiPage() {
  const { activeId, activeRole } = useWorkspace();
  return <WikiBrowser key={activeId || "empty-space"} spaceId={activeId} activeRole={activeRole} />;
}
