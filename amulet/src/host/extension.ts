/**
 * Activation: read settings, own one agent worker per workspace folder, register the chat view
 * and the commands that operate on the folder the user is looking at.
 *
 * Nothing spawns until the chat view is opened — that is the user's intent signal — and while a
 * worker is booting every caller awaits the same start promise, so a fast click sequence cannot
 * fork two agents for one folder.
 */
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ChatViewProvider } from "./chatViewProvider.js";
import { ContextBridge } from "./contextBridge.js";
import { AgentWorkerClient, resolveWorkerEntry } from "./workerClient.js";
import type { SessionState, ThinkingLevel, WorkerCommand, WorkerConfig } from "../shared/protocol.js";
import { THINKING_LEVELS } from "../shared/protocol.js";

export function activate(context: vscode.ExtensionContext): void {
  const runtime = new AmuletRuntime(context);
  context.subscriptions.push(runtime);
}

class AmuletRuntime {
  private readonly workers = new Map<string, AgentWorkerClient>();
  /** One in-flight start per cwd, shared by every caller. */
  private readonly booting = new Map<string, Promise<AgentWorkerClient | undefined>>();
  private readonly output: vscode.OutputChannel;
  private readonly context: ContextBridge;
  private readonly chatView: ChatViewProvider;

  constructor(private readonly extensionContext: vscode.ExtensionContext) {
    this.output = vscode.window.createOutputChannel("Amulet Agent", { log: true });
    this.context = new ContextBridge({
      getCwd: () => this.config()?.cwd,
      post: event => this.chatView.post(event),
    });
    this.chatView = new ChatViewProvider(
      extensionContext.extensionUri,
      () => this.ensureWorker(),
      () => void this.ensureWorker(),
      this.context,
    );

    extensionContext.subscriptions.push(
      this.output,
      this.chatView,
      vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, this.chatView, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.context.onActiveEditorChanged()),
      vscode.commands.registerCommand("amulet.newSession", () => this.runCommand({ id: randomUUID(), type: "newSession" })),
      vscode.commands.registerCommand("amulet.compact", () => this.runCommand({ id: randomUUID(), type: "compact" })),
      vscode.commands.registerCommand("amulet.abort", () => this.runCommand({ id: randomUUID(), type: "abort" })),
      vscode.commands.registerCommand("amulet.openSession", () => this.pickSession()),
      vscode.commands.registerCommand("amulet.selectModel", () => this.pickModel()),
      vscode.commands.registerCommand("amulet.selectThinkingLevel", () => this.pickThinkingLevel()),
      vscode.commands.registerCommand("amulet.showLogs", () => this.output.show()),
      vscode.commands.registerCommand("amulet.restartWorker", () => this.restartWorker()),
      vscode.commands.registerCommand("amulet.attachSelection", () => this.context.attachSelection()),
      vscode.commands.registerCommand("amulet.attachActiveFile", () => this.context.attachActiveFile()),
      vscode.commands.registerCommand("amulet.attachFile", (uri?: vscode.Uri, uris?: readonly vscode.Uri[]) =>
        this.context.attachFiles(uris?.length ? uris : uri ? [uri] : undefined),
      ),
      vscode.commands.registerCommand("amulet.attachProblems", () => this.context.attachProblems()),
      vscode.commands.registerCommand("amulet.openChat", () => vscode.commands.executeCommand("workbench.view.extension.amulet")),
    );
  }

  dispose(): void {
    for (const worker of this.workers.values()) worker.dispose();
    this.workers.clear();
    this.booting.clear();
  }

  /* ------------------------------------------------------------ configuration */

  private config(): WorkerConfig | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return undefined;
    const settings = vscode.workspace.getConfiguration("amulet");
    return {
      cwd: folder.uri.fsPath,
      agentDir: settings.get<string>("agentDir") || undefined,
      sessionDir: settings.get<string>("sessionDir") || undefined,
      model: settings.get<string>("model") || undefined,
      thinkingLevel: (settings.get<string>("thinkingLevel") || undefined) as ThinkingLevel | undefined,
      autoCompact: settings.get<boolean>("autoCompact", true),
      autoRetry: settings.get<boolean>("autoRetry", true),
      continueLast: settings.get<boolean>("restoreLastSession", true),
    };
  }

  /* ------------------------------------------------------------ workers */

  async ensureWorker(): Promise<AgentWorkerClient | undefined> {
    const config = this.config();
    if (!config) {
      void vscode.window.showWarningMessage("Amulet needs an open folder to start an agent session.");
      return undefined;
    }
    const existing = this.workers.get(config.cwd);
    if (existing) return existing;

    let pending = this.booting.get(config.cwd);
    if (!pending) {
      pending = this.boot(config.cwd, config).finally(() => this.booting.delete(config.cwd));
      this.booting.set(config.cwd, pending);
    }
    return pending;
  }

  private async boot(cwd: string, config: WorkerConfig): Promise<AgentWorkerClient | undefined> {
    let client: AgentWorkerClient;
    try {
      client = new AgentWorkerClient(resolveWorkerEntry(this.extensionContext.extensionPath), config, {
        maxOldSpaceMB: vscode.workspace.getConfiguration("amulet").get<number>("worker.maxOldSpaceMB", 0),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`startup failed: ${message}`);
      void vscode.window.showErrorMessage(`Amulet is not built: ${message}`, "Show Logs").then(choice => choice && this.output.show());
      return undefined;
    }

    this.workers.set(cwd, client);
    this.wire(client);
    try {
      await client.start();
      return client;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`startup failed: ${message}`);
      void vscode.window
        .showErrorMessage(`Amulet could not start the agent: ${message}`, "Show Logs", "Retry")
        .then(async choice => {
          if (choice === "Show Logs") this.output.show();
          if (choice === "Retry") await this.restartWorker();
        });
      // Drop the dead client so the next interaction tries again.
      client.dispose();
      this.workers.delete(cwd);
      return undefined;
    }
  }

  private wire(client: AgentWorkerClient): void {
    this.chatView.attach(client);
    client.onStatus((status, detail) => {
      this.output.appendLine(`[${client.cwd}] ${status}${detail ? ` — ${detail}` : ""}`);
    });
    client.onLog((level, text) => {
      for (const line of text.split("\n")) this.output.appendLine(`[${level}] ${line}`);
    });
    client.onState((state: SessionState) => {
      this.output.appendLine(
        `session ${state.sessionId} · model ${state.model?.provider ?? "?"}/${state.model?.id ?? "?"} · ${state.messageCount} messages`,
      );
    });
  }

  private activeFolder(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  private async restartWorker(): Promise<void> {
    const cwd = this.activeFolder();
    if (!cwd) return;
    this.workers.get(cwd)?.dispose();
    this.workers.delete(cwd);
    await this.ensureWorker();
  }

  /* ------------------------------------------------------------ commands */

  private async runCommand(command: WorkerCommand): Promise<void> {
    const worker = await this.ensureWorker();
    if (!worker) return;
    try {
      await worker.command(command);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async pickSession(): Promise<void> {
    const worker = await this.ensureWorker();
    if (!worker) return;
    type SessionItem = { path: string; id: string; name?: string; messageCount: number; modified: string; firstMessage: string };
    let sessions: SessionItem[] = [];
    try {
      sessions = await worker.command<SessionItem[]>({ id: randomUUID(), type: "listSessions" });
    } catch (error) {
      return void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
    const picked = await vscode.window.showQuickPick(
      sessions.map(session => ({
        label: session.name || session.firstMessage.slice(0, 60) || session.id,
        description: `${session.messageCount} messages · ${new Date(session.modified).toLocaleString()}`,
        detail: session.path,
        session,
      })),
      { placeHolder: "Open a session" },
    );
    if (!picked) return;
    await this.runCommand({ id: randomUUID(), type: "switchSession", sessionPath: picked.session.path });
  }

  private async pickModel(): Promise<void> {
    const worker = await this.ensureWorker();
    if (!worker) return;
    type ModelItem = { provider: string; id: string; name: string; available: boolean; contextWindow: number };
    let models: ModelItem[] = [];
    try {
      models = await worker.command<ModelItem[]>({ id: randomUUID(), type: "listModels" });
    } catch (error) {
      return void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
    const picked = await vscode.window.showQuickPick(
      models.map(model => ({
        label: model.available ? model.name : `$(circle-slash) ${model.name}`,
        description: `${model.provider}/${model.id}`,
        detail: model.available
          ? `${Math.round(model.contextWindow / 1000)}k context window`
          : "No credentials configured for this provider",
        model,
      })),
      { placeHolder: "Select a model", matchOnDescription: true },
    );
    if (!picked) return;
    await this.runCommand({ id: randomUUID(), type: "setModel", provider: picked.model.provider, modelId: picked.model.id });
  }

  private async pickThinkingLevel(): Promise<void> {
    const worker = await this.ensureWorker();
    if (!worker) return;
    const items = THINKING_LEVELS.map(level => ({ label: level, description: level === "off" ? "no reasoning" : undefined, level }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select a thinking level" });
    if (!picked) return;
    await this.runCommand({ id: randomUUID(), type: "setThinkingLevel", level: picked.level });
  }
}

export function deactivate(): void {
  /* disposal happens through the extension context subscriptions */
}
