import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { DataPolicy, ModelCapability } from "@wknowledge/contracts";

export interface EncryptedCredential {
  ciphertext: string;
  iv: string;
  tag: string;
}

function credentialKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.byteLength !== 32) throw new Error("CREDENTIAL_KEY_INVALID");
  return key;
}

export function encryptCredential(value: string, encodedKey: string): EncryptedCredential {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", credentialKey(encodedKey), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url")
  };
}

export function decryptCredential(credential: EncryptedCredential, encodedKey: string): string {
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      credentialKey(encodedKey),
      Buffer.from(credential.iv, "base64url")
    );
    decipher.setAuthTag(Buffer.from(credential.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(credential.ciphertext, "base64url")),
      decipher.final()
    ]).toString("utf8");
  } catch {
    throw new Error("CREDENTIAL_DECRYPT_FAILED");
  }
}

export interface ModelRequest {
  capability: ModelCapability;
  dataPolicy: DataPolicy;
  purpose:
    | "wiki_query"
    | "wiki_compile"
    | "agent"
    | "learning"
    | "speech_to_text"
    | "video_understanding"
    | "healthcheck";
  payload: unknown;
  signal?: AbortSignal;
}

export interface ModelResponse {
  providerId: string;
  model: string;
  output: unknown;
  durationMs: number;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelToolCallOutput {
  type: "tool_calls";
  toolCalls: ModelToolCall[];
}

export interface SpeechToTextSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface SpeechToTextOutput {
  text: string;
  segments: SpeechToTextSegment[] | null;
}

export interface OpenAICompatibleProviderConfig {
  id: string;
  baseUrl: string;
  model: string;
  location: "local" | "cloud";
  capabilities?: ModelCapability[];
  apiKey?: string;
  timeoutMs: number;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type PinnedProviderFetcher = (
  input: string | URL,
  init: RequestInit,
  address: string
) => Promise<Response>;

type ProviderLocation = "local" | "cloud";

export interface ProviderEndpointPolicy {
  localHostAllowlist: ReadonlySet<string>;
  cloudHostAllowlist: ReadonlySet<string>;
}

type EndpointLookup = (hostname: string) => Promise<Array<{ address: string }>>;

type ResolvedProviderEndpoint = {
  endpoint: URL;
  addresses: string[];
};

function normalizedHost(value: string): string {
  return value.replace(/^\[|\]$/g, "").toLowerCase();
}

function hostAllowlist(value: string | undefined, defaults: string[]): ReadonlySet<string> {
  const parsed = value
    ?.split(",")
    .map((item) => normalizedHost(item.trim()))
    .filter(Boolean);
  return new Set(parsed?.length ? parsed : defaults.map(normalizedHost));
}

export function providerEndpointPolicyFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): ProviderEndpointPolicy {
  return {
    localHostAllowlist: hostAllowlist(environment.WKNOWLEDGE_LOCAL_PROVIDER_HOST_ALLOWLIST, [
      "localhost",
      "127.0.0.1",
      "::1"
    ]),
    cloudHostAllowlist: hostAllowlist(environment.WKNOWLEDGE_CLOUD_PROVIDER_HOST_ALLOWLIST, [])
  };
}

function endpointUrl(baseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("MODEL_PROVIDER_ENDPOINT_DENIED");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("MODEL_PROVIDER_ENDPOINT_DENIED");
  return parsed;
}

function loopbackIp(value: string): boolean {
  const normalized = normalizedHost(value);
  return normalized === "::1" || normalized.startsWith("127.");
}

function mappedIpv4Address(value: string): string | null {
  if (isIP(value) !== 6) return null;
  const sections = normalizedHost(value).split("::");
  if (sections.length > 2) return null;
  const parseGroups = (section: string): string[] | null => {
    if (!section) return [];
    const groups = section.split(":");
    const lastGroup = groups.at(-1);
    if (!lastGroup?.includes(".")) return groups;
    const octets = lastGroup.split(".").map(Number);
    if (
      octets.length !== 4 ||
      octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
    )
      return null;
    return [
      ...groups.slice(0, -1),
      ((octets[0]! << 8) | octets[1]!).toString(16),
      ((octets[2]! << 8) | octets[3]!).toString(16)
    ];
  };
  const leading = parseGroups(sections[0] ?? "");
  const trailing = parseGroups(sections[1] ?? "");
  if (!leading || !trailing) return null;
  const missingGroups = 8 - leading.length - trailing.length;
  if (
    (sections.length === 1 && missingGroups !== 0) ||
    (sections.length === 2 && missingGroups < 1)
  )
    return null;
  const hextets = [...leading, ...Array<string>(missingGroups).fill("0"), ...trailing].map(
    (group) => (/^[0-9a-f]{1,4}$/i.test(group) ? Number.parseInt(group, 16) : Number.NaN)
  );
  if (hextets.length !== 8 || hextets.some((hextet) => !Number.isInteger(hextet))) return null;
  if (!hextets.slice(0, 5).every((hextet) => hextet === 0) || hextets[5] !== 0xffff) return null;
  return `${hextets[6]! >> 8}.${hextets[6]! & 0xff}.${hextets[7]! >> 8}.${hextets[7]! & 0xff}`;
}

function publicIp(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const octets = value.split(".").map(Number);
    const first = octets[0] ?? -1;
    const second = octets[1] ?? -1;
    return !(
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first >= 224 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 198 && (second === 18 || second === 19))
    );
  }
  if (family === 6) {
    const mappedIpv4 = mappedIpv4Address(value);
    if (mappedIpv4) return publicIp(mappedIpv4);
    const normalized = value.toLowerCase();
    return !(
      normalized === "::" ||
      normalized === "::1" ||
      normalized.startsWith("fe80:") ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("::ffff:127.") ||
      normalized.startsWith("::ffff:10.") ||
      normalized.startsWith("::ffff:192.168.") ||
      normalized.startsWith("::ffff:169.254.")
    );
  }
  return false;
}

