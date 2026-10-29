/**
 * Tool call summaries — what one tool call looks like as a card.
 *
 * A turn contains dozens of calls and the interesting part is almost never the raw JSON: for `read`
 * it is the range, for `edit` the +N −M, for `bash` the exit code. Deciding that here keeps the
 * webview a dumb renderer and lets the host reuse the same rules for toasts and logs.
 *
 * Every input crossed two process boundaries and is whatever the model, an extension or a streaming
 * partial happened to produce, so nothing is trusted to match the tool schema: nothing here throws,
 * and no call produces an empty title. A wrong card is recoverable; a blank one is not. Pure and
 * dependency-free, like contextBlock.ts — the tests import it directly, no DOM, no SDK.
 */

import type { ContentBlock } from "./protocol.js";

export interface ToolCard {
  /** One line, e.g. `read src/host/extension.ts` or `bash npm test`. Never empty. */
  title: string;
  /** Short right-aligned facts, e.g. `128 lines`, `exit 1`, `+9 −3`, `3 matches`. Optional. */
  meta?: string;
  /** The body shown when the card is expanded. Omitted when there is nothing to expand. */
  body?: string;
  /** How to render `body`. */
  bodyKind?: "output" | "diff" | "command";
  /** True when the call failed; the card is drawn as an error. */
  failed: boolean;
}

type TextBlock = Extract<ContentBlock, { type: "text" }>;
type BodyKind = NonNullable<ToolCard["bodyKind"]>;

/** Default body budget: enough for a stack trace, small enough to scroll past. */
export const MAX_OUTPUT_CHARS = 8_000;
const MAX_TITLE_CHARS = 200;
const MAX_ARG_CHARS = 48;
const MAX_ERROR_META_CHARS = 80;
/** Longer paths keep only their tail: two segments place a file in a workspace, the head says "some disk". */
const MAX_PATH_CHARS = 40;
const MAX_DIFF_LINE_CHARS = 200;
const DIFF_CONTEXT_LINES = 2;

/** A tool's own contribution, before the error and image rules are applied. */
interface Draft {
  title: string;
  meta?: string;
  body?: string;
  bodyKind?: BodyKind;
  /** True when `meta` already explains a failure, so the error text must not overwrite it. */
  diagnosed?: boolean;
}

/* ------------------------------------------------------------------ narrowing */

const asObject = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

const whole = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : undefined;

/** Never cut a surrogate pair in half: a lone high surrogate arrives as U+FFFD downstream anyway. */
const cut = (value: string, limit: number): string =>
  value.length <= limit ? value : value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "\uFFFD");

const oneLine = (value: string, limit: number): string => cut(value.replace(/\s*(?:\r?\n)+\s*/g, " ").trim(), limit);

/** `2 lines`, `1 line` — a card that reads "1 lines" is a card that was never looked at. */
const count = (value: number, noun: string): string => `${value} ${noun}${value === 1 ? "" : "s"}`;

const joinTitle = (...parts: (string | undefined)[]): string => oneLine(parts.filter(Boolean).join(" "), MAX_TITLE_CHARS);

/** Shell-style join: a multi-line command still has to fit on the card's one line. */
const toOneCommand = (value: string): string =>
  value
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .join("; ");

/** Tail of a path, so a long absolute path stays meaningful instead of being cut from the wrong end. */
function displayPath(value: string): string {
  const path = value.trim();
  if (path.length <= MAX_PATH_CHARS) return path;
  const parts = path.split(/[/\\]+/).filter(Boolean);
  return parts.length > 2 ? oneLine(parts.slice(-2).join("/"), MAX_PATH_CHARS) : cut(oneLine(path, MAX_PATH_CHARS), MAX_PATH_CHARS);
}

/* ------------------------------------------------------------------ result content */

interface Result {
  text: string;
  images: number;
}

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return "[unserializable value]"; // circular input degrades to a placeholder instead of throwing
  }
};

