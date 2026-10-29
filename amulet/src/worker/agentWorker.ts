/**
 * The agent worker: the only module in the product that imports the Pi SDK.
 *
 * It owns one Pi session for one workspace folder, translates SDK events into the
 * `WorkerEvent` envelope, and translates host commands into SDK calls. It runs in its own
 * Node process so that a provider crash, an OOM, or a bad extension cannot take the editor
 * down — the host restarts it and reopens the same session file.
 */
import { createAgentSession, SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import type {
  AssistantStreamEvent,
  ExtensionUiRequest,
  ExtensionUiRequestBody,
  ExtensionUiResponse,
  SessionListItem,
  SessionState,
  TranscriptMessage,
  WorkerCommand,
  WorkerConfig,
  WorkerEvent,
  WorkerUplink,
} from "../shared/protocol.js";
import { FAIL, OK } from "../shared/protocol.js";

/** Loose view of an SDK session event; the union is wide and version-sensitive. */
type AnyEvent = { type: string; [key: string]: any };

/** SDK messages carry no `type` discriminator, so they get their own loose shape. */
type LooseRecord = Record<string, any>;

export interface WorkerHost {
  send(message: WorkerUplink): void;
}

export class AgentWorker {
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private config!: WorkerConfig;
  private modelCache = new Map<string, unknown>();
  private pendingDialogs = new Map<string, (response: ExtensionUiResponse) => void>();
  private messageSeq = 0;
  /** Guards against a second prompt while the first is still being prepared. */
  private starting = false;

  constructor(private readonly host: WorkerHost) {}

  /* ------------------------------------------------------------ lifecycle */

  async initialize(config: WorkerConfig): Promise<SessionState> {
    this.config = config;
    await this.openSession(config);
    return this.snapshot();
  }

  private async openSession(config: WorkerConfig): Promise<void> {
    if (this.starting) throw new Error("The session is already starting.");
    this.starting = true;
    try {
      await this.teardown();
      const sessionDir = config.sessionDir || undefined;
      const manager = config.sessionPath
        ? SessionManager.open(config.sessionPath, sessionDir)
        : config.continueLast === false
          ? SessionManager.create(config.cwd, sessionDir)
          : SessionManager.continueRecent(config.cwd, sessionDir);

      const { session } = await createAgentSession({
        cwd: config.cwd,
        agentDir: config.agentDir || undefined,
        sessionManager: manager,
        thinkingLevel: config.thinkingLevel,
      });
      this.session = session;

      // Extensions get a UI: dialogs are forwarded to the editor. `mode: "rpc"` is what the
      // Pi RPC integration uses, so extensions behave the same way here.
      await session.bindExtensions({ uiContext: this.extensionUi() as unknown as Parameters<AgentSession["bindExtensions"]>[0]["uiContext"], mode: "rpc" });

      if (config.model) {
        const model = this.resolveModel(config.model);
        if (model) await session.setModel(model as never);
        else this.host.send({ type: "log", level: "warn", text: `Unknown model "${config.model}"; kept the Pi default.` });
      }
      session.setAutoCompactionEnabled(config.autoCompact ?? true);
      session.setAutoRetryEnabled(config.autoRetry ?? true);

      this.unsubscribe = session.subscribe(event => this.forward(event as unknown as AnyEvent));
    } finally {
      this.starting = false;
    }
  }

  private async teardown(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    const current = this.session;
    this.session = undefined;
    if (!current) return;
    try {
      await current.abort();
    } catch {
      /* already idle */
    }
    current.dispose();
  }

  private get active(): AgentSession {
    if (!this.session) throw new Error("No session is open yet.");
    return this.session;
  }

  /* ------------------------------------------------------------ state */

  snapshot(): SessionState {
    const session = this.session;
    if (!session) throw new Error("No session is open yet.");
    const model = session.model;
    const usage = session.getContextUsage();
    return {
      sessionId: session.sessionId,
      sessionFile: session.sessionFile,
      sessionName: session.sessionName,
      cwd: this.config.cwd,
      model: model ? this.summarize(model as never) : undefined,
      thinkingLevel: session.thinkingLevel ?? "medium",
      isStreaming: session.isStreaming,
      isCompacting: session.isCompacting,
      isRetrying: session.isRetrying,
      messageCount: session.messages.length,
      pendingMessageCount: session.pendingMessageCount,
      contextUsage: usage
        ? { tokens: usage.tokens ?? 0, contextWindow: usage.contextWindow, percent: usage.percent ?? 0 }
        : undefined,
      activeTools: session.getActiveToolNames(),
    };
  }

  private summarize(model: { provider?: unknown; id?: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean }) {
    return {
      provider: String(model.provider ?? ""),
      id: String(model.id ?? ""),
      name: String(model.name ?? model.id ?? ""),
      contextWindow: Number(model.contextWindow ?? 0),
      maxTokens: model.maxTokens === undefined ? undefined : Number(model.maxTokens),
      reasoning: Boolean(model.reasoning),
      available: this.session?.modelRuntime.hasConfiguredAuth(String(model.provider ?? "")) ?? false,
    };
  }

  private resolveModel(qualified: string): unknown {
    const runtime = this.active.modelRuntime as unknown as { getModel(provider: string, id: string): unknown };
    const [provider, ...rest] = qualified.split("/");
    const modelId = rest.join("/");
    if (!provider || !modelId) throw new Error(`Model must be "provider/modelId", got "${qualified}"`);
    const cached = this.modelCache.get(qualified);
    if (cached) return cached;
    const model = runtime.getModel(provider, modelId);
    if (model) this.modelCache.set(qualified, model);
    return model;
  }

  /* ------------------------------------------------------------ events */

  private forward(event: AnyEvent): void {
    const mapped = this.mapEvent(event);
    if (mapped) this.host.send({ type: "event", event: mapped });
    // Header state (model, name, queues) changes outside the event list the UI already sees,
    // so push an authoritative snapshot whenever one of those fields can move.
    if (STATEFUL_EVENTS.has(event.type) && this.session) this.host.send({ type: "state", state: this.snapshot() });
  }

  private mapEvent(event: AnyEvent): WorkerEvent | undefined {
    switch (event.type) {
      case "agent_start":
        return { type: "agent_start" };
      case "agent_end":
        return { type: "agent_end", willRetry: Boolean(event.willRetry) };
      case "agent_settled":
        return { type: "agent_settled", aborted: Boolean(event.aborted) };
      case "turn_start":
        return { type: "turn_start" };
      case "turn_end":
        return { type: "turn_end" };
      case "message_start":
        return { type: "message_start", message: projectMessage(event.message) };
      case "message_end":
        return { type: "message_end", message: projectMessage(event.message) };
      case "message_update":
        return { type: "message_update", assistantMessageEvent: mapStreamEvent(event.assistantMessageEvent) };
      case "tool_execution_start":
        return { type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName, args: event.args };
      case "tool_execution_update":
        return {
          type: "tool_execution_update",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          partialResult: event.partialResult,
        };
      case "tool_execution_end":
        return {
          type: "tool_execution_end",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: Boolean(event.isError),
        };
      case "queue_update":
        return { type: "queue_update", steering: [...(event.steering ?? [])], followUp: [...(event.followUp ?? [])] };
      case "compaction_start":
        return { type: "compaction_start", reason: String(event.reason ?? "manual") };
      case "compaction_end":
        return {
          type: "compaction_end",
          reason: String(event.reason ?? "manual"),
          ok: !event.errorMessage && !event.aborted,
          errorMessage: event.errorMessage,
        };
      case "auto_retry_start":
        return {
          type: "auto_retry_start",
          attempt: Number(event.attempt ?? 1),
          maxAttempts: Number(event.maxAttempts ?? 1),
          delayMs: Number(event.delayMs ?? 0),
          errorMessage: String(event.errorMessage ?? ""),
        };
      case "auto_retry_end":
        return { type: "auto_retry_end", success: Boolean(event.success), attempt: Number(event.attempt ?? 0) };
      case "session_info_changed":
        return { type: "session_info_changed", name: event.name };
      case "thinking_level_changed":
        return { type: "thinking_level_changed", level: event.level };
      case "extension_error":
        return {
          type: "extension_error",
          extensionPath: String(event.extensionPath ?? ""),
          event: String(event.event ?? ""),
          error: String(event.error?.message ?? event.error ?? "unknown error"),
        };
      default:
        return undefined;
    }
  }

  /* ------------------------------------------------------------ extension UI */

  private extensionUi() {
    const dialog = <T>(request: ExtensionUiRequestBody, parse: (response: ExtensionUiResponse) => T) =>
      new Promise<T>(resolve => {
        const id = randomUUID();
        this.pendingDialogs.set(id, response => {
          this.pendingDialogs.delete(id);
          resolve(parse(response));
        });
        this.host.send({ ...request, id, type: "extension_ui_request" } as ExtensionUiRequest);
      });

    return {
      select: (title: string, options: string[]) =>
        dialog({ method: "select", title, options }, r => ("value" in r ? r.value : undefined)),
      input: (title: string, placeholder?: string) =>
        dialog({ method: "input", title, placeholder }, r => ("value" in r ? r.value : undefined)),
      editor: (title: string, prefill?: string) =>
        dialog({ method: "editor", title, prefill }, r => ("value" in r ? r.value : undefined)),
      confirm: (title: string, message: string) =>
        dialog({ method: "confirm", title, message }, r => ("confirmed" in r ? r.confirmed : false)),
      notify: (message: string, type?: "info" | "warning" | "error") => {
        this.host.send({ id: randomUUID(), type: "extension_ui_request", method: "notify", message, notifyType: type } as ExtensionUiRequest);
      },
      setStatus: (key: string, text?: string) => {
        this.host.send({ id: randomUUID(), type: "extension_ui_request", method: "setStatus", statusKey: key, statusText: text } as ExtensionUiRequest);
      },
      setWidget: (key: string, content?: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => {
        const lines = Array.isArray(content) ? (content as string[]) : undefined;
        this.host.send({
          id: randomUUID(),
          type: "extension_ui_request",
          method: "setWidget",
          widgetKey: key,
          widgetLines: lines,
          widgetPlacement: options?.placement,
        } as ExtensionUiRequest);
      },
      setTitle: (title: string) => {
        this.host.send({ id: randomUUID(), type: "extension_ui_request", method: "setTitle", title } as ExtensionUiRequest);
      },
      // Everything below is terminal-only or interactive-TUI-only in RPC-like hosts: present so
      // extensions do not crash, deliberately without effect.
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      custom: async <T,>() => undefined as T,
      pasteToEditor: () => {},
      setEditorText: () => {},
      getEditorText: () => "",
      setEditorTextHighlight: () => {},
      addAutocompleteProvider: () => () => {},
      getEditorTheme: () => undefined as never,
      getTheme: () => undefined as never,
      getAllThemes: () => [],
      setTheme: () => "Theme selection is not supported in the editor host.",
      getToolsExpanded: () => false,
      setToolsExpanded: () => {},
    };
  }

  resolveDialog(response: ExtensionUiResponse): void {
    this.pendingDialogs.get(response.id)?.(response);
  }

  /* ------------------------------------------------------------ commands */

  async handle(command: WorkerCommand): Promise<void> {
    const { id, type } = command;
    try {
      switch (type) {
        case "initialize":
          return void this.host.send(OK(id, type, await this.initialize(command)));
        case "prompt": {
          const streamingBehavior = command.streamingBehavior === "steer" ? "steer"
            : command.streamingBehavior === "follow-up" ? "followUp" : undefined;
          // Resolves when the run finishes; the webview is driven by events, not by this await.
          void this.active
            .prompt(command.text, { images: command.images as never, streamingBehavior })
            .catch(error => this.host.send({ type: "log", level: "error", text: errorMessage(error) }));
          return void this.host.send(OK(id, type, { state: this.snapshot() }));
        }
        case "steer":
          return void this.host.send(OK(id, type, { disposition: await this.active.steer(command.text, command.images as never) }));
        case "followUp":
          return void this.host.send(OK(id, type, { disposition: await this.active.followUp(command.text, command.images as never) }));
        case "abort":
          await this.active.abort();
          return void this.host.send(OK(id, type, { state: this.snapshot() }));
        case "clearQueue": {
          const cleared = this.active.clearQueue();
          return void this.host.send(OK(id, type, cleared));
        }
        case "getState":
          return void this.host.send(OK(id, type, this.snapshot()));
        case "getMessages":
          return void this.host.send(OK(id, type, this.active.messages.map(projectMessage)));
        case "listModels": {
          const runtime = this.active.modelRuntime as unknown as { getModels(): readonly unknown[] };
          const models = runtime.getModels().map(model => this.summarize(model as never));
          return void this.host.send(OK(id, type, models));
        }
        case "setModel": {
          const model = this.resolveModel(`${command.provider}/${command.modelId}`);
          if (!model) throw new Error(`Model not found: ${command.provider}/${command.modelId}`);
          await this.active.setModel(model as never);
          return void this.host.send(OK(id, type, this.snapshot()));
        }
        case "setThinkingLevel":
          this.active.setThinkingLevel(command.level);
          return void this.host.send(OK(id, type, this.snapshot()));
        case "listSessions":
          return void this.host.send(OK(id, type, await this.listSessions()));
        case "renameSession":
          this.active.setSessionName(command.name);
          return void this.host.send(OK(id, type, this.snapshot()));
        case "newSession":
          await this.openSession({ ...this.config, sessionPath: undefined });
          return void this.host.send(OK(id, type, this.snapshot()));
        case "switchSession":
          await this.openSession({ ...this.config, sessionPath: command.sessionPath });
          return void this.host.send(OK(id, type, this.snapshot()));
        case "compact": {
          const result = await this.active.compact(command.instructions);
          return void this.host.send(OK(id, type, result));
        }
        case "setAutoCompact":
          this.active.setAutoCompactionEnabled(command.enabled);
          return void this.host.send(OK(id, type, this.snapshot()));
        case "setAutoRetry":
          this.active.setAutoRetryEnabled(command.enabled);
          return void this.host.send(OK(id, type));
        case "shutdown":
          await this.teardown();
          return void this.host.send(OK(id, type));
        default:
          return void this.host.send(FAIL(id, type as never, `Unsupported command: ${String(type)}`));
      }
    } catch (error) {
      this.host.send(FAIL(id, type, errorMessage(error)));
    }
  }

  private async listSessions(): Promise<SessionListItem[]> {
    const infos = await SessionManager.list(this.config.cwd, this.config.sessionDir || undefined);
    return infos.map(info => ({
      path: info.path,
      id: info.id,
      name: info.name,
      cwd: info.cwd,
      modified: (info.modified instanceof Date ? info.modified.toISOString() : String(info.modified)),
      messageCount: info.messageCount,
      firstMessage: info.firstMessage,
    }));
  }
}

const STATEFUL_EVENTS = new Set([
  "model_changed",
  "session_info_changed",
  "thinking_level_changed",
  "queue_update",
]);

/* ------------------------------------------------------------------ projections */

/**
 * SDK messages are already plain data, but they carry provider internals we never send to the
 * editor. Projecting also gives every row a stable id the webview can key on.
 */
export function projectMessage(message: unknown): TranscriptMessage {
  const source = (message ?? {}) as LooseRecord;
  const role = String(source.role ?? "system") as TranscriptMessage["role"];
  const content = Array.isArray(source.content)
    ? source.content.map(projectBlock).filter(Boolean)
    : typeof source.content === "string"
      ? [{ type: "text" as const, text: source.content }]
      : [];
  return {
    id: `${role}-${++messageSequence}`,
    role,
    content: content as ContentBlockList,
    timestamp: typeof source.timestamp === "number" ? source.timestamp : Date.now(),
    provider: source.provider === undefined ? undefined : String(source.provider),
    model: source.model === undefined ? undefined : String(source.model),
    responseModel: source.responseModel,
    thinkingLevel: source.thinkingLevel,
    stopReason: source.stopReason,
    errorMessage: source.errorMessage,
    toolCallId: source.toolCallId,
    toolName: source.toolName,
    isError: source.isError,
    usage: source.usage,
  };
}

type ContentBlockList = TranscriptMessage["content"];
let messageSequence = 0;

function projectBlock(block: LooseRecord) {
  switch (block?.type) {
    case "text":
      return { type: "text" as const, text: String(block.text ?? "") };
    case "thinking":
      return { type: "thinking" as const, thinking: String(block.thinking ?? ""), redacted: block.redacted };
    case "toolCall":
    case "tool_use":
      return {
        type: "toolCall" as const,
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        arguments: (block.arguments ?? block.input ?? {}) as Record<string, unknown>,
      };
    default:
      return undefined;
  }
}

/**
 * In-process streaming events carry `partial` (the message so far). The wire form does not, so
 * tool-call identity is lifted out of the partial here rather than being read off the event.
 */
function mapStreamEvent(event: LooseRecord): AssistantStreamEvent {
  const index = Number(event.contentIndex ?? 0);
  switch (event.type) {
    case "start":
      return { type: "start" };
    case "text_start":
      return { type: "text_start", contentIndex: index };
    case "text_delta":
      return { type: "text_delta", contentIndex: index, delta: String(event.delta ?? "") };
    case "text_end":
      return { type: "text_end", contentIndex: index, content: String(event.content ?? "") };
    case "thinking_start":
      return { type: "thinking_start", contentIndex: index };
    case "thinking_delta":
      return { type: "thinking_delta", contentIndex: index, delta: String(event.delta ?? "") };
    case "thinking_end":
      return { type: "thinking_end", contentIndex: index, content: String(event.content ?? "") };
    case "toolcall_start":
    case "tool_call_start":
      return { type: "tool_call_start", contentIndex: index, id: toolCallOf(event, index).id, toolName: toolCallOf(event, index).name };
    case "toolcall_delta":
    case "tool_call_delta":
      return { type: "tool_call_delta", contentIndex: index, delta: String(event.delta ?? "") };
    case "toolcall_end":
    case "tool_call_end":
      return { type: "tool_call_end", contentIndex: index, toolCall: toolCallOf(event, index) };
    case "done":
      return { type: "done" };
    case "error":
      return { type: "error" };
    default:
      return { type: "start" };
  }
}

function toolCallOf(event: LooseRecord, index: number): { id: string; name: string; arguments: Record<string, unknown> } {
  const explicit = event.toolCall;
  if (explicit) {
    return { id: String(explicit.id ?? ""), name: String(explicit.name ?? ""), arguments: (explicit.arguments ?? {}) as Record<string, unknown> };
  }
  const block = event.partial?.content?.[index];
  return {
    id: String(block?.id ?? ""),
    name: String(block?.name ?? ""),
    arguments: (block?.arguments ?? {}) as Record<string, unknown>,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
