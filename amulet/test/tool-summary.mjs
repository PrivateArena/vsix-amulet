/**
 * Tool call summary tests — no model calls, no VS Code, no DOM.
 *
 *   node test/tool-summary.mjs
 *
 * These pin what a card says about a call. The inputs here are deliberately worse than anything the
 * SDK sends: arguments and results cross two process boundaries and can arrive half-written, so the
 * module must degrade to a readable card instead of throwing away the turn.
 */
import assert from "node:assert/strict";
import { MAX_OUTPUT_CHARS, clipOutput, summarizeToolCall } from "../src/shared/toolSummary.ts";

let failures = 0;
const test = (name, fn) => {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${error instanceof Error ? error.message : String(error)}`);
  }
};

const text = value => ({ type: "text", text: value });
const image = { type: "image", data: "cGk=", mimeType: "image/png" };
const run = (name, args, result, isError = false) => summarizeToolCall(name, args, result, isError);

/* ------------------------------------------------------------------ bash */

test("a successful command shows the command, and an exit code of zero is not news", () => {
  const card = run("bash", { command: "npm test" }, [text("> vitest run\n\nTests 12 passed")]);
  assert.equal(card.title, "bash npm test");
  assert.equal(card.meta, undefined);
  assert.equal(card.bodyKind, "command");
  assert.match(card.body, /^npm test/);
  assert.match(card.body, /Tests 12 passed/);
  assert.equal(card.failed, false);
});

test("a failing command reports its exit code and keeps the command in the body", () => {
  const card = run("bash", { command: "npm test" }, [text("FAIL  src/cart.test.ts\n\nCommand exited with code 1")], true);
  assert.equal(card.failed, true);
  assert.equal(card.meta, "exit 1");
  assert.match(card.body, /^npm test/, "the command must survive the error rewrite");
  assert.match(card.body, /Command exited with code 1/);
});

test("a multi-line command still fits on one line", () => {
  const card = run("bash", { command: "cd packages/core\nnpm run build" }, [text("ok")]);
  assert.equal(card.title, "bash cd packages/core; npm run build");
});

/* ------------------------------------------------------------------ read */

test("read summarises the whole file by line count", () => {
  const card = run("read", { path: "src/host/extension.ts" }, [text("line\n".repeat(128))]);
  assert.equal(card.title, "read src/host/extension.ts");
  assert.equal(card.meta, "128 lines");
});

test("read with an offset reports the range it covered", () => {
  const card = run("read", { path: "a.ts", offset: 51, limit: 60 }, [text("x\n".repeat(60))]);
  assert.equal(card.meta, "lines 51-110");
});

test("a one-line read says line, not lines", () => {
  const card = run("read", { path: "a.ts", offset: 5, limit: 1 }, [text("only this")]);
  assert.equal(card.meta, "line 5");
});

test("a long path keeps its tail, which is what identifies it", () => {
  const card = run("read", { path: "/home/dev/projects/monorepo/services/gateway/src/handler.ts" }, [text("x")]);
  assert.match(card.title, /src\/handler\.ts$/);
  assert.ok(card.title.length < "read /home/dev/projects/monorepo/services/gateway/src/handler.ts".length);
});

/* ------------------------------------------------------------------ edit and write */

test("edit counts added and removed lines and shows a diff", () => {
  const card = run(
    "edit",
    {
      path: "src/cart.ts",
      edits: [
        { oldText: "const a = 1;\nconst b = 2;", newText: "const a = 3;\nconst b = 2;\nconst c = 4;" },
        { oldText: "gone", newText: "kept" },
      ],
    },
    [text("Successfully applied 2 edits")],
  );
  assert.equal(card.title, "edit src/cart.ts");
  // edit 1: `a = 1` replaced and `c = 4` added (+2 -1); edit 2: one line swapped (+1 -1).
  assert.equal(card.meta, "+3 \u22122");
  assert.equal(card.bodyKind, "diff");
  assert.match(card.body, /@@ edit 1 of 2/);
  assert.match(card.body, /@@ edit 2 of 2/);
  assert.match(card.body, /^\+const c = 4;/m);
  assert.match(card.body, /^-gone$/m);
});

test("a line shared with the original is not counted as changed", () => {
  // Only the middle line differs: a diff that trimmed prefixes and suffixes alone would report the
  // whole block as rewritten, and the card would then disagree with the diff view.
  const card = run("edit", { path: "a.ts", edits: [{ oldText: "one\ntwo\nthree\nfour\nfive", newText: "one\ntwo\nTHREE\nfour\nfive" }] }, [text("ok")]);
  assert.equal(card.meta, "+1 \u22121");
  assert.match(card.body, /^ two$/m);
  assert.match(card.body, /^\u2026$/m);
});

test("the legacy single-edit shape still produces a diff", () => {
  const card = run("edit", { path: "a.ts", oldText: "one", newText: "two" }, [text("ok")]);
  assert.equal(card.meta, "+1 \u22121");
  assert.match(card.body, /@@ a\.ts/);
});

test("write shows the content it wrote", () => {
  const card = run("write", { path: "notes.md", content: "# Title\n\nbody" }, [text("File written")]);
  assert.equal(card.title, "write notes.md");
  assert.equal(card.meta, "3 lines");
  assert.match(card.body, /# Title/);
});

test("an empty write says created", () => {
  assert.equal(run("write", { path: "empty.txt", content: "" }, [text("ok")]).meta, "created");
});

/* ------------------------------------------------------------------ search and listing */

test("grep counts matches and names the directory", () => {
  const card = run("grep", { pattern: "TODO", path: "src" }, [text("src/a.ts:3: TODO fix\nsrc/b.ts:9: TODO remove")]);
  assert.equal(card.title, "grep TODO in src");
  assert.equal(card.meta, "2 matches");
});

test("an empty grep says so in the tool's own words", () => {
  assert.equal(run("grep", { pattern: "nothing" }, [text("No matches found")]).meta, "0 matches");
});

test("find counts files", () => {
  assert.equal(run("find", { pattern: "**/*.ts" }, [text("a.ts\nb.ts\nc.ts")]).meta, "3 files");
});

test("ls counts entries and the trailing notice is not one of them", () => {
  const card = run("ls", { path: "src" }, [text("a.ts\nb.ts\n\n[2 entries limited to 2]")]);
  assert.equal(card.meta, "2 entries");
});

/* ------------------------------------------------------------------ extension tools */

test("an unknown tool shows its own arguments", () => {
  const card = run("deploy", { env: "staging", dryRun: true, secret: "x".repeat(200) }, [text("queued")]);
  assert.equal(card.title, "deploy env=staging dryRun=true");
  assert.match(card.body, /"env": "staging"/);
  assert.match(card.body, /queued/);
});

test("an unknown tool with no arguments is still titled", () => {
  assert.equal(run("pi").title, "pi");
});

/* ------------------------------------------------------------------ awkward transports */

test("a result that is a bare string", () => {
  const card = run("bash", { command: "echo hi" }, "hi");
  assert.match(card.body, /hi/);
});

test("a result that is the worker envelope", () => {
  const card = run("read", { path: "a.ts" }, { content: [text("one\n")] });
  assert.equal(card.meta, "1 line");
});

test("images are announced, never inlined as base64", () => {
  const card = run("read", { path: "pic.png" }, [text("Read image file [image/png]"), image]);
  assert.match(card.body, /\[1 image\]/);
  assert.ok(!card.body.includes("cGk="), "image data must not reach the transcript view");
});

test("an error result without an exit code shows the message as the meta", () => {
  const card = run("read", { path: "missing.ts" }, [text("ENOENT: no such file or directory\n  at read")], true);
  assert.equal(card.failed, true);
  assert.equal(card.meta, "ENOENT: no such file or directory");
  assert.match(card.body, /at read/);
});

test("junk crosses the boundary without throwing", () => {
  const circular = { name: "loop" };
  circular.self = circular;
  const junk = [null, undefined, 42, "text", true, [], [1, 2], circular, () => 0];
  for (const args of junk) {
    for (const result of junk) {
      for (const name of ["bash", "read", "edit", "grep", "whatever"]) {
        const card = summarizeToolCall(name, args, result, false);
        assert.ok(typeof card.title === "string" && card.title.length > 0, `${name} produced an empty title`);
        assert.equal(typeof card.failed, "boolean");
      }
    }
  }
});

/* ------------------------------------------------------------------ clipping */

test("output is collapsed and clipped, and the notice stays inside the budget", () => {
  const clipped = clipOutput("\n\n\na\n\n\n\nb\n\n\n", 200);
  assert.equal(clipped, "a\n\nb");
  const long = clipOutput("x".repeat(MAX_OUTPUT_CHARS * 2), 100);
  assert.ok(long.length <= 100, `clipped to ${long.length} characters`);
  assert.match(long, /more characters clipped/);
});

console.log(failures === 0 ? "\nTOOL SUMMARY OK" : `\n${failures} test(s) failed`);
process.exitCode = failures ? 1 : 0;
