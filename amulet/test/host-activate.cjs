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
const { mkdtempSync, writeFileSync, readdirSync } = require("node:fs");
const { tmpdir } = require("node:os");

// Throwaway workspace + session store: never the user's real transcripts.
const sandbox = mkdtempSync(path.join(tmpdir(), "amulet-host-smoke-"));
writeFileSync(path.join(sandbox, "note.txt"), "line one\nline two\nline three\n");
writeFileSync(path.join(sandbox, "src-deep.ts"), "export const value = 1;\nexport const other = 2;\n");

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
  file: fsPath => ({ fsPath, scheme: "file", toString: () => `file://${fsPath}` }),
  parse: value => Uri.file(String(value).replace(/^file:\/\//, "")),
};

const vscode = {
  Disposable,
  Uri,
  ViewColumn: { One: 1 },
  Range: class {
    constructor(sl, sc, el, ec) {
      this.start = new vscode.Position(sl, sc);
      this.end = new vscode.Position(el, ec);
    }
  },
  Position: class {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  },
  Selection: class {
    constructor(start, end) {
      this.start = start;
      this.end = end;
      this.isEmpty = start.line === end.line && start.character === end.character;
    }
  },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  RelativePattern: class {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  workspace: {
    workspaceFolders: undefined,
    textDocuments: [],
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
          attachSelectionOnFocus: false,
          attachActiveFile: false,
          disableFileReferences: false,
          pasteBadgeThreshold: 700,
        };
        const value = overrides[key] !== undefined ? overrides[key] : values[key];
        return value === undefined ? fallback : value;
      },
    }),
    findFiles: async include => {
      // Walk the real sandbox so the picker test exercises a real search result.
      const base = typeof include?.base === "string" ? include.base : sandbox;
      const out = [];
      const walk = dir => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.name === "sessions") continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else out.push(Uri.file(full));
        }
      };
      walk(base);
      return out;
    },
    openTextDocument: async uri => ({ uri, getText: () => fs.readFileSync(uri.fsPath, "utf8") }),
  },
  window: {
    activeTextEditor: undefined,
    onDidChangeActiveTextEditor: () => new Disposable(),
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
    showTextDocument: async doc => ({ document: doc, selection: undefined, revealRange() {} }),
  },
  languages: {
    getDiagnostics: () => diagnosticPairs,
  },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  commands: {
    registerCommand: (id, handler) => {
      registered.commands.set(id, handler);
      return new Disposable();
    },
    executeCommand: () => Promise.resolve(),
  },
};

const diagnosticPairs = [];
/** Settings the test flips mid-run, standing in for the user editing them. */
const overrides = {};

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
  view.messages = hostReceived;
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

/* ------------------------------------------------------------------ context assembly */

function fakeEditorWithSelection(relativePath, dirty = true) {
  const body = ["const scratch = 1;", "return scratch;", "unused"];
  // A real document slices by the requested range; the host asks for the selection, never the file.
  const document = {
    uri: Uri.file(path.join(sandbox, relativePath)),
    isDirty: dirty,
    getText: range => (range ? body.slice(range.start.line, range.end.line + 1) : body).join("\n"),
  };
  vscode.workspace.textDocuments = dirty ? [document] : [];
  vscode.window.activeTextEditor = {
    document,
    selection: new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(1, 14)),
  };
  return body;
}

fakeEditorWithSelection("scratch.ts");
await registered.commands.get("amulet.attachSelection")();
const selectionAppend = await view.waitFor(
  message => message.type === "contextAppend" && message.fragment.selections?.length,
  "selection context",
  10_000,
);
check(
  "an editor selection becomes a ranged reference",
  selectionAppend.fragment.files[0] === "scratch.ts:1-2",
  JSON.stringify(selectionAppend.fragment.files),
);
check(
  "unsaved lines travel as text, because nothing else can re-read them",
  selectionAppend.fragment.selections[0].text === "const scratch = 1;\nreturn scratch;",
  selectionAppend.fragment.selections[0].text,
);
check("and are marked as coming from an unsaved buffer", selectionAppend.fragment.selections[0].reason === "unsaved");

// Auto-attach on focus must respect what the user already did by hand: the same selection that
// was added explicitly must not be added a second time, but a new selection must be.
const appendsBefore = view.messages.filter(message => message.type === "contextAppend").length;
overrides.attachSelectionOnFocus = true;
view.send({ type: "composerFocused" });
await new Promise(resolve => setTimeout(resolve, 400));
check(
  "focus does not re-add the selection that is already attached",
  view.messages.filter(message => message.type === "contextAppend").length === appendsBefore,
  `${view.messages.filter(message => message.type === "contextAppend").length} vs ${appendsBefore}`,
);

