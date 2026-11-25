export type Model = { id: string; name: string };

export type ResponseFormat =
  | "openai-sse"
  | "anthropic-sse"
  | "custom-sse"
  | "ndjson"
  | "json"
  | "websocket";

export type InputMode = "messages" | "prompt" | "gemini";

export type BodyFormat = "json" | "text" | "urlencoded" | "multipart";

export type CaptureTransport = "fetch" | "xhr" | "eventsource" | "websocket";

export type StudioMode = "local" | "global";

export type AdapterSchema = {
  messages: string[];
  model: string[];
  stream: string[] | null;
  thinking: string[] | null;
  deepSearch: string[] | null;
  inputMode?: InputMode;
  bodyFormat?: BodyFormat;
  responseFormat?: ResponseFormat;
  responseTextPath?: string[];
  queryParam?: string;
  /** Optional raw frame template when replaying plain-text WebSocket messages. */
  wsPlainText?: boolean;
};

export type Adapter = {
  id: string;
  name: string;
  siteUrl: string;
  endpoint: string;
  method?: "POST" | "GET" | "WS";
  origin: string;
  referer: string;
  enabled: boolean;
  source: "bundled" | "discovered" | "imported" | "captured";
  createdAt: string;
  verifiedAt: string | null;
  headers: Record<string, string>;
  requestTemplate: Record<string, unknown>;
  schema: AdapterSchema;
  models: Model[];
};

export type RequestLog = {
  id: string;
  at: string;
  adapterId: string;
  adapterName: string;
  model: string;
  status: number;
  durationMs: number;
  stream: boolean;
  error?: string;
};

export type StudioDB = {
  version: 1;
  settings: { localApiKey: string };
  adapters: Adapter[];
  logs: RequestLog[];
};

export type PublicAdapter = Omit<Adapter, "headers" | "requestTemplate"> & {
  headerNames: string[];
  hasCredentials: boolean;
};

export type CaptureEventKind =
  | "telemetry"
  | "secondary"
  | "probe_failed"
  | "verified";

export type CaptureErrorCode =
  | "auth_required"
  | "timeout"
  | "csp_blocked"
  | "not_found"
  | "rate_limited"
  | "blocked_host"
  | "websocket_info"
  | "unrecognized_response"
  | "network"
  | "telemetry"
  | "secondary";

export type CaptureEventPublic = {
  id: string;
  at: string;
  transport: CaptureTransport;
  method: string;
  endpoint: string;
  status?: number;
  kind: CaptureEventKind;
  errorCode?: CaptureErrorCode;
  message: string;
  actionTip?: string;
  detectedFormat?: ResponseFormat;
  latencyMs?: number;
};

export type CaptureAnalysis = {
  endpoint: string;
  method: "POST" | "GET" | "WS";
  transport: CaptureTransport;
  inputMode: InputMode;
  bodyFormat: BodyFormat;
  responseFormat: ResponseFormat;
  schemaFields: string[];
  models: Model[];
  headerNames: string[];
  hasCredentials: boolean;
  latencyMs: number;
  verified: boolean;
  responsePreview?: string;
};

export type CaptureSessionStatus = "listening" | "probing" | "completed" | "expired";

export type CaptureSessionPublic = {
  id: string;
  targetUrl: string;
  targetHost: string;
  reason: string;
  status: CaptureSessionStatus;
  mode?: StudioMode;
  createdAt: string;
  expiresAt: string;
  callbackUrl: string;
  consoleSnippet: string;
  bookmarklet: string;
  events: CaptureEventPublic[];
  adapter?: PublicAdapter;
  analysis?: CaptureAnalysis;
  lastMessage?: string;
  preDiscoveredModelsCount: number;
};

export const BUNDLED_RUSHER: Adapter = {
  id: "rusherai",
  name: "RusherAI",
  siteUrl: "https://rusherai.com/",
  endpoint: "https://allaitools-generate.freemodels.workers.dev/api/chat",
  method: "POST",
  origin: "https://rusherai.com",
  referer: "https://rusherai.com/",
  enabled: true,
  source: "bundled",
  createdAt: "2026-11-25T00:07:10.000Z",
  verifiedAt: "2026-11-25T00:07:10.000Z",
  headers: { "Content-Type": "application/json" },
  requestTemplate: {
    messages: [],
    modelId: "gpt-6-astra",
    thinking: false,
    deepSearch: false,
    stream: true,
  },
  schema: {
    messages: ["messages"],
    model: ["modelId"],
    stream: ["stream"],
    thinking: ["thinking"],
    deepSearch: ["deepSearch"],
    inputMode: "messages",
    bodyFormat: "json",
    responseFormat: "openai-sse",
  },
  models: [
    { id: "gpt-6-astra", name: "GPT 6 Astra" },
    { id: "claude-opus-5.5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5.5" },
    { id: "sol", name: "GPT 5.6 Sol" },
    { id: "terra", name: "GPT 5.6 Terra" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-fable-5.1", name: "Claude Fable 5.1" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "kimi-k3", name: "Kimi K3" },
  ],
};

export function publicAdapter(adapter: Adapter): PublicAdapter {
  const { headers, requestTemplate: _template, ...rest } = adapter;
  return {
    ...rest,
    headerNames: Object.keys(headers),
    hasCredentials: Object.keys(headers).some((k) =>
      /authorization|cookie|token|api[-_]?key|x-auth|session/i.test(k),
    ),
  };
}
