/**
 * Manual integration harness: drives dist/worker.mjs exactly like the extension host does.
 *
 *   node test/smoke-worker.mjs [cwd] [--prompt "text"]
 *
 * It makes a real model call, so it is the check that "the product actually talks to a
 * provider", not just that the code compiles.
 */
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const argv = process.argv.slice(2);
const cwdIndex = argv.indexOf("--prompt");
const promptText = cwdIndex >= 0 ? String(argv[cwdIndex + 1] ?? "Reply with exactly: ok") : "Reply with exactly: ok";

// A throwaway workspace with its own session directory: the harness must never touch the
// user's real transcripts, and it must be able to assert on a known-empty history.
const sandbox = mkdtempSync(path.join(tmpdir(), "amulet-smoke-"));
const cwd = path.resolve(argv.find(arg => !arg.startsWith("--") && arg !== promptText) ?? sandbox);
const sessionDir = path.join(sandbox, "sessions");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const worker = fork(new URL("../dist/worker.mjs", import.meta.url).pathname, [], {
  cwd,
  stdio: ["ignore", "ignore", "pipe", "ipc"],
});

let settled = false;
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

worker.stderr?.setEncoding("utf8");
worker.stderr?.on("data", chunk => process.stderr.write(`  worker: ${chunk}`));

worker.on("message", message => {
  if (message?.type === "event") {
    const event = message.event;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      console.log(`\n[tool] ${event.toolName} ${JSON.stringify(event.args).slice(0, 120)}`);
    } else if (event.type === "agent_settled") {
      settled = true;
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

await command({ type: "shutdown" }, 10_000);
worker.kill();
console.log(failures === 0 ? "\nWORKER SMOKE OK" : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 && settled ? 0 : 1;
