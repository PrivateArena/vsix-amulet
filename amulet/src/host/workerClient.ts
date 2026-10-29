/**
 * Host side of the agent worker: one forked Node process per workspace folder.
 *
 * Responsibilities the worker cannot have: knowing whether it died (restart + crash recovery),
 * owning the log channel, and answering extension UI requests with real editor dialogs.
 */
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import process from "node:process";
import * as vscode from "vscode";
import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  SessionState,
  WorkerCommand,
  WorkerConfig,
  WorkerResponse,
  WorkerUplink,
} from "../shared/protocol.js";

export interface WorkerEvents {
  onEvent(listener: (event: Extract<WorkerUplink, { type: "event" }>) => void): vscode.Disposable;
  onState(listener: (state: SessionState) => void): vscode.Disposable;
  onStatus(listener: (status: WorkerStatus, detail?: string) => void): vscode.Disposable;
  onLog(listener: (level: "info" | "warn" | "error", text: string) => void): vscode.Disposable;
}

export type WorkerStatus = "starting" | "ready" | "restarting" | "stopped" | "failed";

type Listener<T> = Set<(value: T) => void>;

export class AgentWorkerClient implements vscode.Disposable {
  private process?: ChildProcess;
  private readonly pending = new Map<string, { resolve: (value: unknown) => void; reject: (reason: Error) => void; command: WorkerCommand }>();
  private readonly events: Listener<Extract<WorkerUplink, { type: "event" }>> = new Set();
  private readonly states: Listener<SessionState> = new Set();
  private readonly statuses = new Set<(status: WorkerStatus, detail?: string) => void>();
  private readonly logs = new Set<(level: "info" | "warn" | "error", text: string) => void>();
  private workerStatus: WorkerStatus = "stopped";
  private restarts = 0;
  private stopping = false;

  constructor(
    private readonly entryPoint: string,
    private readonly config: WorkerConfig,
    private readonly options: { maxOldSpaceMB?: number } = {},
  ) {}

  get status(): WorkerStatus {
    return this.workerStatus;
  }

  get cwd(): string {
    return this.config.cwd;
  }

  /* ------------------------------------------------------------ subscription */

  onEvent(listener: (event: Extract<WorkerUplink, { type: "event" }>) => void) {
    this.events.add(listener);
    return new vscode.Disposable(() => {
      this.events.delete(listener);
    });
  }

  onState(listener: (state: SessionState) => void) {
    this.states.add(listener);
    return new vscode.Disposable(() => {
      this.states.delete(listener);
    });
  }

  onStatus(listener: (status: WorkerStatus, detail?: string) => void) {
    this.statuses.add(listener);
    listener(this.workerStatus);
    return new vscode.Disposable(() => {
      this.statuses.delete(listener);
    });
  }

  onLog(listener: (level: "info" | "warn" | "error", text: string) => void) {
    this.logs.add(listener);
    return new vscode.Disposable(() => {
      this.logs.delete(listener);
    });
  }

  /* ------------------------------------------------------------ process control */

  async start(): Promise<void> {
    if (this.process) return;
    this.setStatus("starting");
    const execArgv: string[] = [];
    if (this.options.maxOldSpaceMB && this.options.maxOldSpaceMB > 0) execArgv.push(`--max-old-space-size=${this.options.maxOldSpaceMB}`);
    execArgv.push("--max-semi-space-size=2");

    const childProcess = fork(this.entryPoint, [], {
      cwd: this.config.cwd,
      execArgv,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: { ...process.env, AMULET_WORKER: "1" },
    });
    this.process = childProcess;

    childProcess.stderr?.setEncoding("utf8");
    childProcess.stderr?.on("data", (chunk: string) => this.emitLog("info", chunk.trimEnd()));

    childProcess.on("message", message => this.receive(message as WorkerUplink));
    childProcess.on("error", error => {
      this.emitLog("error", `worker process error: ${error.message}`);
      this.setStatus("failed", error.message);
    });
    childProcess.on("exit", (code, signal) => {
      const reason = this.stopping ? "stopped" : `${signal ? `signal ${signal}` : `exit code ${code}`}`;
      for (const [, entry] of this.pending) entry.reject(new Error(`Agent worker ${reason}.`));
      this.pending.clear();
      this.process = undefined;
      if (this.stopping) {
        this.setStatus("stopped");
        return;
      }
      // Crash recovery: restart with the same session file, bounded retries so a hard crash
      // loop cannot spawn processes forever.
      if (this.restarts >= MAX_AUTOMATIC_RESTARTS) {
        this.setStatus("failed", `worker stopped repeatedly (${reason}); restart it from the command palette.`);
        return;
      }
      this.restarts += 1;
      this.setStatus("restarting", `agent worker ${reason} — restarting`);
      void this.restartAfterCrash();
    });

    const state = await this.command<SessionState>({ id: randomUUID(), type: "initialize", ...this.config });
    this.restarts = 0;
    this.setStatus("ready");
    this.emitState(state);
  }