export function validateProviderEndpoint(
  baseUrl: string,
  location: ProviderLocation,
  policy: ProviderEndpointPolicy = providerEndpointPolicyFromEnvironment()
): URL {
  const parsed = endpointUrl(baseUrl);
  const hostname = normalizedHost(parsed.hostname);
  if (location === "local") {
    if (!policy.localHostAllowlist.has(hostname) || (isIP(hostname) !== 0 && !loopbackIp(hostname)))
      throw new Error("MODEL_PROVIDER_ENDPOINT_DENIED");
    return parsed;
  }
  if (
    parsed.protocol !== "https:" ||
    isIP(hostname) !== 0 ||
    !policy.cloudHostAllowlist.has(hostname)
  )
    throw new Error("MODEL_PROVIDER_ENDPOINT_DENIED");
  return parsed;
}

export async function assertProviderEndpoint(
  baseUrl: string,
  location: ProviderLocation,
  policy: ProviderEndpointPolicy = providerEndpointPolicyFromEnvironment(),
  resolve: EndpointLookup = async (hostname) => lookup(hostname, { all: true, verbatim: true })
): Promise<URL> {
  return (await resolveProviderEndpoint(baseUrl, location, policy, resolve)).endpoint;
}

async function resolveProviderEndpoint(
  baseUrl: string,
  location: ProviderLocation,
  policy: ProviderEndpointPolicy,
  resolve: EndpointLookup
): Promise<ResolvedProviderEndpoint> {
  const parsed = validateProviderEndpoint(baseUrl, location, policy);
  if (location === "local") return { endpoint: parsed, addresses: [] };
  let addresses: Array<{ address: string }>;
  try {
    addresses = await resolve(normalizedHost(parsed.hostname));
  } catch {
    throw new Error("MODEL_PROVIDER_ENDPOINT_UNRESOLVABLE");
  }
  if (addresses.length === 0 || addresses.some(({ address }) => !publicIp(address)))
    throw new Error("MODEL_PROVIDER_ENDPOINT_DENIED");
  return { endpoint: parsed, addresses: addresses.map(({ address }) => address) };
}