/** Text of one content block, tolerantly: the schema says `type:"text"`, extensions just say `text`. */
const blockText = (block: unknown): string | undefined => {
  const candidate = asObject(block) as Partial<TextBlock>;
  return typeof candidate.text === "string" ? candidate.text : typeof block === "string" ? block : undefined;
};

/**
 * Collect a tool result's text, whatever shape it arrived in: an array of content blocks, a bare
 * string, the `{ content: [...] }` envelope the worker forwards, or nothing at all.
 */
function readResult(value: unknown, depth = 0): Result {
  if (value === null || value === undefined) return { text: "", images: 0 };
  if (typeof value === "string") return { text: value, images: 0 };
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return { text: String(value), images: 0 };
  if (Array.isArray(value)) {
    const chunks: string[] = [];
    let images = 0;
    for (const block of value) {
      // An image carries no text, but dropping it silently would misreport what the model saw.
      if (asObject(block).type === "image") {
        images += 1;
        continue;
      }
      const chunk = blockText(block);
      if (chunk !== undefined) chunks.push(chunk);
      else if (block !== null && block !== undefined) chunks.push(safeJson(block));
    }
    return { text: chunks.join("\n"), images };
  }
  const object = asObject(value);
  // The SDK envelope; `depth` stops a self-referential `content` from looping.
  if (object.content !== undefined && depth < 2) return readResult(object.content, depth + 1);
  if (object.type === "image") return { text: "", images: 1 };
  for (const key of ["text", "error", "message", "output"] as const) {
    const field = text(object[key]);
    if (field !== undefined) return { text: field, images: 0 };
  }
  return { text: safeJson(value), images: 0 };
}

const linesOf = (value: string, dropNotice = false): string[] => {
  const lines = value.replace(/\s+$/, "").split("\n").filter(line => line.trim() !== "");
  // The built-in tools append a trailing `[...]` notice; counting it as a match or entry would lie.
  if (dropNotice && lines.length > 0 && /^\[.*\]$/.test((lines[lines.length - 1] ?? "").trim())) lines.pop();
  return lines;
};

/* ------------------------------------------------------------------ clipping */

/** Collapse runs of blank lines, clip to `maxChars` and say so. Used for output bodies. */
export function clipOutput(value: string, maxChars = MAX_OUTPUT_CHARS): string {
  const collapsed = (typeof value === "string" ? value : safeJson(value)).replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const given = whole(maxChars) ?? MAX_OUTPUT_CHARS;
  const limit = given > 0 ? given : MAX_OUTPUT_CHARS;
  if (collapsed.length <= limit) return collapsed;
  // The notice is inside the budget, so the caller can rely on `maxChars` as a real ceiling.
  const kept = cut(collapsed, limit - Math.min(48, Math.floor(limit / 2)));
  return `${kept}\n\n[… ${collapsed.length - kept.length} more characters clipped …]`;
}

/* ------------------------------------------------------------------ per-tool drafts
 * Argument names were verified against the Pi SDK's tool schemas (`core/tools/*.js`) rather than
 * guessed: bash{command,timeout}, read{path,offset,limit}, edit{path,edits[{oldText,newText}]},
 * write{path,content}, grep{pattern,path,glob,ignoreCase,literal}, find{pattern,path}, ls{path,limit}.
 * `read`'s offset is 1-indexed, so offset 51 with limit 60 covers lines 51-110.
 */

/** Body plus its renderer, or nothing at all when there is nothing worth expanding. */
const bodyOf = (value: string, kind: BodyKind): Pick<Draft, "body" | "bodyKind"> =>
  value.trim() ? { body: clipOutput(value), bodyKind: kind } : {};

/** A tool's result text is the payload for tools whose input is only a path or a pattern. */
const outputDraft = (title: string, result: Result, meta?: string): Draft => ({ title, ...(meta ? { meta } : {}), ...bodyOf(result.text, "output") });