vscode.window.activeTextEditor.selection = new vscode.Selection(new vscode.Position(1, 0), new vscode.Position(2, 6));
view.send({ type: "composerFocused" });
const refocused = await view.waitFor(
  message => message.type === "contextAppend" && message.fragment.files?.[0] === "scratch.ts:2-3",
  "a new selection after refocus",
  10_000,
);
check("a different selection is picked up on focus", refocused.fragment.selections[0].lineRange === "2-3");
fakeEditorWithSelection("scratch.ts"); // restore a dirty buffer for the send below

// Removing a chip has to stick, or the auto-attach would fight the user.
view.send({ type: "contextDismissed", labels: ["scratch.ts:2-3"] });
view.send({ type: "composerFocused" });
await new Promise(resolve => setTimeout(resolve, 400));
check(
  "a dismissed selection stays dismissed until the selection changes again",
  view.messages.filter(message => message.type === "contextAppend" && message.fragment.files?.[0] === "scratch.ts:2-3").length === 1,
);

view.send({ type: "searchFiles", requestId: "r1", query: "note" });
const results = await view.waitFor(message => message.type === "fileResults" && message.requestId === "r1", "file search results", 10_000);
check("the @ picker finds workspace files", results.items.includes("note.txt"), `items=${JSON.stringify(results.items)} error=${results.error ?? "none"}`);

view.send({ type: "attachUris", uris: [Uri.file(path.join(sandbox, "note.txt")).toString()] });
await view.waitFor(
  message => message.type === "contextAppend" && message.fragment.files?.includes("note.txt"),
  "dropped file context",
  10_000,
);
check("a dropped file attaches as a path reference", true);

diagnosticPairs.push([
  Uri.file(path.join(sandbox, "src-deep.ts")),
  [{ message: "Cannot  find\nname 'x'", severity: 0, range: { start: { line: 1, character: 0 } }, code: "TS2304", source: "ts" }],
]);
vscode.window.activeTextEditor = undefined; // no active file: take what every language server reported
await registered.commands.get("amulet.attachProblems")();
const problemAppend = await view.waitFor(
  message => message.type === "contextAppend" && message.fragment.problems?.length,
  "problem context",
  10_000,
);
check("problems attach with file, line and severity", problemAppend.fragment.problems[0]?.path === "src-deep.ts", JSON.stringify(problemAppend.fragment.problems));
check("a multi-line diagnostic message is folded to one line", !problemAppend.fragment.problems[0].message.includes("\n"));

const draft = {
  files: [...selectionAppend.fragment.files, "note.txt:2-3"],
  selections: selectionAppend.fragment.selections,
  quotes: [{ text: "Expected 3, received 2", source: "m1" }],
  problems: problemAppend.fragment.problems,
  notes: [{ path: "note.txt", note: "legacy file" }],
};
view.send({ type: "prompt", text: "Why does @src-deep.ts fail? Reply with exactly: host-smoke-ok", context: draft, images: [] });

const userTurn = await view.waitFor(
  message =>
    message.type === "event" &&
    (message.event.type === "message_start" || message.event.type === "message_end") &&
    message.event.message?.role === "user",
  "the user message the worker received",
  180_000,
);
const sent = userTurn.event.message.content.filter(block => block.type === "text").map(block => block.text).join("");
check("the message is preceded by a context block", sent.startsWith("--- pi-extension-context:start ---"), sent.slice(0, 60));
const userPart = sent.split("--- pi-extension-context:end ---\n\n")[1] ?? "";
check("the user's own words follow the block", userPart.includes("Why does @src-deep.ts fail?"), userPart.slice(0, 80));
check("attached files are listed as references", /@note\.txt:2-3/.test(sent) && /@src-deep\.ts/.test(sent));
check("a range readable from disk is quoted from disk", /<file name="note.txt" lines="2-3">\nline two\nline three\n<\/file>/.test(sent));
check("the unsaved selection is quoted from the buffer", sent.includes("const scratch = 1;"));
check("a quote from the transcript is included", sent.includes('<quote source="m1">\nExpected 3, received 2\n</quote>'));
check("problems are included", sent.includes(`<problem file="src-deep.ts" line="2" severity="error" code="TS2304" source="ts">Cannot find name 'x'</problem>`), sent.match(/<problem[^>]*>[^<]*/)?.[0]);
check("file notes are included", sent.includes('{"path":"note.txt","note":"legacy file"}'));
check("tags appear in the documented order", sent.indexOf("<file-context>") < sent.indexOf("<editor-context>"));

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
