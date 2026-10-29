/**
 * Manual integration harness: drives dist/worker.mjs exactly like the extension host does.
 *
 *   node test/smoke-worker.mjs [cwd] [--prompt "text"]
 *
 * It makes a real model call, so it is the check that "the product actually talks to a
 * provider", not just that the code compiles.
 */
import { fork } from "node:child_process";
import { summarizeToolCall } from "../src/shared/toolSummary.ts";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const cwdIndex = argv.indexOf("--prompt");
const promptText = cwdIndex >= 0 ? String(argv[cwdIndex + 1] ?? "Reply with exactly: ok") : "Reply with exactly: ok";

// A throwaway workspace with its own session directory: the harness must never touch the
// user's real transcripts, and it must be able to assert on a known-empty history.
const sandbox = mkdtempSync(path.join(tmpdir(), "amulet-smoke-"));
// A file with known contents, so the tool turn below can be asserted on rather than hoped for.
writeFileSync(path.join(sandbox, "note.txt"), "line one\nline two\nline three\n");
const cwd = path.resolve(argv.find(arg => !arg.startsWith("--") && arg !== promptText) ?? sandbox);
const sessionDir = path.join(sandbox, "sessions");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/** AMULET_WORKER points at a bundle elsewhere, such as the one unpacked from a .vsix. */
const workerEntry = process.env.AMULET_WORKER ?? new URL("../dist/worker.mjs", import.meta.url).pathname;
const worker = fork(workerEntry, [], {
  cwd,
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});

let settled = false;
let settleCount = 0;
const command = (extra, timeoutMs = 120_000) =>
  new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => reject(new Error(`${extra.type} timed out`)), timeoutMs);
    const onMessage = message => {
      if (message?.type !== "response" || message.id !== id) return;
      clearTimeout(timer);
      worker.off("message", onMessage);
      message.ok ? resolve(message.data) : reject(new Error(message.error));
    };
    worker.on("message", onMessage);
    worker.send({ id, ...extra });
  });

/** Tool calls exactly as they crossed the wire, for the card assertions at the end. */
const calls = new Map();

worker.stderr?.setEncoding("utf8");
worker.stderr?.on("data", chunk => process.stderr.write(`  worker: ${chunk}`));

worker.on("message", message => {
  if (message?.type === "event") {
    const event = message.event;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      console.log(`\n[tool] ${event.toolName} ${JSON.stringify(event.args).slice(0, 120)}`);
      calls.set(event.toolCallId, { name: event.toolName, args: event.args });
    } else if (event.type === "tool_execution_end") {
      const call = calls.get(event.toolCallId) ?? { name: event.toolName, args: undefined };
      calls.set(event.toolCallId, { ...call, result: event.result, isError: event.isError });
    } else if (event.type === "agent_settled") {
      settled = true;
      settleCount += 1;
    } else if (event.type === "extension_error") {
      console.log(`\n[extension error] ${event.error}`);
    }
  } else if (message?.type === "log") {
    console.log(`\n[log ${message.level}] ${message.text}`);
  } else if (message?.type === "state") {
    console.log(`\n[state] model=${message.state.model?.provider}/${message.state.model?.id} messages=${message.state.messageCount}`);
  }
});

worker.on("exit", (code, signal) => {
  console.log(`\nworker exited (${signal ?? code})`);
  if (!settled) process.exit(1);
});

console.log(`cwd: ${cwd}\nsessions: ${sessionDir}`);
const state = await command({ type: "initialize", cwd, sessionDir, continueLast: false });
check("starts with an empty history", state.messageCount === 0, `messages=${state.messageCount}`);
console.log(`ready: session=${state.sessionId} model=${state.model ? `${state.model.provider}/${state.model.id}` : "none"} tools=${state.activeTools.join(",") || "none"}`);

const models = await command({ type: "listModels" });
console.log(`models: ${models.length} (${models.filter(m => m.available).map(m => m.provider).filter((v, i, a) => a.indexOf(v) === i).join(", ")} authenticated)`);

await command({ type: "prompt", text: promptText });
console.log("\n(streaming…)");