export async function pinnedProviderFetch(
  input: string | URL,
  init: RequestInit,
  address: string
): Promise<Response> {
  const target = new URL(input.toString());
  const request = new Request(target, init);
  const headers = new Headers(request.headers);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : Buffer.from(await request.arrayBuffer());
  const requestForProtocol = target.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    let incoming: Readable | undefined;
    let abort: () => void = () => undefined;
    const cleanupAbort = () => request.signal.removeEventListener("abort", abort);
    const outgoing = requestForProtocol(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || undefined,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers: Object.fromEntries(headers.entries()),
        lookup: (_hostname, options, callback) => {
          const done = typeof options === "function" ? options : callback;
          if (!done) throw new Error("MODEL_PROVIDER_ENDPOINT_UNRESOLVABLE");
          const family = isIP(address);
          if (typeof options !== "function" && options.all) {
            (
              done as unknown as (
                error: Error | null,
                addresses: Array<{ address: string; family: number }>
              ) => void
            )(null, [{ address, family }]);
            return;
          }
          done(null, address, family);
        }
      },
      (response) => {
        incoming = response;
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value === undefined) continue;
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(name, item);
          } else {
            responseHeaders.set(name, String(value));
          }
        }
        response.once("close", cleanupAbort);
        resolve(
          new Response(Readable.toWeb(response) as unknown as BodyInit, {
            status: response.statusCode ?? 502,
            ...(response.statusMessage ? { statusText: response.statusMessage } : {}),
            headers: responseHeaders
          })
        );
      }
    );
    abort = () => {
      const error = new Error("MODEL_PROVIDER_CANCELLED");
      outgoing.destroy(error);
      incoming?.destroy(error);
    };
    if (request.signal.aborted) {
      abort();
      reject(new Error("MODEL_PROVIDER_CANCELLED"));
      return;
    }
    request.signal.addEventListener("abort", abort, { once: true });
    outgoing.once("error", (error) => {
      cleanupAbort();
      reject(error);
    });
    outgoing.end(body);
  });
}

function providerUrl(baseUrl: string, pathname: string): string {
  return `${baseUrl.replace(/\/$/, "")}${pathname}`;
}

