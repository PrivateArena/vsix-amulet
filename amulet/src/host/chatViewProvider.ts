/**
 * Bridges the chat webview to the agent worker for one workspace folder.
 *
 * It owns the webview lifecycle and the CSP, translates webview requests into worker commands,
 * and forwards worker traffic back. Transcript reconstruction lives in the webview; the context
 * block is assembled here, because text coming out of a webview is untrusted input.
 */
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type {
  HostEvent,
  ModelSummary,
  ResourceReport,
  SessionListItem,
  SessionState,
  ThinkingLevel,
  WebviewRequest,
} from "../shared/protocol.js";
import type { AgentWorkerClient } from "./workerClient.js";
import type { ContextBridge } from "./contextBridge.js";

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "amulet.chatView";

  private view?: vscode.WebviewView;
  private readonly disposables: Array<{ dispose(): void }> = [];
  /** Latest values of sticky channels, replayed when the webview finally boots. */
  private readonly latest = new Map<"state" | "workerStatus", HostEvent>();
  /** True until the webview has asked for its initial state. */
  private viewReady = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    /** Resolves to a running worker, starting one if needed (the view is the user's intent). */
    private readonly getWorker: () => Promise<AgentWorkerClient | undefined>,
    /** Called when the view becomes visible, so the host can start the agent eagerly. */
    private readonly onVisible: () => void,
    private readonly context: ContextBridge,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.viewReady = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    view.webview.html = this.renderHtml(view.webview);
    this.onVisible();

    const onMessage = view.webview.onDidReceiveMessage(message => void this.handleWebviewMessage(message));
    this.disposables.push(onMessage);
    this.disposables.push({
      dispose: () => {
        if (this.view === view) this.view = undefined;
      },
    });

    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  post(event: HostEvent): void {
    this.view?.webview.postMessage(event);
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
    this.view = undefined;
  }

  /** Post a sticky event, remembering it so a later-loading webview still sees it. */
  private postSticky(event: HostEvent): void {
    if (event.type === "state" || event.type === "workerStatus") this.latest.set(event.type, event);
    this.post(event);
  }

  /** Replay the current transcript once the webview says it is listening. */
  private async syncTranscript(): Promise<void> {
    const worker = await this.getWorker();
    if (!worker || !this.view) return;
    try {
      const messages = await worker.command<import("../shared/protocol.js").TranscriptMessage[]>({
        id: randomUUID(),
        type: "getMessages",
      });
      this.post({ type: "messages", messages });
    } catch {
      /* an empty session is a valid reason to have no transcript */
    }
  }

  /** Bind worker traffic to this view. Called by the extension once a worker exists. */
  attach(client: AgentWorkerClient): void {
    this.disposables.push(client.onEvent(event => this.post(event)));
    this.disposables.push(client.onState(state => this.postSticky({ type: "state", state })));
    this.disposables.push(client.onStatus((status, detail) => this.postSticky({ type: "workerStatus", status, detail })));
    this.disposables.push(
      client.onLog((level, text) => {
        if (level === "error") this.post({ type: "toast", message: text, level });
      }),
    );
    // A worker that came up while the webview was still booting has events the view never saw,
    // so the transcript is re-read rather than replayed.
    if (this.viewReady) void this.syncTranscript();
  }

  private async handleWebviewMessage(message: WebviewRequest): Promise<void> {
    switch (message?.type) {
      case "ready":
        this.viewReady = true;
        this.post({ type: "composerSettings", ...this.context.composerSettings });
        for (const event of this.latest.values()) this.post(event);
        await this.syncTranscript();
        void this.refreshHeader();
        return;
      case "attachUris":
        return this.context.attachUris(message.uris);
      case "composerFocused":
        return this.context.onComposerFocused();
      case "contextDismissed":
        return this.context.dismiss(message.labels);
      case "searchFiles":
        return this.context.search(message.requestId, message.query);
      case "openFile":
        return this.context.open(message.label);
      case "prompt":
        return this.sendPrompt(message);
      case "command":
        return this.runWorkerCommand(message.name, message.payload);
      case "hostCommand":
        // Quick picks and panels live in the editor, not in the worker.
        return void (await vscode.commands.executeCommand(message.name));
      default:
        return;
    }
  }

  private async sendPrompt(message: Extract<import("../shared/protocol.js").WebviewRequest, { type: "prompt" }>): Promise<void> {
    const text = message.text;
    if (!text.trim() && !message.images?.length) return;
    const worker = await this.getWorker();
    if (!worker) return void this.post({ type: "toast", message: "The agent is not running for this workspace.", level: "error" });
    // The block is assembled here, on the trusted side of the boundary, from validated pieces.
    const fullText = await this.context.buildPromptText(text, message.context);
    try {
      const state = await worker.command<SessionState>({ id: randomUUID(), type: "getState" });
      await worker.command({
        id: randomUUID(),
        type: "prompt",
        text: fullText,
        images: message.images,
        streamingBehavior: state.isStreaming ? "steer" : undefined,
      });
    } catch (error) {
      this.post({ type: "toast", message: error instanceof Error ? error.message : String(error), level: "error" });
    }
  }

  private async runWorkerCommand(name: string, payload?: Record<string, unknown>): Promise<void> {
    const worker = await this.getWorker();
    if (!worker) {
      this.post({ type: "toast", message: "The agent is not running for this workspace.", level: "error" });
      return;
    }
    const id = () => randomUUID();
    try {
      switch (name) {
        case "abort":
          return void (await worker.tryCommand({ id: id(), type: "abort" }));
        case "newSession":
          return void (await worker.tryCommand({ id: id(), type: "newSession" }));
        case "compact":
          return void (await worker.tryCommand({ id: id(), type: "compact" }));
        case "listSessions": {
          const sessions = await worker.command<SessionListItem[]>({ id: id(), type: "listSessions" });
          return this.post({ type: "sessions", sessions });
        }
        case "listModels": {
          const models = await worker.command<ModelSummary[]>({ id: id(), type: "listModels" });
          return this.post({ type: "models", models });
        }
        case "setModel": {
          await worker.command({ id: id(), type: "setModel", provider: String(payload?.provider ?? ""), modelId: String(payload?.modelId ?? "") });
          return this.refreshHeader();
        }
        case "setThinkingLevel": {
          await worker.command({ id: id(), type: "setThinkingLevel", level: payload?.level as ThinkingLevel });
          return this.refreshHeader();
        }
        case "switchSession": {
          await worker.command({ id: id(), type: "switchSession", sessionPath: String(payload?.sessionPath ?? "") });
          return this.refreshHeader();
        }
        case "renameSession":
          await worker.command({ id: id(), type: "renameSession", name: String(payload?.name ?? "") });
          return this.refreshHeader();
        case "getResources": {
          const resources = await worker.command<ResourceReport>({ id: id(), type: "getResources" });
          return this.post({ type: "resources", resources });
        }
        case "reload":
          return this.reload();
        default:
          return this.post({ type: "toast", message: `Unsupported request: ${name}`, level: "warning" });
      }
    } catch (error) {
      this.post({ type: "toast", message: error instanceof Error ? error.message : String(error), level: "error" });
    }
  }

  /**
   * Reload Pi's configuration in place, then refresh what it can change. Each refresh is reported
   * separately: a transcript that did not come back is worth telling the user about, while the
   * worker is still running and the reload itself succeeded.
   */
  async reload(): Promise<void> {
    const worker = await this.getWorker();
    if (!worker) return void this.post({ type: "toast", message: "The agent is not running for this workspace.", level: "error" });
    try {
      await worker.command({ id: randomUUID(), type: "reload" });
      this.post({ type: "toast", message: "Pi config reloaded.", level: "info" });
    } catch (error) {
      return this.post({ type: "toast", message: error instanceof Error ? error.message : String(error), level: "error" });
    }
    await this.refreshHeader();
    try {
      await this.syncTranscript();
    } catch {
      this.post({ type: "toast", message: "Pi reloaded, but the current transcript could not be refreshed.", level: "warning" });
    }
    try {
      const models = await worker.command<ModelSummary[]>({ id: randomUUID(), type: "listModels" });
      this.post({ type: "models", models });
    } catch {
      this.post({ type: "toast", message: "Pi reloaded, but the model list could not be refreshed.", level: "warning" });
    }
    try {
      const resources = await worker.command<ResourceReport>({ id: randomUUID(), type: "getResources" });
      this.post({ type: "resources", resources });
    } catch {
      /* the panel reports this on its own */
    }
  }

  /** Push a state the host already has, so a palette-driven change reaches the chat header. */
  pushState(state: SessionState): void {
    this.postSticky({ type: "state", state });
  }

  private async refreshHeader(): Promise<void> {
    const worker = await this.getWorker();
    if (!worker) return;
    try {
      const state = await worker.command<SessionState>({ id: randomUUID(), type: "getState" });
      this.post({ type: "state", state });
    } catch {
      /* the worker reports its own failures */
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", "webview.css"));
    const nonce = randomUUID().replace(/-/g, "");
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>Amulet</title>
</head>
<body>
  <div id="app"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
