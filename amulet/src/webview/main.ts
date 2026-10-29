/**
 * The chat webview: owns rendering and the composer, and speaks only in protocol messages.
 * It never touches VS Code APIs beyond `acquireVsCodeApi`, which keeps the whole UI portable
 * (the same bundle runs in a chat editor tab and in a standalone panel).
 */
import type { HostEvent, ContentBlock, TranscriptMessage, WebviewRequest } from "../shared/protocol.js";
import { parseContextBlock, type ContextDraft } from "../shared/contextBlock.js";
import { ContextChips, MentionPicker, readImageFile, type PendingImage } from "./composer.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void };

type Block = ContentBlock & { id: string };

interface Item {
  id: string;
  kind: "user" | "assistant" | "tool" | "system";
  blocks: Block[];
  streaming?: boolean;
  /** Chips the message was sent with, rendered above the text. */
  context?: string[];
  /** tool items */
  toolName?: string;
  toolCallId?: string;
  toolState?: "running" | "done" | "error";
  toolResult?: string;
  args?: Record<string, unknown>;
  meta?: string;
  error?: string;
}

interface ViewModel {
  items: Item[];
  statusText: string;
  busy: boolean;
  modelName: string;
  contextPercent: number;
  queue: string[];
}

const vscode = acquireVsCodeApi();
const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Amulet webview mounted without #app");

const model: ViewModel = { items: [], statusText: "Starting the agent…", busy: false, modelName: "—", contextPercent: 0, queue: [] };
let composerText = "";
let itemSequence = 0;
let settings = { pasteBadgeThreshold: 700, attachSelectionOnFocus: true };

/* ------------------------------------------------------------------ shell */

root.innerHTML = `
  <div class="transcript" id="transcript" tabindex="0"></div>
  <div class="composer" id="composer">
    <div class="queue" id="queue" hidden></div>
    <div class="chips" id="chips" hidden></div>
    <div class="picker" id="picker" hidden></div>
    <textarea id="input" rows="3" placeholder="Ask the agent. @ to attach a file, Enter to send, Shift+Enter for a newline."></textarea>
    <div class="composer-bar">
      <button id="send" class="primary" type="button">Send</button>
      <button id="stop" type="button" hidden>Stop</button>
      <span class="spacer"></span>
      <span class="status" id="status"></span>
    </div>
  </div>
  <button id="quote" class="quote-button" type="button" hidden>Quote in chat</button>
`;

const transcript = element<HTMLDivElement>("transcript");
const composer = element<HTMLDivElement>("composer");
const input = element<HTMLTextAreaElement>("input");
const chipsRow = element<HTMLDivElement>("chips");
const pickerPopup = element<HTMLDivElement>("picker");
const quoteButton = element<HTMLButtonElement>("quote");
const sendButton = element<HTMLButtonElement>("send");
const stopButton = element<HTMLButtonElement>("stop");
const statusLine = element<HTMLSpanElement>("status");
const queueLine = element<HTMLDivElement>("queue");

/** Everything the context layer needs from the rest of the app. */
const bridge = {
  post: (message: WebviewRequest) => vscode.postMessage(message),
  toast: (message: string) => pushSystem(message),
};

const chips = new ContextChips(chipsRow, bridge);
const picker = new MentionPicker(input, pickerPopup, bridge);

sendButton.addEventListener("click", () => submit());
stopButton.addEventListener("click", () => command("abort"));
input.addEventListener("keydown", event => {
  if (picker.onKeyDown(event)) return;
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});
input.addEventListener("input", () => {
  composerText = input.value;
  picker.sync();
  renderComposer();
});
input.addEventListener("keyup", () => picker.sync());
input.addEventListener("click", () => picker.sync());
input.addEventListener("focus", () => bridge.post({ type: "composerFocused" }));
input.addEventListener("paste", event => void onPaste(event));

// VS Code keeps a drag for itself until Shift is held; the guide tells the user, so does the drop zone.
composer.addEventListener("dragover", event => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  composer.classList.add("is-dragging");
});
composer.addEventListener("dragleave", () => composer.classList.remove("is-dragging"));
composer.addEventListener("drop", event => void onDrop(event));

transcript.addEventListener("mouseup", () => setTimeout(refreshQuoteButton, 0));
quoteButton.addEventListener("mousedown", event => {
  event.preventDefault();
  quoteSelection();
});

vscode.postMessage({ type: "ready" });

/* ------------------------------------------------------------------ composer input */