/** `path:12: text` is a grep match line; a bare path is one file. */
const MATCH_LINE = /:\d+:/;
const EXIT_PATTERN = /(?:command exited with code|exited with code|exit code:?|exit status)\s*(-?\d+)/gi;

function bashDraft(name: string, args: Record<string, unknown>, result: Result): Draft {
  const command = text(args.command) ?? text(args.cmd) ?? "";
  const codes = [...result.text.matchAll(EXIT_PATTERN)];
  const code = codes.length > 0 ? Number(codes[codes.length - 1]?.[1]) : undefined;
  return {
    title: joinTitle(name, toOneCommand(command)),
    // Only a non-zero exit is news; `exit 0` on every successful call would be noise.
    ...(code ? { meta: `exit ${code}`, diagnosed: true } : {}),
    // The command is what the card promised and the output what the user came to read, so the body
    // shows both — command first, because it explains everything below it.
    ...bodyOf(result.text.trim() ? `${command}\n\n${result.text}` : command, "command"),
  };
}

function readDraft(args: Record<string, unknown>, result: Result): Draft {
  const offset = whole(args.offset);
  const limit = whole(args.limit);
  const shown = result.text.trim() ? linesOf(result.text, true).length : 0;
  const start = Math.max(offset ?? 1, 1);
  // Prefer what the result actually shows; fall back to the requested size while the call is running.
  const rows =
    offset === undefined && limit === undefined ? shown : shown > 0 ? Math.min(limit ?? shown, shown) : (limit ?? 1);
  return {
    title: joinTitle("read", displayPath(text(args.path) ?? "")),
    ...(offset === undefined && limit === undefined
      ? shown > 0
        ? { meta: count(shown, "line") }
        : {}
      : { meta: rows <= 1 ? `line ${start}` : `lines ${start}-${start + rows - 1}` }),
    ...bodyOf(result.text, "output"),
  };
}

/** `edits[]` is the schema; top-level `oldText`/`newText` is the legacy form the SDK still accepts. */
function editPairs(args: Record<string, unknown>): { oldText: string; newText: string }[] {
  const pairs: { oldText: string; newText: string }[] = [];
  for (const entry of Array.isArray(args.edits) ? args.edits : []) {
    const item = asObject(entry);
    const oldText = text(item.oldText);
    const newText = text(item.newText);
    if (oldText !== undefined && newText !== undefined) pairs.push({ oldText, newText });
  }
  const legacyOld = text(args.oldText);
  const legacyNew = text(args.newText);
  if (pairs.length === 0 && legacyOld !== undefined && legacyNew !== undefined) pairs.push({ oldText: legacyOld, newText: legacyNew });
  return pairs;
}

type Op = { kind: " " | "+" | "-"; line: string };

const toLines = (value: string): string[] => value.replace(/\r\n?/g, "\n").split("\n");

/**
 * Line diff by longest common subsequence, because the card has to agree with the diff view the
 * user will open next: trimming only shared prefixes and suffixes would call a two-line change in a
 * six-line block "6 removed, 6 added".
 */