function providerHeaders(apiKey?: string): HeadersInit {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
  };
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly location: "local" | "cloud";
  readonly capabilities: ReadonlySet<ModelCapability>;

  constructor(
    private readonly config: OpenAICompatibleProviderConfig,
    private readonly fetcher?: Fetcher,
    private readonly resolve: EndpointLookup = async (hostname) =>
      lookup(hostname, { all: true, verbatim: true }),
    private readonly pinnedFetcher: PinnedProviderFetcher = pinnedProviderFetch
  ) {
    validateProviderEndpoint(config.baseUrl, config.location);
    this.id = config.id;
    this.location = config.location;
    this.capabilities = new Set(config.capabilities ?? ["chat"]);
  }

  async healthcheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(this.config.timeoutMs, 5_000));
    try {
      const response = await this.request("/models", {
        headers: providerHeaders(this.config.apiKey),
        signal: controller.signal,
        redirect: "error"
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (!this.capabilities.has(request.capability)) throw new Error("MODEL_CAPABILITY_UNAVAILABLE");
    if (request.capability === "speech_to_text") return this.transcribe(request);
    if (request.capability !== "chat" && request.capability !== "vision")
      throw new Error("MODEL_CAPABILITY_UNAVAILABLE");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const stop = () => controller.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    const startedAt = Date.now();
    try {
      const payload = request.payload as Record<string, unknown>;
      if (request.signal?.aborted) throw new Error("MODEL_PROVIDER_CANCELLED");
      if (controller.signal.aborted) throw new Error("MODEL_PROVIDER_TIMEOUT");
      const response = await this.request("/chat/completions", {
        method: "POST",
        headers: providerHeaders(this.config.apiKey),
        body: JSON.stringify({
          model: this.config.model,
          ...payload,
          temperature: 0,
          ...(Array.isArray(payload.tools) ? {} : { response_format: { type: "json_object" } })
        }),
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) throw new Error("MODEL_PROVIDER_HTTP_ERROR");
      const body = (await response.json()) as {
        choices?: Array<{
          message?: {
            content?: unknown;
            tool_calls?: unknown;
          };
        }>;
      };
      const message = body.choices?.[0]?.message;
      const toolCalls = parseModelToolCalls(message?.tool_calls);
      const output = toolCalls ? { type: "tool_calls" as const, toolCalls } : message?.content;
      if (
        (toolCalls && toolCalls.length === 0) ||
        ((typeof output !== "string" || output.length === 0) && !toolCalls)
      )
        throw new Error("MODEL_PROVIDER_RESPONSE_INVALID");
      return {
        providerId: this.id,
        model: this.config.model,
        output,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      if (request.signal?.aborted) throw new Error("MODEL_PROVIDER_CANCELLED");
      if (controller.signal.aborted) throw new Error("MODEL_PROVIDER_TIMEOUT");
      if (error instanceof Error && error.message.startsWith("MODEL_")) throw error;
      throw new Error("MODEL_PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", stop);
    }
  }

  private async transcribe(request: ModelRequest): Promise<ModelResponse> {
    const payload = request.payload as {
      file: Blob;
      fileName: string;
      language?: string;
      prompt?: string;
    };
    if (!(payload.file instanceof Blob) || !safeMediaFileName(payload.fileName))
      throw new Error("MODEL_PROVIDER_REQUEST_INVALID");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const stop = () => controller.abort();
    request.signal?.addEventListener("abort", stop, { once: true });
    const startedAt = Date.now();
    try {
      const body = new FormData();
      body.set("model", this.config.model);
      body.set("file", payload.file, payload.fileName);
      body.set("response_format", "verbose_json");
      if (payload.language) body.set("language", payload.language);
      if (payload.prompt) body.set("prompt", payload.prompt);
      if (request.signal?.aborted) throw new Error("MODEL_PROVIDER_CANCELLED");
      if (controller.signal.aborted) throw new Error("MODEL_PROVIDER_TIMEOUT");
      const response = await this.request("/audio/transcriptions", {
        method: "POST",
        ...(this.config.apiKey
          ? { headers: { authorization: `Bearer ${this.config.apiKey}` } }
          : {}),
        body,
        signal: controller.signal,
        redirect: "error"
      });
      if (!response.ok) throw new Error("MODEL_PROVIDER_HTTP_ERROR");
      const bodyText = await response.text();
      const output = transcriptionOutput(bodyText, response.headers.get("content-type"));
      if (!output) throw new Error("MODEL_PROVIDER_RESPONSE_INVALID");
      return {
        providerId: this.id,
        model: this.config.model,
        output,
        durationMs: Date.now() - startedAt
      };
    } catch (error) {
      if (request.signal?.aborted) throw new Error("MODEL_PROVIDER_CANCELLED");
      if (controller.signal.aborted) throw new Error("MODEL_PROVIDER_TIMEOUT");
      if (error instanceof Error && error.message.startsWith("MODEL_")) throw error;
      throw new Error("MODEL_PROVIDER_UNAVAILABLE");
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", stop);
    }
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const endpoint = await resolveProviderEndpoint(
      this.config.baseUrl,
      this.config.location,
      providerEndpointPolicyFromEnvironment(),
      this.resolve
    );
    if (init.signal?.aborted) throw new Error("MODEL_PROVIDER_CANCELLED");
    const url = providerUrl(endpoint.endpoint.toString(), pathname);
    if (this.config.location === "cloud") {
      const address = endpoint.addresses[0];
      if (!address) throw new Error("MODEL_PROVIDER_ENDPOINT_UNRESOLVABLE");
      return this.pinnedFetcher(url, init, address);
    }
    return this.fetcher ? this.fetcher(url, init) : fetch(url, init);
  }
}

function parseModelToolCalls(value: unknown): ModelToolCall[] | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 0 || value.length > 2) return [];
  const calls: ModelToolCall[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return [];
    const call = candidate as { id?: unknown; type?: unknown; function?: unknown };
    if (typeof call.id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(call.id)) return [];
    if (call.type !== "function" || !call.function || typeof call.function !== "object") return [];
    const fn = call.function as { name?: unknown; arguments?: unknown };
    if (typeof fn.name !== "string" || typeof fn.arguments !== "string") return [];
    calls.push({ id: call.id, name: fn.name, arguments: fn.arguments });
  }
  return calls;
}

function safeMediaFileName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(value);
}

function transcriptionOutput(value: string, contentType: string | null): SpeechToTextOutput | null {
  if (contentType?.includes("application/json")) {
    try {
      const parsed = JSON.parse(value) as {
        text?: unknown;
        segments?: unknown;
      };
      if (typeof parsed.text !== "string" || !parsed.text.trim()) return null;
      const segments = parseTranscriptionSegments(parsed.segments);
      return { text: parsed.text.trim(), segments };
    } catch {
      return null;
    }
  }
  return value.trim() ? { text: value.trim(), segments: null } : null;
}

