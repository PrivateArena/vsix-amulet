/**
 * The wire contract of the whole product.
 *
 * Three hops share these types: webview --(postMessage)--> extension host --(IPC)--> agent
 * worker. The worker is the only place that imports the Pi SDK, so nothing below this file
 * may reference SDK types: every value crossing a boundary is plain JSON.
 *
 * Framing between host and worker uses Node IPC messages (not stdout), so a stray `console.log`
 * from a dependency can never corrupt the stream. Command/response correlation is by `id`.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export interface ImageAttachment {
  type: "image";
  /** base64, no data-url prefix. */
  data: string;
  mimeType: string;
}

/* ------------------------------------------------------------------ transcript */

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; redacted?: boolean }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/** Serializable projection of the SDK's AgentMessage. */
export interface TranscriptMessage {
  id: string;
  role: "user" | "assistant" | "toolResult" | "system" | "bashExecution" | "custom";
  content: ContentBlock[];
  timestamp?: number;
  provider?: string;
  model?: string;
  responseModel?: string;
  thinkingLevel?: ThinkingLevel;
  stopReason?: string;
  errorMessage?: string;
  /** toolResult only */
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  usage?: Usage;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  totalTokens?: number;
  cost?: number;
}

/** Streaming deltas, mirroring the SDK's `assistantMessageEvent` names on the wire. */
export type AssistantStreamEvent =
  | { type: "start" }
  | { type: "text_start"; contentIndex: number }
  | { type: "text_delta"; contentIndex: number; delta: string }
  | { type: "text_end"; contentIndex: number; content: string }
  | { type: "thinking_start"; contentIndex: number }
  | { type: "thinking_delta"; contentIndex: number; delta: string }
  | { type: "thinking_end"; contentIndex: number; content: string }
  | { type: "tool_call_start"; contentIndex: number; id: string; toolName: string }
  | { type: "tool_call_delta"; contentIndex: number; delta: string }
  | { type: "tool_call_end"; contentIndex: number; toolCall: { id: string; name: string; arguments: Record<string, unknown> } }
  | { type: "done" }
  | { type: "error" };

export type WorkerEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; willRetry: boolean }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "turn_start" }
  | { type: "turn_end" }
  | { type: "message_start"; message: TranscriptMessage }
  | { type: "message_update"; assistantMessageEvent: AssistantStreamEvent }
  | { type: "message_end"; message: TranscriptMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError: boolean }
  | { type: "queue_update"; steering: string[]; followUp: string[] }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string; ok: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number }
  | { type: "session_info_changed"; name?: string }
  | { type: "thinking_level_changed"; level: ThinkingLevel }
  | { type: "extension_error"; extensionPath: string; event: string; error: string };

/* ------------------------------------------------------------------ state */

export interface ModelSummary {
  provider: string;
  id: string;
  name: string;
  contextWindow: number;
  maxTokens?: number;
  reasoning: boolean;
  /** True when credentials for this provider are present. */
  available: boolean;
}

export interface SessionState {
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  cwd: string;
  model?: ModelSummary;
  thinkingLevel: ThinkingLevel;
  isStreaming: boolean;
  isCompacting: boolean;
  isRetrying: boolean;
  messageCount: number;
  pendingMessageCount: number;
  contextUsage?: { tokens: number; contextWindow: number; percent: number };
  activeTools: string[];
}