function diffOps(before: string[], after: string[]): Op[] {
  // O(n·m) memory is the limit here, not CPU: an edit that rewrites 2 000 lines at once is not worth
  // a table, and a single replacement block describes it honestly enough.
  if (before.length * after.length > 1_000_000) {
    return [...before.map(line => ({ kind: "-" as const, line })), ...after.map(line => ({ kind: "+" as const, line }))];
  }
  const columns = after.length + 1;
  const table = new Uint32Array((before.length + 1) * columns);
  const lineAt = (list: string[], index: number): string => list[index] ?? "";
  const cell = (index: number): number => table[index] ?? 0;
  for (let row = before.length - 1; row >= 0; row -= 1) {
    for (let column = after.length - 1; column >= 0; column -= 1) {
      table[row * columns + column] =
        lineAt(before, row) === lineAt(after, column)
          ? cell((row + 1) * columns + column + 1) + 1
          : Math.max(cell((row + 1) * columns + column), cell(row * columns + column + 1));
    }
  }
  const ops: Op[] = [];
  let row = 0;
  let column = 0;
  while (row < before.length && column < after.length) {
    const previous = lineAt(before, row);
    const next = lineAt(after, column);
    if (previous === next) {
      ops.push({ kind: " ", line: previous });
      row += 1;
      column += 1;
    } else if (cell((row + 1) * columns + column) >= cell(row * columns + column + 1)) {
      ops.push({ kind: "-", line: previous });
      row += 1;
    } else {
      ops.push({ kind: "+", line: next });
      column += 1;
    }
  }
  while (row < before.length) ops.push({ kind: "-", line: lineAt(before, row++) });
  while (column < after.length) ops.push({ kind: "+", line: lineAt(after, column++) });
  return ops;
}

/** Keep the changed lines plus a little context either side, and mark the gaps that were skipped. */
function renderDiff(ops: Op[], label: string): string[] {
  const keep = new Set<number>();
  ops.forEach((op, index) => {
    if (op.kind === " ") return;
    for (let at = Math.max(0, index - DIFF_CONTEXT_LINES); at < Math.min(ops.length, index + DIFF_CONTEXT_LINES + 1); at += 1) keep.add(at);
  });
  if (keep.size === 0) return [];
  const lines = [`@@ ${label}`];
  let previous = -2;
  for (const index of [...keep].sort((a, b) => a - b)) {
    const op = ops[index];
    if (!op) continue;
    if (index !== previous + 1) lines.push("\u2026");
    lines.push(`${op.kind}${cut(op.line, MAX_DIFF_LINE_CHARS)}`);
    previous = index;
  }
  return lines;
}

function diffPair(oldText: string, newText: string, label: string): { added: number; removed: number; lines: string[] } {
  const ops = diffOps(toLines(oldText), toLines(newText));
  return {
    added: ops.filter(op => op.kind === "+").length,
    removed: ops.filter(op => op.kind === "-").length,
    lines: renderDiff(ops, label),
  };
}

function editDraft(args: Record<string, unknown>, result: Result): Draft {
  const path = displayPath(text(args.path) ?? "");
  const pairs = editPairs(args);
  const parts = pairs.map((pair, index) => diffPair(pair.oldText, pair.newText, pairs.length > 1 ? `edit ${index + 1} of ${pairs.length}` : path || "edit"));
  const added = parts.reduce((total, part) => total + part.added, 0);
  const removed = parts.reduce((total, part) => total + part.removed, 0);
  const diff = parts.flatMap(part => part.lines);
  return {
    title: joinTitle("edit", path),
    // U+2212, so `+9 −3` reads as a pair of counts rather than as arithmetic.
    ...(pairs.length > 0 ? { meta: `+${added} \u2212${removed}` } : {}),
    ...(diff.length > 0 ? bodyOf(diff.join("\n"), "diff") : bodyOf(result.text, "output")),
  };
}

function writeDraft(args: Record<string, unknown>, result: Result): Draft {
  // The result is only a confirmation, so the content the model wrote is the interesting half of a
  // write — and the only place it survives, once the message has scrolled away.
  const content = text(args.content) ?? result.text;
  const lines = content.trim() ? content.replace(/\s+$/, "").split("\n").length : 0;
  return { title: joinTitle("write", displayPath(text(args.path) ?? "")), meta: lines === 0 ? "created" : `${lines} lines`, ...bodyOf(content, "output") };
}