function parseTranscriptionSegments(value: unknown): SpeechToTextSegment[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 1_000) return null;
  const parsed: SpeechToTextSegment[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") return null;
    const segment = candidate as { start?: unknown; end?: unknown; text?: unknown };
    if (
      typeof segment.start !== "number" ||
      !Number.isFinite(segment.start) ||
      typeof segment.end !== "number" ||
      !Number.isFinite(segment.end) ||
      typeof segment.text !== "string" ||
      !segment.text.trim() ||
      segment.text.trim().length > 4_000
    )
      return null;
    const startMs = Math.round(segment.start * 1_000);
    const endMs = Math.round(segment.end * 1_000);
    if (startMs < 0 || endMs <= startMs) return null;
    parsed.push({ startMs, endMs, text: segment.text.trim() });
  }
  return parsed;
}

export function createChatGatewayFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
  fetcher?: Fetcher,
  options: ModelGatewayOptions = {}
): ModelGateway | null {
  const baseUrl = environment.WKNOWLEDGE_CHAT_BASE_URL;
  const model = environment.WKNOWLEDGE_CHAT_MODEL;
  if (!baseUrl || !model) return null;
  const location = environment.WKNOWLEDGE_CHAT_LOCATION === "cloud" ? "cloud" : "local";
  const parsedTimeout = Number(environment.WKNOWLEDGE_CHAT_TIMEOUT_MS ?? 20_000);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 20_000;
  const gateway = new ModelGateway(options);
  gateway.register(
    new OpenAICompatibleProvider(
      {
        id: environment.WKNOWLEDGE_CHAT_PROVIDER_ID ?? "openai-compatible",
        baseUrl,
        model,
        location,
        ...(environment.WKNOWLEDGE_CHAT_API_KEY
          ? { apiKey: environment.WKNOWLEDGE_CHAT_API_KEY }
          : {}),
        timeoutMs
      },
      fetcher
    )
  );
  return gateway;
}

export interface ModelProvider {
  id: string;
  location: "local" | "cloud";
  capabilities: ReadonlySet<ModelCapability>;
  invoke(request: ModelRequest): Promise<ModelResponse>;
  healthcheck(): Promise<boolean>;
}

export interface ModelInvocationGuardInput {
  providerId: string;
  capability: ModelCapability;
  purpose: ModelRequest["purpose"];
  dataPolicy: DataPolicy;
}

export type ModelInvocationGuard = (input: ModelInvocationGuardInput) => Promise<void>;

export interface ModelGatewayOptions {
  beforeInvoke?: ModelInvocationGuard;
}

export class ModelGateway {
  private readonly providers = new Map<string, ModelProvider>();

  constructor(private readonly options: ModelGatewayOptions = {}) {}

  register(provider: ModelProvider): void {
    if (this.providers.has(provider.id)) throw new Error("MODEL_PROVIDER_DUPLICATE");
    this.providers.set(provider.id, provider);
  }

  list(): Array<{ id: string; location: "local" | "cloud"; capabilities: ModelCapability[] }> {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      location: provider.location,
      capabilities: [...provider.capabilities]
    }));
  }

  async invoke(request: ModelRequest): Promise<ModelResponse> {
    if (request.purpose === "wiki_query" && request.capability === "embedding") {
      throw new Error("WIKI_EMBEDDING_FORBIDDEN");
    }
    const providers = [...this.providers.values()].filter(
      (candidate) =>
        candidate.capabilities.has(request.capability) &&
        (candidate.location === "local" || request.dataPolicy === "cloud_allowed")
    );
    let providerBudgetExceeded = false;
    for (const provider of providers) {
      if (await provider.healthcheck().catch(() => false)) {
        try {
          await this.options.beforeInvoke?.({
            providerId: provider.id,
            capability: request.capability,
            purpose: request.purpose,
            dataPolicy: request.dataPolicy
          });
        } catch (error) {
          if (error instanceof Error && error.message === "MODEL_PROVIDER_BUDGET_EXCEEDED") {
            providerBudgetExceeded = true;
            continue;
          }
          throw error;
        }
        return provider.invoke(request);
      }
    }
    if (providerBudgetExceeded) throw new Error("MODEL_PROVIDER_BUDGET_EXCEEDED");
    throw new Error("MODEL_CAPABILITY_UNAVAILABLE");
  }
}