async function onPaste(event: ClipboardEvent): Promise<void> {
  const files = [...(event.clipboardData?.files ?? [])];
  const images = files.filter(file => file.type.startsWith("image/"));
  if (images.length) {
    event.preventDefault();
    for (const file of images) {
      const image = await readImageFile(file);
      if (image) chips.addImage(image);
      else bridge.toast("That image could not be read.");
    }
    return;
  }
  const pasted = event.clipboardData?.getData("text/plain") ?? "";
  // A long paste becomes a badge so the message stays readable; the whole text is still sent, as a quote.
  if (pasted.length > settings.pasteBadgeThreshold) {
    event.preventDefault();
    chips.add({ quotes: [{ text: pasted, origin: "pasted" }] });
  }
}

async function onDrop(event: DragEvent): Promise<void> {
  composer.classList.remove("is-dragging");
  event.preventDefault();
  const transfer = event.dataTransfer;
  if (!transfer) return;
  const uris = (transfer.getData("text/uri-list") ?? "")
    .split("\n")
    .map(line => line.trim())
    .filter(line => line && !line.startsWith("#"));
  const files = [...transfer.files];
  const images = files.filter(file => file.type.startsWith("image/"));
  for (const file of images) {
    const image = await readImageFile(file);
    if (image) chips.addImage(image);
  }
  if (uris.length) bridge.post({ type: "attachUris", uris });
  else if (!images.length) bridge.toast("Drag files from the Explorer while holding Shift.");
}

let pendingQuote: { text: string; source: string } | undefined;

/** Show the Quote button only for a selection made inside one message. */
function refreshQuoteButton(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.toString().trim()) return void hideQuoteButton();
  const anchor = selection.anchorNode?.parentElement?.closest?.("[data-item-id]");
  const focus = selection.focusNode?.parentElement?.closest?.("[data-item-id]");
  if (!anchor || anchor !== focus) return void hideQuoteButton();
  pendingQuote = { text: selection.toString(), source: (anchor as HTMLElement).dataset.itemId ?? "" };
  const range = selection.getRangeAt(0).getBoundingClientRect();
  quoteButton.style.top = `${Math.max(4, range.top - 30)}px`;
  quoteButton.style.left = `${Math.max(4, range.left)}px`;
  quoteButton.hidden = false;
}
function hideQuoteButton(): void {
  quoteButton.hidden = true;
  pendingQuote = undefined;
}

function quoteSelection(): void {
  if (!pendingQuote) return;
  chips.add({ quotes: [{ text: pendingQuote.text, source: pendingQuote.source }] });
  window.getSelection()?.removeAllRanges();
  hideQuoteButton();
  input.focus();
}

/* ------------------------------------------------------------------ commands */

function submit(): void {
  const text = input.value.trim();
  if (!text && chips.empty) return;
  const { draft: contextDraft, images } = chips.drain();
  input.value = "";
  composerText = "";
  picker.close();
  vscode.postMessage({ type: "prompt", text, context: contextDraft, images });
  renderComposer();
}

function command(name: string, payload?: Record<string, unknown>): void {
  vscode.postMessage({ type: "command", name, payload });
}

/* ------------------------------------------------------------------ inbound */

window.addEventListener("message", event => {
  const message = event.data as HostEvent;
  applyMessage(message);
  render();
});

function applyMessage(message: HostEvent): void {
  if (!message || typeof message !== "object") return;
  switch (message.type) {
    case "messages":
      model.items = message.messages.map(fromTranscript);
      return;
    case "state":
      model.modelName = message.state.model ? `${message.state.model.name}` : "no model";
      model.contextPercent = message.state.contextUsage?.percent ?? 0;
      model.busy = message.state.isStreaming;
      model.statusText = message.state.sessionName ?? "Session";
      model.queue = [];
      return;
    case "workerStatus":
      model.statusText = describeStatus(message.status, message.detail);
      if (message.status === "failed") pushSystem(message.detail ?? "The agent process failed to start.");
      return;
    case "models":
      return;
    case "toast":
      pushSystem(message.message);
      return;
    case "contextAppend":
      chips.add(message.fragment);
      return;
    case "fileResults":
      picker.onResults(message.requestId, message.items);
      return;
    case "composerSettings":
      settings = { pasteBadgeThreshold: message.pasteBadgeThreshold, attachSelectionOnFocus: message.attachSelectionOnFocus };
      return;
    case "event":
      return applyEvent(message.event);
  }
}

