/**
 * Worker process entry point.
 *
 * Everything here is about being a well-behaved child process: never write to stdout (the
 * editor owns the IPC channel, and stray dependency logging must not become protocol noise),
 * report fatal errors before dying, and let the parent notice the exit.
 */
import process from "node:process";
import { AgentWorker } from "./agentWorker.js";
import type { ExtensionUiResponse, WorkerCommand, WorkerUplink } from "../shared/protocol.js";

const write = (streamNode: NodeJS.WriteStream, args: unknown[]) =>
  streamNode.write(`${args.map(format).join(" ")}\n`);

function format(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// Diagnostics only ever go to stderr.
console.log = (...args: unknown[]) => write(process.stderr, args);
console.info = console.log;
console.debug = console.log;
console.warn = (...args: unknown[]) => write(process.stderr, [`[warn]`, ...args]);
console.error = (...args: unknown[]) => write(process.stderr, [`[error]`, ...args]);

function send(message: WorkerUplink): void {
  if (!process.send) return;
  try {
    process.send(message);
  } catch {
    /* parent gone; the exit handler does the reporting */
  }
}

const worker = new AgentWorker({ send });

process.on("message", raw => {
  const message = raw as WorkerCommand | ExtensionUiResponse;
  if (!message || typeof message !== "object") return;
  if (message.type === "extension_ui_response") {
    worker.resolveDialog(message);
    return;
  }
  void worker.handle(message as WorkerCommand);
});

process.on("uncaughtException", error => {
  send({ type: "log", level: "error", text: `worker crashed: ${format(error)}` });
  process.exit(1);
});

process.on("unhandledRejection", reason => {
  send({ type: "log", level: "error", text: `unhandled rejection: ${format(reason)}` });
});

send({ type: "log", level: "info", text: `agent worker started (pid ${process.pid}, node ${process.version})` });

// The parent drives everything through `initialize`; an idle worker with no session is normal
// during startup and after a crash restart.
void workerReady();

async function workerReady(): Promise<void> {
  // Nothing to do until a workspace is known. Kept as a hook point for prewarm work
  // (model catalog, credential probe) once the host asks for it.
}