const deadline = Date.now() + 180_000;
while (!settled && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
if (!settled) console.error("\nFAIL: the run never settled");

// Second turn, this one that cannot be answered without a tool: the card layer is only tested
// against argument and result shapes the SDK really sent.
await command({ type: "prompt", text: "Use the read tool on note.txt, then tell me its second line." });
console.log("\n(streaming, tool turn…)");
const toolDeadline = Date.now() + 180_000;
while (settleCount < 2 && Date.now() < toolDeadline) await new Promise(resolve => setTimeout(resolve, 100));
if (settleCount < 2) console.error("\nFAIL: the tool turn never settled");

const stats = await command({ type: "getState" });
console.log(`\ndone: messages=${stats.messageCount} context=${Math.round(stats.contextUsage?.percent ?? 0)}%`);

// Persistence: a new session must be empty, and switching back must recover the transcript.
const originalFile = stats.sessionFile;
const fresh = await command({ type: "newSession" });
check("new session starts empty", fresh.messageCount === 0, `messages=${fresh.messageCount}`);
check("new session is a different session", fresh.sessionFile !== originalFile, `${originalFile} -> ${fresh.sessionFile}`);

if (originalFile) {
  const back = await command({ type: "switchSession", sessionPath: originalFile });
  check("switching back recovers the transcript", back.messageCount >= stats.messageCount, `messages=${back.messageCount}`);
  const recovered = await command({ type: "getMessages" });
  check(
    "recovered transcript carries the model reply",
    JSON.stringify(recovered).includes(promptText.replace(/^Reply with exactly: /, "").trim()),
    `${recovered.length} messages`,
  );
}

const sessions = await command({ type: "listSessions" });
check("session list is populated", Array.isArray(sessions) && sessions.length > 0, `${sessions.length} sessions`);
check(
  "the list marks which session is open",
  sessions.some(session => session.current) && sessions.filter(session => session.current).every(session => session.path === originalFile),
  `${sessions.filter(session => session.current).length} marked current`,
);

/* What the card layer will be handed for the calls that really ran. */
const cards = [...calls.values()].map(call => summarizeToolCall(call.name, call.args, call.result, call.isError === true));
console.log(`cards: ${cards.map(card => `${card.title}${card.meta ? ` [${card.meta}]` : ""}`).join(" | ")}`.slice(0, 220));
check("every call produced a titled card", cards.length > 0 && cards.every(card => card.title.trim().length > 3), `${cards.length} calls`);
check("a card names what it operated on, not only the tool", cards.every(card => /[./\s]/.test(card.title)), cards.map(card => card.title).join(" | ").slice(0, 120));
check("a finished card has something to expand or a count to show", cards.every(card => card.body || card.meta), cards.filter(card => !card.body && !card.meta).map(card => card.title).join(", "));
check("no card leaks the raw argument object", !cards.some(card => (card.body ?? "").includes('"path":') && card.title.includes("{")), "");
const readCard = cards.find(card => card.title.startsWith("read"));
check("a real read call reads as `read <path>` with a line count", readCard && /note\.txt/.test(readCard.title) && /\d+ lines?/.test(readCard.meta ?? ""), `${readCard?.title} · ${readCard?.meta}`);
check("its body is the file, not a summary of it", readCard && /line two/.test(readCard.body ?? ""), (readCard?.body ?? "").slice(0, 40));

const resources = await command({ type: "getResources" });
console.log(
  `resources: extensions=${resources.extensions.length} skills=${resources.skills.length} prompts=${resources.prompts.length} errors=${resources.errors.length} configured=${resources.configuredExtensions.length}`,
);
check("the resource report has the shape the panel renders", ["extensions", "errors", "skills", "prompts", "configuredExtensions"].every(key => Array.isArray(resources[key])), Object.keys(resources).join(","));
check("every reported extension is named and traceable", resources.extensions.every(extension => extension.name && extension.path), "");
check("a failing extension says so instead of vanishing", resources.extensions.every(extension => typeof extension.error === "string" || extension.error === undefined), "");

const reloaded = await command({ type: "reload" });
check(
  "reload leaves a working session behind",
  Boolean(reloaded.state?.sessionId) && reloaded.state.messageCount === stats.messageCount,
  `messages=${reloaded.state?.messageCount}`,
);
const afterReload = await command({ type: "getResources" });
check("resources survive a reload", Array.isArray(afterReload.extensions) && afterReload.extensions.length === resources.extensions.length, `${afterReload.extensions.length} extensions`);

await command({ type: "shutdown" }, 10_000);
worker.kill();
console.log(failures === 0 ? "\nWORKER SMOKE OK" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 && settled ? 0 : 1;