function applyEvent(event: Extract<HostEvent, { type: "event" }>["event"]): void {
  switch (event.type) {
    case "agent_start":
      model.busy = true;
      return;
    case "agent_settled":
      model.busy = false;
      for (const item of model.items) if (item.streaming) item.streaming = false;
      return;
    case "message_start": {
      if (event.message.role === "user") {
        model.items.push(fromTranscript(event.message));
      } else if (event.message.role === "assistant") {
        model.items.push({ id: event.message.id, kind: "assistant", blocks: [], streaming: true });
      }
      return;
    }
    case "message_update":
      return applyStreamEvent(event.assistantMessageEvent);
    case "message_end":
      return replaceMessage(event.message);
    case "tool_execution_start": {
      model.items.push({
        id: `tool-${event.toolCallId}`,
        kind: "tool",
        blocks: [],
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        toolState: "running",
        args: event.args as Record<string, unknown>,
      });
      return;
    }
    case "tool_execution_end": {
      const item = model.items.find(candidate => candidate.toolCallId === event.toolCallId);
      if (!item) return;
      item.toolState = event.isError ? "error" : "done";
      item.toolResult = summarizeResult(event.result);
      return;
    }
    case "queue_update":
      model.queue = [...event.steering, ...event.followUp];
      return;
    case "compaction_start":
      return pushSystem("Compacting context…");
    case "compaction_end":
      return pushSystem(event.ok ? "Context compacted." : `Compaction failed: ${event.errorMessage ?? "unknown error"}`);
    case "auto_retry_start":
      return pushSystem(`Provider error, retrying in ${Math.round(event.delayMs / 1000)}s (attempt ${event.attempt}/${event.maxAttempts}).`);
    case "extension_error":
      return pushSystem(`Extension error in ${event.extensionPath}: ${event.error}`);
    case "session_info_changed":
      if (event.name) model.statusText = event.name;
      return;
    default:
      return;
  }
}

function applyStreamEvent(stream: import("../shared/protocol.js").AssistantStreamEvent): void {
  const item = [...model.items].reverse().find(candidate => candidate.kind === "assistant" && candidate.streaming);
  if (!item) return;
  switch (stream.type) {
    case "text_delta":
      return appendBlock(item, `b${stream.contentIndex}`, "text", { text: stream.delta });
    case "thinking_delta":
      return appendBlock(item, `b${stream.contentIndex}`, "thinking", { thinking: stream.delta });
    default:
      // Starts, ends and tool-call frames are covered by message_end / tool_execution_*; deltas
      // alone are enough to render live and the authoritative content replaces them after.
      return;
  }
}

function replaceMessage(message: TranscriptMessage): void {
  const projected = fromTranscript(message);
  if (message.role === "toolResult") {
    const item = model.items.find(candidate => candidate.toolCallId === message.toolCallId);
    if (item) {
      item.toolState = message.isError ? "error" : "done";
      item.toolResult = projected.blocks.map(blockText).join("\n");
    }
    return;
  }
  const existing = model.items.find(candidate => candidate.id === message.id);
  if (existing) {
    existing.blocks = projected.blocks;
    existing.streaming = false;
    existing.error = message.errorMessage;
    return;
  }
  if (message.role === "assistant") model.items.push({ ...projected, streaming: false });
}

function fromTranscript(message: TranscriptMessage): Item {
  const blocks: Block[] = message.content.map((block, index) => ({ ...block, id: `m${message.id}-${index}` } as Block));
  const kind: Item["kind"] = message.role === "user" ? "user" : message.role === "assistant" ? "assistant" : "system";
  const meta = message.role === "assistant" && message.model ? `${message.responseModel ?? message.model}` : undefined;
  if (message.role === "user") {
    // A sent message carries its context block; show it as chips over the user's own words, the
    // same way the composer did, rather than as a wall of quoted source.
    const raw = blocks.filter(block => block.type === "text").map(block => (block as { text: string }).text).join("\n");
    const { draft: sentDraft, userText } = parseContextBlock(raw);
    const labels = describeContext(sentDraft);
    const others = blocks.filter(block => block.type !== "text");
    const shown: Block[] = userText.trim() ? [{ type: "text", text: userText, id: `m${message.id}-text` }, ...others] : others;
    return { id: message.id, kind, blocks: shown, context: labels.length ? labels : undefined, meta, error: message.errorMessage };
  }
  return { id: message.id, kind, blocks, meta, error: message.errorMessage };
}

function describeContext(draft: ContextDraft): string[] {
  const labels = [
    ...draft.files.map(label => `@${label}`),
    ...draft.selections.map(selection => `@${selection.path}:${selection.lineRange} quoted`),
    ...draft.quotes.map(quote => `“${quote.text.replace(/\s+/g, " ").trim().slice(0, 42)}”`),
    ...draft.problems.map(problem => `${problem.severity} ${problem.path}:${problem.line}`),
    ...draft.notes.map(note => `note for ${note.path}`),
  ];
  return labels;
}

function appendBlock(item: Item, id: string, type: ContentBlock["type"], patch: Record<string, unknown>): void {
  const existing = item.blocks.find(block => block.id === id && block.type === type);
  if (existing) {
    for (const [key, value] of Object.entries(patch)) {
      const current = (existing as unknown as Record<string, unknown>)[key];
      (existing as unknown as Record<string, unknown>)[key] = typeof value === "string" && typeof current === "string" ? current + value : value;
    }
    return;
  }
  item.blocks.push({ type, ...patch, id } as unknown as Block);
}

