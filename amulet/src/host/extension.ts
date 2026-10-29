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
import { ManagePanel } from "./managePanel.js";
import type { ResourceReport, SessionState, ThinkingLevel, WorkerCommand, WorkerConfig } from "../shared/protocol.js";
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
  private managePanel?: ManagePanel;

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
      vscode.commands.registerCommand("amulet.reloadPi", () => this.reloadPi()),
      vscode.commands.registerCommand("amulet.manageExtensions", () => this.manageExtensions()),
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
    this.managePanel?.dispose();
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

  /* ------------------------------------------------------------ resources */

  /**
   * Re-read Pi's extensions, skills, prompts and context files.
   *
   * Guarded, because reloading is not free: mid-response it throws away work the user is waiting
   * for, and mid-compaction it replaces the transcript while that rewrite is still running.
   */
  private async reloadPi(): Promise<void> {
    const worker = await this.ensureWorker();
    if (!worker) return;
    let state: SessionState;
    try {
      state = await worker.command<SessionState>({ id: randomUUID(), type: "getState" });
    } catch (error) {
      return void this.report(error);
    }
    if (state.isCompacting) {
      void vscode.window.showInformationMessage("Wait for compaction to finish before reloading.");
      return;
    }
    const interrupting = state.isStreaming || state.isRetrying;
    const choice = await vscode.window.showWarningMessage(
      interrupting
        ? "Reload Pi config? This will restart Pi and cancel any ongoing work."
        : "Reload Pi config? This re-reads extensions, skills, prompts and context files.",
      { modal: true },
      interrupting ? "Reload and cancel work" : "Reload",
    );
    if (choice !== "Reload" && choice !== "Reload and cancel work") return;
    await this.chatView.reload();
    await this.managePanel?.refresh();
  }

  /** What Pi loaded, and what it could not load, in an editor tab. */
  private async manageExtensions(): Promise<void> {
    if (!this.managePanel) {
      this.managePanel = new ManagePanel({
        resources: async () => {
          const worker = await this.ensureWorker();
          if (!worker) throw new Error("The agent is not running for this workspace.");
          return worker.command<ResourceReport>({ id: randomUUID(), type: "getResources" });
        },
        reload: () => this.reloadPi(),
        openFile: async filePath => {
          // Built-in extensions name no file on disk, so there is nothing to open.
          if (!filePath || filePath.startsWith("builtin:")) return;
          const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
          await vscode.window.showTextDocument(document, vscode.ViewColumn.Beside);
        },
        openSettings: async () => {
          await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:amulet.amulet");
        },
      });
      this.extensionContext.subscriptions.push(this.managePanel);
    }
    this.managePanel.show();
  }

  private report(error: unknown): void {
    void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
  }

  private async runCommand(command: WorkerCommand): Promise<void> {
    const worker = await this.ensureWorker();
    if (!worker) return;
    try {
      const data = await worker.command<unknown>(command);
      // A change made from the palette is the same change the chat header reports; without this the
      // view would keep showing the model or session the user just left behind.
      if (data && typeof data === "object" && "sessionId" in data) this.chatView.pushState(data as SessionState);
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  private async pickSession(): Promise<void> {
    const worker = await this.ensureWorker();
    if (!worker) return;
    type SessionItem = { path: string; id: string; name?: string; messageCount: number; modified: string; firstMessage: string; current: boolean };
    let sessions: SessionItem[] = [];
    try {
      sessions = await worker.command<SessionItem[]>({ id: randomUUID(), type: "listSessions" });
    } catch (error) {
      return void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    }
    // Newest first, and the open one marked: the list is how a user recognises a session, so the
    // one they are already in has to be obvious rather than merely present.
    const items = [...sessions]
      .sort((a, b) => b.modified.localeCompare(a.modified))
      .map(session => ({
        label: session.name || session.firstMessage.slice(0, 60) || session.id,
        description: [
          session.current ? "current" : undefined,
          `${session.messageCount} message${session.messageCount === 1 ? "" : "s"}`,
          new Date(session.modified).toLocaleString(),
        ]
          .filter(Boolean)
          .join(" · "),
        detail: session.path,
        session,
      }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Open a session", matchOnDescription: true });
    if (!picked) return;
    await this.runCommand({ id: randomUUID(), type: "switchSession", sessionPath: picked.session.path });
  }

  /** The worker's current state, or nothing if it will not answer. Never throws. */
  private async currentState(): Promise<SessionState | undefined> {
    const worker = await this.ensureWorker();
    if (!worker) return undefined;
    try {
      return await worker.command<SessionState>({ id: randomUUID(), type: "getState" });
    } catch {
      return undefined;
    }
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
    const current = await this.currentState();
    // Ordered by what the user can actually pick: the model in play, then everything signed in to,
    // then the rest. A flat alphabetical list of 1 600 models is a search box, not a menu.
    const ordered = [...models].sort((a, b) => {
      const rank = (model: ModelItem) => (current && `${current.model?.provider}/${current.model?.id}` === `${model.provider}/${model.id}` ? 0 : model.available ? 1 : 2);
      return rank(a) - rank(b) || a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name);
    });
    const picked = await vscode.window.showQuickPick(
      ordered.map(model => ({
        label: model.available ? model.name : `$(circle-slash) ${model.name}`,
        description: [
          current && `${current.model?.provider}/${current.model?.id}` === `${model.provider}/${model.id}` ? "current" : undefined,
          `${model.provider}/${model.id}`,
        ]
          .filter(Boolean)
          .join(" · "),
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

  /**
   * Offer only the levels the current model supports. `xhigh` on a model with three tiers is a
   * menu of things that will not happen, and the worker would silently clamp the choice anyway.
   */
  private async pickThinkingLevel(): Promise<void> {
    const worker = await this.ensureWorker();
    if (!worker) return;
    let current: SessionState | undefined;
    try {
      current = await worker.command<SessionState>({ id: randomUUID(), type: "getState" });
    } catch {
      /* fall back to the full list if the worker will not answer */
    }
    const levels = current?.availableThinkingLevels?.length ? current.availableThinkingLevels : THINKING_LEVELS;
    const items = levels.map(level => ({
      label: level,
      description: level === current?.thinkingLevel ? "current" : level === "off" ? "no reasoning" : undefined,
      level,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select a thinking level" });
    if (!picked) return;
    await this.runCommand({ id: randomUUID(), type: "setThinkingLevel", level: picked.level });
  }
}

export function deactivate(): void {
  /* disposal happens through the extension context subscriptions */
}
