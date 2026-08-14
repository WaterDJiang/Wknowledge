import type { BlobStore } from "@wknowledge/blob-store";
import { parserOutputSchema, type ParserOutput } from "@wknowledge/contracts";
import type { ModelGateway, SpeechToTextOutput } from "@wknowledge/model-gateway";
import type { DataPolicy } from "@wknowledge/contracts";

const AUDIO_MIME_TYPES = new Set(["audio/mpeg", "audio/wav", "audio/mp4", "audio/x-m4a"]);
const MAX_AUDIO_SOURCE_BYTES = 25 * 1024 * 1024;

export interface AudioVersionForTranscription {
  id: string;
  mimeType: string;
  blobUri: string;
  originalName: string;
  byteSize: number;
}

function safeFileName(value: string): string {
  const extension = value.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] ?? ".audio";
  return `source${extension.toLowerCase()}`;
}

export async function transcribeAudioVersion(input: {
  version: AudioVersionForTranscription;
  mediaProbe: ParserOutput;
  blobStore: BlobStore;
  gateway: ModelGateway;
  dataPolicy: DataPolicy;
}): Promise<ParserOutput> {
  if (!AUDIO_MIME_TYPES.has(input.version.mimeType)) throw new Error("ASR_AUDIO_MIME_UNSUPPORTED");
  if (!Number.isSafeInteger(input.version.byteSize) || input.version.byteSize <= 0)
    throw new Error("ASR_SOURCE_SIZE_INVALID");
  if (input.version.byteSize > MAX_AUDIO_SOURCE_BYTES) throw new Error("ASR_SOURCE_SIZE_LIMIT");
  const mediaNode = input.mediaProbe.document.nodes.find(
    (node) => node.locator.type === "audio" && node.locator.resourceVersionId === input.version.id
  );
  if (!mediaNode || mediaNode.locator.type !== "audio") throw new Error("ASR_MEDIA_PROBE_REQUIRED");
  const bytes = await input.blobStore.read(input.version.blobUri);
  if (bytes.byteLength === 0) throw new Error("ASR_SOURCE_EMPTY");
  if (bytes.byteLength !== input.version.byteSize) throw new Error("ASR_SOURCE_SIZE_MISMATCH");
  const sourceBytes = new Uint8Array(
    bytes.buffer as ArrayBuffer,
    bytes.byteOffset,
    bytes.byteLength
  );
  const response = await input.gateway.invoke({
    capability: "speech_to_text",
    dataPolicy: input.dataPolicy,
    purpose: "speech_to_text",
    payload: {
      file: new Blob([sourceBytes], { type: input.version.mimeType }),
      fileName: safeFileName(input.version.originalName)
    }
  });
  const transcript = normalizeTranscriptOutput(response.output, mediaNode.locator.endMs);
  if (!transcript) throw new Error("ASR_TRANSCRIPT_INVALID");
  return parserOutputSchema.parse({
    document: {
      schemaVersion: 1,
      resourceVersionId: input.version.id,
      nodes: [
        ...input.mediaProbe.document.nodes,
        ...transcript.nodes.map((node, index) => ({
          schemaVersion: 1 as const,
          id: `transcript-${index + 1}`,
          kind: "transcript" as const,
          title: "音频转写",
          content: node.content,
          order: input.mediaProbe.document.nodes.length + index,
          locator: {
            type: "audio" as const,
            resourceVersionId: input.version.id,
            startMs: node.startMs,
            endMs: node.endMs
          },
          metadata: {
            providerId: response.providerId,
            model: response.model,
            durationMs: response.durationMs,
            segmentation: transcript.segmentation
          }
        }))
      ]
    },
    manifest: {
      schemaVersion: 1,
      parserId: "wknowledge-worker-asr",
      parserVersion: "1.0.0",
      runtime: "node",
      mimeType: input.version.mimeType,
      resourceVersionId: input.version.id,
      generatedAt: new Date().toISOString()
    }
  });
}

export function normalizeTranscriptOutput(
  value: unknown,
  mediaDurationMs: number
): {
  nodes: Array<{ startMs: number; endMs: number; content: string }>;
  segmentation: string;
} | null {
  if (typeof value === "string" && value.trim())
    return {
      nodes: [{ startMs: 0, endMs: mediaDurationMs, content: value.trim() }],
      segmentation: "whole_media_provider_without_timestamps"
    };
  if (!value || typeof value !== "object") return null;
  const output = value as SpeechToTextOutput;
  if (typeof output.text !== "string" || !output.text.trim()) return null;
  const segments = output.segments;
  if (
    !segments ||
    segments.some(
      (segment, index) =>
        segment.startMs < 0 ||
        segment.endMs <= segment.startMs ||
        segment.endMs > mediaDurationMs ||
        (index > 0 && segment.startMs < (segments[index - 1]?.endMs ?? 0))
    )
  )
    return {
      nodes: [{ startMs: 0, endMs: mediaDurationMs, content: output.text.trim() }],
      segmentation: "whole_media_provider_without_timestamps"
    };
  return {
    nodes: segments.map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      content: segment.text
    })),
    segmentation: "provider_segments"
  };
}
