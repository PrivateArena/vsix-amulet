/**
 * Host integration smoke test — runs WITHOUT VS Code.
 *
 *   node test/host-activate.cjs [cwd]
 *
 * It loads the built extension bundle against a minimal `vscode` API stub, resolves the chat
 * view (which is what starts an agent worker), sends one prompt through the same message shape
 * the webview uses, and waits for the reply. It makes a real model call.
 *
 * What it proves: activation, settings plumbing, worker spawn, the webview command path, event
 * fan-out, and streaming reconstruction. It does not prove rendering, which needs a real window.
 */
const Module = require("node:module");
const path = require("node:path");
const process = require("node:process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");

// Throwaway workspace + session store: never the user's real transcripts.
const sandbox = mkdtempSync(path.join(tmpdir(), "amulet-host-smoke-"));

/* ------------------------------------------------------------------ vscode stub */

const registered = { views: [], commands: new Map(), outputChannels: [] };
const webviews = [];

class Disposable {
  constructor(action = () => {}) {
    this.action = action;
  }
  dispose() {
    this.action();
  }
}

const Uri = {
  joinPath: (base, ...segments) => ({ ...base, fsPath: path.join(base.fsPath, ...segments), toString: () => path.join(base.fsPath, ...segments) }),
  file: fsPath => ({ fsPath, scheme: "file", toString: () => fsPath }),
};

const vscode = {
  Disposable,
  Uri,
  ViewColumn: { One: 1 },
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: section => ({
      get(key, fallback) {
        const values = {
          "worker.maxOldSpaceMB": 0,
          autoCompact: true,
          autoRetry: true,
          restoreLastSession: false, // fresh session each run, so the test is repeatable
          agentDir: "",
          sessionDir: path.join(sandbox, "sessions"),
          model: "",
          thinkingLevel: "",
        };
        const value = values[`${section === "amulet" ? "" : ""}${key}`] ?? values[key];
        return value === undefined ? fallback : value;
      },
    }),
  },
  window: {
    createOutputChannel: name => {
      const channel = { name, lines: [], appendLine(text) { this.lines.push(text); }, show() {} };
      registered.outputChannels.push(channel);
      return channel;
    },
    registerWebviewViewProvider: (id, provider) => {
      registered.views.push({ id, provider });
      return new Disposable();
    },
    showWarningMessage: () => Promise.resolve(undefined),
    showInformationMessage: () => Promise.resolve(undefined),
    showErrorMessage: message => {
      lastError = message;
      return Promise.resolve(undefined);
    },
    showQuickPick: () => Promise.resolve(undefined),
    showInputBox: () => Promise.resolve(undefined),
  },
  commands: {
    registerCommand: (id, handler) => {
      registered.commands.set(id, handler);
      return new Disposable();
    },
    executeCommand: () => Promise.resolve(),
  },
};

let lastError = "";

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") return vscode;
  return originalLoad.apply(this, arguments);
};

/* ------------------------------------------------------------------ fake view */

function createFakeView() {
  const listeners = [];
  const view = {
    visible: true,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview:",
      asWebviewUri: uri => uri.toString(),
      postMessage: message => {
        hostReceived.push(message);
        settleWaiters(message);
      },
      onDidReceiveMessage: listener => {
        listeners.push(listener);
        return new Disposable();
      },
    },
    onDidDispose: () => new Disposable(),
  };
  const hostReceived = [];
  const waiters = [];
  function settleWaiters(message) {
    for (const waiter of [...waiters]) {
      if (waiter.predicate(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }
  view.send = message => listeners.forEach(listener => listener(message));
  view.waitFor = (predicate, label, timeoutMs = 120_000) =>
    new Promise((resolve, reject) => {
      const hit = hostReceived.find(predicate);
      if (hit) return resolve(hit);
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
      waiters.push({ predicate, resolve: message => (clearTimeout(timer), resolve(message)) });
    });
  return view;
}

/* ------------------------------------------------------------------ run */

const cwd = sandbox;
vscode.workspace.workspaceFolders = [{ uri: Uri.file(cwd), name: path.basename(cwd), index: 0 }];

const extension = require("../dist/extension.cjs");
const context = {
  extensionPath: path.resolve(__dirname, ".."),
  extensionUri: Uri.file(path.resolve(__dirname, "..")),
  subscriptions: [],
  globalState: { get: () => undefined, update: () => Promise.resolve() },
};

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

void run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

async function run() {
extension.activate(context);

const commands = [...registered.commands.keys()];
check("commands registered", commands.length >= 8, commands.join(", "));
check("chat view registered", registered.views[0]?.id === "amulet.chatView", registered.views[0]?.id);

const view = createFakeView();
registered.views[0].provider.resolveWebviewView(view);
check(
  "webview html has csp + module script",
  /Content-Security-Policy/.test(view.webview.html) && /dist\/webview\.js/.test(view.webview.html),
);

// The view announces itself, exactly like src/webview/main.ts does.
view.send({ type: "ready" });

const statusSeen = await view.waitFor(
  message => message.type === "workerStatus" && message.status === "ready",
  "worker ready",
  60_000,
);
check("worker reached ready", statusSeen.status === "ready", statusSeen.status);

const stateEvent = await view.waitFor(message => message.type === "state", "initial state", 60_000);
check("session has a model", Boolean(stateEvent.state.model), stateEvent.state.model ? `${stateEvent.state.model.provider}/${stateEvent.state.model.id}` : "none");

view.send({ type: "command", name: "prompt", payload: { text: "Reply with exactly: host-smoke-ok" } });

const settled = await view.waitFor(
  message => message.type === "event" && message.event.type === "agent_settled",
  "agent_settled",
  180_000,
);
check("run settled", Boolean(settled));

const assistantTurn = await view.waitFor(
  message => message.type === "event" && message.event.type === "message_end" && message.event.message?.role === "assistant",
  "assistant message_end",
  30_000,
);
const text = JSON.stringify(assistantTurn.event.message);
check("reply contains the expected token", text.includes("host-smoke-ok"), text.slice(0, 200));

check("no error dialog shown", lastError === "", lastError);

for (const disposable of context.subscriptions) disposable.dispose?.();
console.log(failures === 0 ? "\nHOST SMOKE OK" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
setTimeout(() => process.exit(), 500).unref();
}