export interface SessionListItem {
  path: string;
  id: string;
  name?: string;
  cwd: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

/* ------------------------------------------------------------------ commands */

export interface WorkerConfig {
  cwd: string;
  agentDir?: string;
  sessionDir?: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  autoCompact?: boolean;
  autoRetry?: boolean;
  /** Open this session file instead of continuing the most recent one. */
  sessionPath?: string;
  /** Continue the most recent session of the workspace on startup. */
  continueLast?: boolean;
}

export type WorkerCommand =
  | ({ id: string; type: "initialize" } & WorkerConfig)
  | { id: string; type: "prompt"; text: string; images?: ImageAttachment[]; streamingBehavior?: "steer" | "follow-up" }
  | { id: string; type: "steer"; text: string; images?: ImageAttachment[] }
  | { id: string; type: "followUp"; text: string; images?: ImageAttachment[] }
  | { id: string; type: "abort" }
  | { id: string; type: "clearQueue" }
  | { id: string; type: "getState" }
  | { id: string; type: "getMessages" }
  | { id: string; type: "listModels" }
  | { id: string; type: "setModel"; provider: string; modelId: string }
  | { id: string; type: "setThinkingLevel"; level: ThinkingLevel }
  | { id: string; type: "listSessions" }
  | { id: string; type: "newSession" }
  | { id: string; type: "switchSession"; sessionPath: string }
  | { id: string; type: "renameSession"; name: string }
  | { id: string; type: "compact"; instructions?: string }
  | { id: string; type: "setAutoCompact"; enabled: boolean }
  | { id: string; type: "setAutoRetry"; enabled: boolean }
  | { id: string; type: "shutdown" };

export type WorkerCommandType = WorkerCommand["type"];

export type WorkerResponse<T = unknown> =
  | { id: string; type: "response"; command: WorkerCommandType; ok: true; data?: T }
  | { id: string; type: "response"; command: WorkerCommandType; ok: false; error: string };

export const OK = <T>(id: string, command: WorkerCommandType, data?: T): WorkerResponse<T> => ({
  id,
  type: "response",
  command,
  ok: true,
  data,
});

export const FAIL = (id: string, command: WorkerCommandType, error: string): WorkerResponse<never> => ({
  id,
  type: "response",
  command,
  ok: false,
  error,
});

/* ------------------------------------------------------------------ extension UI */

/**
 * Requests raised by Pi extensions running inside the worker. Same method names as the
 * Pi RPC extension-ui protocol, so extension behaviour stays familiar; only the transport
 * differs (IPC instead of JSONL).
 */
export type ExtensionUiRequest =
  | { id: string; type: "extension_ui_request"; method: "notify"; message: string; notifyType?: "info" | "warning" | "error" }
  | { id: string; type: "extension_ui_request"; method: "setStatus"; statusKey: string; statusText?: string }
  | { id: string; type: "extension_ui_request"; method: "setWidget"; widgetKey: string; widgetLines?: string[]; widgetPlacement?: "aboveEditor" | "belowEditor" }
  | { id: string; type: "extension_ui_request"; method: "setTitle"; title: string }
  | { id: string; type: "extension_ui_request"; method: "input"; title: string; placeholder?: string }
  | { id: string; type: "extension_ui_request"; method: "select"; title: string; options: string[] }
  | { id: string; type: "extension_ui_request"; method: "confirm"; title: string; message: string }
  | { id: string; type: "extension_ui_request"; method: "editor"; title: string; prefill?: string };

/** `Omit` over a union collapses it to the common keys; this keeps every member distinct. */
export type ExtensionUiRequestBody = ExtensionUiRequest extends infer R
  ? R extends { id: string; type: "extension_ui_request" }
    ? Omit<R, "id" | "type">
    : never
  : never;

export type ExtensionUiResponse =
  | { id: string; type: "extension_ui_response"; value: string }
  | { id: string; type: "extension_ui_response"; confirmed: boolean }
  | { id: string; type: "extension_ui_response"; cancelled: true };

/* ------------------------------------------------------------------ worker uplink */

export type WorkerUplink =
  | WorkerResponse
  | { type: "event"; event: WorkerEvent }
  | { type: "state"; state: SessionState }
  | ExtensionUiRequest
  | { type: "ready"; state: SessionState }
  | { type: "log"; level: "info" | "warn" | "error"; text: string };

/* ------------------------------------------------------------------ host <-> webview */

export type WebviewRequest =
  | { type: "command"; name: WorkerCommandType; payload?: Record<string, unknown> }
  | { type: "ready" };

export type HostEvent =
  | { type: "event"; event: WorkerEvent }
  | { type: "state"; state: SessionState }
  | { type: "messages"; messages: TranscriptMessage[] }
  | { type: "models"; models: ModelSummary[] }
  | { type: "sessions"; sessions: SessionListItem[] }
  | { type: "workerStatus"; status: "starting" | "ready" | "restarting" | "stopped" | "failed"; detail?: string }
  | { type: "toast"; message: string; level: "info" | "warning" | "error" };