  private async restartAfterCrash(): Promise<void> {
    await delay(RESTART_BACKOFF_MS * this.restarts);
    if (this.stopping) return;
    try {
      await this.start();
    } catch (error) {
      this.setStatus("failed", error instanceof Error ? error.message : String(error));
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const running = this.process;
    if (!running) {
      this.setStatus("stopped");
      return;
    }
    try {
      await this.command({ id: randomUUID(), type: "shutdown" });
    } catch {
      /* it is about to die anyway */
    }
    await delay(150);
    if (!running.killed) running.kill("SIGTERM");
    this.setStatus("stopped");
  }

  dispose(): void {
    void this.stop();
    for (const set of [this.events, this.states, this.statuses, this.logs]) set.clear();
  }

  /* ------------------------------------------------------------ commands */

  async command<T>(command: WorkerCommand): Promise<T> {
    if (!this.process) throw new Error("The agent worker is not running.");
    return await new Promise<T>((resolve, reject) => {
      this.pending.set(command.id, { resolve: resolve as (value: unknown) => void, reject, command });
      this.process!.send!(command);
    });
  }

  /** Fire a command and swallow "not ready" errors — used for best-effort UI refreshes. */
  async tryCommand(command: WorkerCommand): Promise<void> {
    try {
      await this.command(command);
    } catch (error) {
      this.emitLog("warn", `${command.type} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private receive(message: WorkerUplink): void {
    if (!message || typeof message !== "object") return;
    switch (message.type) {
      case "response":
        return this.settle(message as WorkerResponse);
      case "event":
        for (const listener of this.events) listener(message);
        return;
      case "state":
        return this.emitState(message.state);
      case "ready":
        return this.emitState(message.state);
      case "log":
        return this.emitLog(message.level, message.text);
      case "extension_ui_request":
        return void this.answerDialog(message);
      default:
        return;
    }
  }

  private settle(response: WorkerResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) return;
    this.pending.delete(response.id);
    if (response.ok) entry.resolve(response.data);
    else entry.reject(new Error(response.error));
  }

  private emitState(state: SessionState): void {
    for (const listener of this.states) listener(state);
  }

  private emitLog(level: "info" | "warn" | "error", text: string): void {
    for (const listener of this.logs) listener(level, text);
  }

  private setStatus(status: WorkerStatus, detail?: string): void {
    this.workerStatus = status;
    for (const listener of this.statuses) listener(status, detail);
  }

  /* ------------------------------------------------------------ extension UI */

  /**
   * Pi extensions running in the worker ask the editor for input. `input`/`select`/`confirm`
   * block the agent, so they must always be answered — including on dismiss, which is a
   * cancellation rather than an error.
   */
  private async answerDialog(request: ExtensionUiRequest): Promise<void> {
    const requestId = request.id;
    const send = (response: ExtensionUiResponse) => {
      this.process?.send(response);
    };
    try {
      switch (request.method) {
        case "notify":
          void vscode.window.showInformationMessage(request.message, { modal: false });
          return send({ id: request.id, type: "extension_ui_response", confirmed: true });
        case "setStatus":
          return send({ id: request.id, type: "extension_ui_response", confirmed: true });
        case "setWidget":
          return send({ id: request.id, type: "extension_ui_response", confirmed: true });
        case "setTitle":
          return send({ id: request.id, type: "extension_ui_response", confirmed: true });
        case "input": {
          const value = await vscode.window.showInputBox({ prompt: request.title, placeHolder: request.placeholder, ignoreFocusOut: true });
          return value === undefined
            ? send({ id: request.id, type: "extension_ui_response", cancelled: true })
            : send({ id: request.id, type: "extension_ui_response", value });
        }
        case "select": {
          const value = await vscode.window.showQuickPick(request.options, { title: request.title, ignoreFocusOut: true });
          return value === undefined
            ? send({ id: request.id, type: "extension_ui_response", cancelled: true })
            : send({ id: request.id, type: "extension_ui_response", value });
        }
        case "confirm": {
          const value = await vscode.window.showWarningMessage(request.message, { modal: true, detail: request.title }, "Yes", "No");
          return value === undefined
            ? send({ id: request.id, type: "extension_ui_response", cancelled: true })
            : send({ id: request.id, type: "extension_ui_response", confirmed: value === "Yes" });
        }
        case "editor": {
          const document = await vscode.workspace.openTextDocument({ content: request.prefill ?? "", language: "markdown" });
          const edit = await vscode.window.showTextDocument(document);
          const value = edit.document.getText();
          await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
          return send({ id: request.id, type: "extension_ui_response", value });
        }
        default:
          return send({ id: requestId, type: "extension_ui_response", cancelled: true });
      }
    } catch (error) {
      this.emitLog("error", `extension dialog failed: ${error instanceof Error ? error.message : String(error)}`);
      send({ id: requestId, type: "extension_ui_response", cancelled: true });
    }
  }
}

export function resolveWorkerEntry(extensionRoot: string): string {
  const candidate = `${extensionRoot}/dist/worker.mjs`;
  if (!existsSync(candidate)) throw new Error(`Amulet worker bundle is missing at ${candidate}. Run "npm run build".`);
  return candidate;
}

const MAX_AUTOMATIC_RESTARTS = 3;
const RESTART_BACKOFF_MS = 750;

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
