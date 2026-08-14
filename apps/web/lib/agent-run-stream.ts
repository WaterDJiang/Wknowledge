import type { AgentRunStreamEvent } from "@wknowledge/contracts";

type StreamController = {
  abort: AbortController;
  userId: string;
  startedAt: number;
};

const activeStreams = new Map<string, StreamController>();

export function registerAgentRunStream(runId: string, userId: string, startedAt: number) {
  const abort = new AbortController();
  activeStreams.set(runId, { abort, userId, startedAt });
  return abort;
}

export function stopActiveAgentRunStream(runId: string, userId: string): number | null {
  const stream = activeStreams.get(runId);
  if (!stream || stream.userId !== userId) return null;
  stream.abort.abort();
  return Date.now() - stream.startedAt;
}

export function clearAgentRunStream(runId: string): void {
  activeStreams.delete(runId);
}

export function sseEvent(event: AgentRunStreamEvent): Uint8Array {
  return new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
}
