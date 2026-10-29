/**
 * Bridges the chat webview to the agent worker for one workspace folder.
 *
 * It is deliberately thin: it owns the webview lifecycle and the CSP, translates webview
 * requests into worker commands, and forwards worker traffic back. All transcript state
 * reconstruction lives in the webview so the two sides can evolve independently.
 */
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { HostEvent, WorkerCommand } from "../shared/protocol.js";
import type { AgentWorkerClient } from "./workerClient.js";

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

  private async handleWebviewMessage(message: { type?: string; name?: string; payload?: Record<string, unknown> }): Promise<void> {
    if (message?.type === "ready") {
      this.viewReady = true;
      for (const event of this.latest.values()) this.post(event);
      await this.syncTranscript();
      void this.refreshHeader();
      return;
    }
    if (message?.type !== "command" || !message.name) return;
    const worker = await this.getWorker();
    if (!worker) {
      this.post({ type: "toast", message: "The agent is not running for this workspace.", level: "error" });
      return;
    }
    const payload = message.payload ?? {};
    try {
      switch (message.name) {
        case "prompt": {
          const text = String(payload.text ?? "");
          if (!text.trim()) return;
          const state = await worker.command<{ isStreaming: boolean }>({ id: randomUUID(), type: "getState" });
          const command: WorkerCommand = {
            id: randomUUID(),
            type: "prompt",
            text,
            streamingBehavior: state.isStreaming ? "steer" : undefined,
          };
          await worker.command(command);
          return;
        }
        case "abort":
          return void (await worker.tryCommand({ id: randomUUID(), type: "abort" }));
        case "newSession":
          return void (await worker.tryCommand({ id: randomUUID(), type: "newSession" }));
        case "compact":
          return void (await worker.tryCommand({ id: randomUUID(), type: "compact" }));
        case "listSessions": {
          const sessions = await worker.command({ id: randomUUID(), type: "listSessions" });
          return this.post({ type: "sessions", sessions: sessions as never });
        }
        case "listModels": {
          const models = await worker.command({ id: randomUUID(), type: "listModels" });
          return this.post({ type: "models", models: models as never });
        }
        default:
          return this.post({ type: "toast", message: `Unsupported request: ${message.name}`, level: "warning" });
      }
    } catch (error) {
      this.post({ type: "toast", message: error instanceof Error ? error.message : String(error), level: "error" });
    }
  }

  private async refreshHeader(): Promise<void> {
    const worker = await this.getWorker();
    if (!worker) return;
    try {
      const state = await worker.command<import("../shared/protocol.js").SessionState>({ id: randomUUID(), type: "getState" });
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