function pushSystem(text: string): void {
  model.items.push({ id: `sys-${++itemSequence}`, kind: "system", blocks: [{ type: "text", text, id: `sys-b${itemSequence}` }] });
}

/* ------------------------------------------------------------------ render */

function render(): void {
  const stickToBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 40;
  transcript.replaceChildren(...model.items.map(renderItem));
  if (stickToBottom) transcript.scrollTop = transcript.scrollHeight;
  statusLine.textContent = model.busy
    ? `${model.modelName} · working`
    : `${model.modelName} · ${Math.round(model.contextPercent)}% context`;
  stopButton.hidden = !model.busy;
  sendButton.hidden = model.busy;
  renderComposer();
}

function renderItem(item: Item): HTMLElement {
  const wrapper = document.createElement("section");
  wrapper.className = `item item-${item.kind}${item.streaming ? " is-streaming" : ""}`;
  wrapper.dataset.itemId = item.id;
  if (item.kind === "tool") return renderTool(item, wrapper);

  if (item.context?.length) {
    const row = document.createElement("div");
    row.className = "sent-context";
    for (const label of item.context) {
      const chipSpan = document.createElement("span");
      chipSpan.className = "chip chip-sent";
      chipSpan.textContent = label;
      row.appendChild(chipSpan);
    }
    wrapper.appendChild(row);
  }

  for (const block of item.blocks) {
    const node = document.createElement(block.type === "thinking" ? "details" : "div");
    if (block.type === "thinking") node.className = "thinking";
    if (block.type === "text") node.className = "text";
    if (block.type === "thinking") {
      const summary = document.createElement("summary");
      summary.textContent = "Thinking";
      node.appendChild(summary);
      const body = document.createElement("div");
      body.className = "thinking-body";
      body.textContent = block.thinking;
      node.appendChild(body);
    } else if (block.type === "text") {
      node.textContent = block.text;
    } else {
      node.className = "tool-inline";
      node.textContent = `${block.name} ${JSON.stringify(block.arguments)}`;
    }
    wrapper.appendChild(node);
  }
  if (item.error) wrapper.appendChild(errorLine(item.error));
  if (item.meta) {
    const meta = document.createElement("footer");
    meta.className = "meta";
    meta.textContent = item.meta;
    wrapper.appendChild(meta);
  }
  return wrapper;
}

function renderTool(item: Item, wrapper: HTMLElement): HTMLElement {
  const args = item.args ? ` ${toolSummary(item.toolName ?? "", item.args)}` : "";
  wrapper.appendChild(line("tool-title", `${item.toolState === "error" ? "✕" : item.toolState === "done" ? "✓" : "…"} ${item.toolName}${args}`));
  if (item.toolResult) {
    const body = document.createElement("pre");
    body.className = "tool-result";
    body.textContent = clip(item.toolResult);
    wrapper.appendChild(body);
  }
  return wrapper;
}

function renderComposer(): void {
  if (input.value !== composerText) input.value = composerText;
  queueLine.hidden = model.queue.length === 0;
  queueLine.textContent = model.queue.length ? `Queued: ${model.queue.join(" · ")}` : "";
}

/* ------------------------------------------------------------------ helpers */

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in the webview shell`);
  return node as T;
}

function line(className: string, text: string): HTMLElement {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  return node;
}

function errorLine(text: string): HTMLElement {
  const node = line("error", text);
  return node;
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text;
    case "thinking":
      return block.thinking;
    case "toolCall":
      return `${block.name} ${JSON.stringify(block.arguments)}`;
  }
}

function summarizeResult(result: unknown): string {
  const value = result as { content?: unknown };
  if (Array.isArray(value?.content)) {
    return value.content
      .map(part => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : JSON.stringify(part)))
      .join("\n");
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

/** One-line description of a tool call, mirroring what the editor shows elsewhere. */
function toolSummary(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read":
      return String(args.path ?? args.file_path ?? "");
    case "edit":
    case "write":
      return String(args.path ?? args.file_path ?? "");
    case "bash":
      return String(args.command ?? "").slice(0, 120);
    case "grep":
    case "find":
      return String(args.pattern ?? args.query ?? "");
    default:
      return "";
  }
}

function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n… truncated …` : text;
}

function describeStatus(status: string, detail?: string): string {
  switch (status) {
    case "starting":
      return "Starting the agent…";
    case "ready":
      return "Ready";
    case "restarting":
      return detail ?? "Restarting the agent…";
    case "failed":
      return detail ?? "The agent process is not running.";
    default:
      return "Stopped";
  }
}

render();