/** Search and listing tools: the shape of the result text is the whole story. `empty` is the SDK's own "nothing found" wording. */
function listDraft(title: string, result: Result, unit: "match" | "file" | "entry", empty: string): Draft {
  const lines = linesOf(result.text, true);
  const plural = { match: "matches", file: "files", entry: "entries" }[unit];
  if (lines.length === 0 || (lines[0] ?? "").toLowerCase().startsWith(empty)) return outputDraft(title, result, `0 ${plural}`);
  // With context lines the count of `path:line:` rows is the honest number; otherwise every row is one.
  const matches = unit === "match" ? lines.filter(line => MATCH_LINE.test(line)).length || lines.length : lines.length;
  return outputDraft(title, result, `${matches} ${plural}`);
}

/** Extension-registered tools: no schema to lean on, so show the call itself. */
function genericDraft(name: string, args: Record<string, unknown>, result: Result): Draft {
  const pairs: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const scalar = typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
    if (scalar === undefined) continue;
    const flat = oneLine(scalar, MAX_ARG_CHARS);
    pairs.push(`${key}=${/\s/.test(flat) ? `"${flat}"` : flat}`);
    if (pairs.length >= 2) break;
  }
  const input = Object.keys(args).length > 0 ? safeJson(args) : "";
  return { title: joinTitle(name, ...pairs), ...bodyOf([input, result.text.trim()].filter(Boolean).join("\n\n"), "output") };
}

function buildDraft(toolName: string, args: Record<string, unknown>, result: Result): Draft {
  switch (toolName) {
    // The SDK builds bash and its shell siblings from one schema, so they summarise identically.
    case "bash":
    case "shell":
    case "powershell":
      return bashDraft(toolName, args, result);
    case "read":
      return readDraft(args, result);
    case "edit":
      return editDraft(args, result);
    case "write":
      return writeDraft(args, result);
    case "grep": {
      const path = text(args.path)?.trim();
      const pattern = text(args.pattern)?.trim();
      return listDraft(joinTitle("grep", pattern && cut(pattern, MAX_ARG_CHARS), path && `in ${displayPath(path)}`), result, "match", "no matches");
    }
    case "find":
      return listDraft(joinTitle("find", text(args.pattern)?.trim() && cut(text(args.pattern)!.trim(), MAX_ARG_CHARS)), result, "file", "no files");
    case "ls": {
      const dir = displayPath(text(args.path)?.trim() ?? "") || ".";
      return listDraft(joinTitle("ls", dir), result, "entry", "(empty");
    }
    default:
      return genericDraft(toolName, args, result);
  }
}

/* ------------------------------------------------------------------ the card */

/** First non-empty line of the error, cleaned and short enough to sit on the card's right edge. */
function errorMeta(value: string): string {
  const first = value.split("\n").map(line => line.trim()).find(Boolean) ?? "";
  return first ? `${cut(oneLine(first, MAX_ERROR_META_CHARS), MAX_ERROR_META_CHARS)}${first.length > MAX_ERROR_META_CHARS ? "\u2026" : ""}` : "failed";
}

export function summarizeToolCall(name: string, args: unknown, resultContent: unknown, isError: boolean): ToolCard {
  const toolName = (typeof name === "string" ? name : "").trim().toLowerCase() || "tool";
  const result = readResult(resultContent);
  const draft = buildDraft(toolName, asObject(args), result);

  let body = draft.body ?? "";
  if (isError) {
    // The error text leads the body: a clipped body must still contain the whole message, and the
    // tool's own command or diff stays below it because it explains what the failure was about.
    const detail = result.text.trim();
    body = detail && !body.includes(detail) ? [detail, body].filter(Boolean).join("\n\n") : body;
  }
  if (result.images > 0) body = [body, `[${result.images} image${result.images === 1 ? "" : "s"}]`].filter(Boolean).join("\n\n");

  const card: ToolCard = { title: draft.title || toolName, failed: isError === true };
  const meta = isError && !draft.diagnosed ? errorMeta(result.text) : draft.meta;
  if (meta) card.meta = meta;
  if (body.trim()) {
    card.body = clipOutput(body);
    card.bodyKind = isError ? "output" : (draft.bodyKind ?? "output");
  }
  return card;
}
