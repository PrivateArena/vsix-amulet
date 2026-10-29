/**
 * Context assembly — the one format the agent ever sees.
 *
 * Everything the user attaches is rendered into a single marked block placed in front of the
 * message. Inside the block each kind of context has its own tag, always in the same order:
 * file references, then inlined selections, then quotes, then problems, then per-file notes.
 * Parts with nothing to say are left out; images travel beside the text, never inside the block.
 *
 * Files travel as *references* — a workspace-relative path, plus a line range when the user
 * attached a selection — because the agent reads files with its own tools and therefore always
 * sees current disk content. Lines that cannot be re-read from disk (an unsaved buffer, a range
 * in a diff, a passage of the transcript) are quoted inline instead.
 *
 * This module is pure and dependency-free: the webview, the host and the tests all share it, and
 * nothing here touches VS Code or the SDK.
 */

export const CONTEXT_START = "--- pi-extension-context:start ---";
export const CONTEXT_END = "--- pi-extension-context:end ---";

/** Budgets for inlined selections: one range, all ranges, whole block. */
export const MAX_SELECTION_CHARS = 40_000;
export const MAX_SELECTION_ITEMS = 20;
export const MAX_CONTEXT_CHARS = 80_000;

const MAX_PATH_CHARS = 4_096;

/* ------------------------------------------------------------------ pieces */

/** A file, or a range of one, as it appears in `<file-context>`: `src/a.ts` / `src/a.ts:12-30`. */
export interface FileReference {
  /** Workspace-relative path, optionally `:START` or `:START-END`. */
  label: string;
}

/** Lines copied into the message because the agent could not re-read them from disk. */
export interface QuotedLines {
  path: string;
  lineRange: string;
  text: string;
  truncated?: boolean;
  /** Why the text is inline rather than a reference. */
  reason?: "unsaved" | "diff" | "transcript" | "outside-workspace";
}

/** A passage of the transcript or of a reply the user selected. */
export interface QuotedText {
  text: string;
  /** Session entry id the quote came from, so its badge can scroll back to the passage. */
  source?: string;
  /** `path:lines` the quote came from, when it came from an editor or a diff. */
  origin?: string;
}

export type ProblemSeverity = "error" | "warning" | "info" | "hint";

export interface ProblemEntry {
  path: string;
  line: number;
  severity: ProblemSeverity;
  message: string;
  code?: string;
  source?: string;
}

/** A user's note about one attached file. */
export interface FileNote {
  path: string;
  note: string;
}

/** Everything the composer can hold. Mirrors what the UI shows as chips. */
export interface ContextDraft {
  files: string[];
  selections: QuotedLines[];
  quotes: QuotedText[];
  problems: ProblemEntry[];
  notes: FileNote[];
}

export const emptyDraft = (): ContextDraft => ({ files: [], selections: [], quotes: [], problems: [], notes: [] });

export const hasDraft = (draft: ContextDraft | undefined): boolean =>
  Boolean(draft) &&
  (draft!.files.length + draft!.selections.length + draft!.quotes.length + draft!.problems.length + draft!.notes.length > 0);

/** A partial draft, used when one entry point adds only some kinds of context. */
export type ContextFragment = Partial<Omit<ContextDraft, "files">> & { files?: string[] };

export function mergeDraft(base: ContextDraft, fragment: ContextFragment): ContextDraft {
  const draft: ContextDraft = {
    files: [...base.files],
    selections: [...base.selections],
    quotes: [...base.quotes],
    problems: [...base.problems],
    notes: [...base.notes],
  };
  for (const label of fragment.files ?? []) if (!draft.files.includes(label)) draft.files.push(label);
  for (const selection of fragment.selections ?? []) {
    if (!isValidQuotedLines(selection)) continue;
    const key = `${selection.path}:${selection.lineRange}`;
    const at = draft.selections.findIndex(existing => `${existing.path}:${existing.lineRange}` === key);
    if (at >= 0) draft.selections[at] = selection;
    else draft.selections.push(selection);
  }
  for (const quote of fragment.quotes ?? []) {
    if (!quote.text.trim()) continue;
    if (!draft.quotes.some(existing => existing.text === quote.text && existing.source === quote.source)) draft.quotes.push(quote);
  }
  for (const problem of fragment.problems ?? []) {
    if (!isValidProblem(problem)) continue;
    if (!draft.problems.some(existing => sameProblem(existing, problem))) draft.problems.push(problem);
  }
  for (const note of fragment.notes ?? []) {
    if (!isValidFileNote(note) || !note.note.trim()) continue;
    const at = draft.notes.findIndex(existing => existing.path === note.path);
    if (at >= 0) draft.notes[at] = note;
    else draft.notes.push(note);
  }
  return draft;
}

const sameProblem = (a: ProblemEntry, b: ProblemEntry): boolean =>
  a.path === b.path && a.line === b.line && a.message === b.message && a.severity === b.severity;

/* ------------------------------------------------------------------ labels */

export interface ParsedLabel {
  path: string;
  lineRange: string;
  start: number;
  end: number;
}

/** `src/a.ts:12-30` -> parts, or null when the label is not a usable file reference. */
export function parseLabel(label: string): ParsedLabel | null {
  if (typeof label !== "string" || !label || label.length > MAX_PATH_CHARS || label.includes("\0") || label.endsWith("/")) return null;
  // The range is the *last`:`group, so paths that contain colons (Windows drives, odd names) survive.
  const match = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(label);
  if (!match) return null;
  const path = match[1];
  if (!path) return null;
  if (!match[2]) return { path, lineRange: "", start: 0, end: 0 };
  const start = Number(match[2]);
  const end = match[3] === undefined ? start : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return null;
  return { path, lineRange: match[3] === undefined ? `${start}` : `${start}-${end}`, start, end };
}

export const formatLabel = (path: string, start?: number, end?: number): string =>
  start === undefined ? path : `${path}:${start}${end !== undefined && end !== start ? `-${end}` : ""}`;

/** A range is singular when it covers one line, which the block renders as `:12`, not `:12-12`. */
export const rangeText = (start: number, end: number): string => (start === end ? `${start}` : `${start}-${end}`);

/* ------------------------------------------------------------------ validation */

export function isValidQuotedLines(value: unknown): value is QuotedLines {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    candidate.path.length <= MAX_PATH_CHARS &&
    !candidate.path.includes("\0") &&
    typeof candidate.lineRange === "string" &&
    parseLabel(`${candidate.path}:${candidate.lineRange}`) !== null &&
    typeof candidate.text === "string" &&
    candidate.text.length <= MAX_SELECTION_CHARS + 1
  );
}

export function isValidQuotedText(value: unknown): value is QuotedText {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.text === "string" && candidate.text.length <= MAX_CONTEXT_CHARS * 2 && candidate.text.trim().length > 0;
}

export function isValidProblem(value: unknown): value is ProblemEntry {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    candidate.path.length <= MAX_PATH_CHARS &&
    !candidate.path.includes("\0") &&
    typeof candidate.line === "number" &&
    Number.isSafeInteger(candidate.line) &&
    candidate.line >= 0 &&
    typeof candidate.severity === "string" &&
    ["error", "warning", "info", "hint"].includes(candidate.severity as string) &&
    typeof candidate.message === "string" &&
    candidate.message.length <= 2_000
  );
}

export function isValidFileNote(value: unknown): value is FileNote {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.path === "string" &&
    candidate.path.length > 0 &&
    candidate.path.length <= MAX_PATH_CHARS &&
    !candidate.path.includes("\0") &&
    typeof candidate.note === "string" &&
    candidate.note.length <= MAX_CONTEXT_CHARS
  );
}

/** Drop anything unusable before it reaches the block; a hostile webview cannot inject tags. */
export function sanitizeDraft(draft: ContextDraft): ContextDraft {
  const files = draft.files.filter(label => parseLabel(label) !== null);
  return {
    files,
    selections: draft.selections.filter(isValidQuotedLines).slice(0, MAX_SELECTION_ITEMS),
    quotes: draft.quotes.filter(isValidQuotedText),
    problems: draft.problems.filter(isValidProblem),
    notes: draft.notes.filter(isValidFileNote),
  };
}

/* ------------------------------------------------------------------ escaping
 *
 * Attached content is untrusted: a file can contain the block's own delimiters. Escaping is the
 * difference between "the model sees a weird quote" and "an attachment ends the block and speaks
 * as the user". Line-leading lookalikes are neutralised too, which is what keeps a quoted snippet
 * that happens to start with the delimiter from being read as one.
 */

const escapeText = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Break a lookalike delimiter without changing what the model reads, by using an entity for
    // its first character only.
    .replace(/^--- pi-extension-context:(start|end) ---/gim, "&#45;-- pi-extension-context:$1 ---");

const escapeAttribute = (value: string): string =>
  escapeText(value).replace(/"/g, "&quot;").replace(/\n/g, "&#10;").replace(/\r/g, "&#13;").replace(/\t/g, "&#9;");

export const unescapeContextText = (value: string): string =>
  value
    .replace(/&#10;/g, "\n")
    .replace(/&#13;/g, "\r")
    .replace(/&#9;/g, "\t")
    .replace(/&#45;/g, "-")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");

const truncate = (value: string, limit: number): string =>
  // Never cut in the middle of a surrogate pair: a lone high surrogate becomes U+FFFD downstream.
  value.length <= limit ? value : value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "\uFFFD");

/**
 * Cut selection text to the per-item budget where it is captured, so the sender never ships more
 * than the validator will accept, and record whether content was lost.
 */
export function clipSelectionText(text: string): { text: string; truncated?: boolean } {
  if (text.length <= MAX_SELECTION_CHARS) return { text };
  return { text: truncate(text, MAX_SELECTION_CHARS), truncated: true };
}

/* ------------------------------------------------------------------ block parts */

const SELECTION_PREAMBLE =
  "The following files and ranges were provided as context for this request. Focus on the selected source when interpreting the request. Read referenced files or ranges whose source is not included below before relying on their contents.";

export function buildFileBlock(labels: string[]): string {
  const unique = [...new Set(labels.filter(label => parseLabel(label) !== null))];
  if (unique.length === 0) return "";
  return `<file-context>\n${unique.map(label => `@${escapeText(label)}`).join("\n")}\n</file-context>`;
}

/** Inline the ranges the user selected, bounded so a huge paste cannot eat the context window. */
export function buildSelectionBlock(selections: QuotedLines[]): string {
  const parts: string[] = [];
  let budget = MAX_CONTEXT_CHARS;
  for (const selection of new Map(selections.map(item => [`${item.path}:${item.lineRange}`, item])).values()) {
    if (parts.length >= MAX_SELECTION_ITEMS || budget <= 0 || parts.length >= MAX_SELECTION_ITEMS) break;
    const cap = Math.min(MAX_SELECTION_CHARS, budget);
    const truncated = selection.truncated === true || selection.text.length > cap;
    const text = truncate(selection.text, cap);
    budget -= text.length;
    parts.push(
      `User-selected lines ${escapeText(selection.lineRange)} from ${escapeText(selection.path)}${
        truncated ? " (truncated; read the remaining range if needed)" : ""
      }:\n` +
        `<file name="${escapeAttribute(selection.path)}" lines="${escapeAttribute(selection.lineRange)}"${truncated ? ' truncated="true"' : ""}>\n` +
        `${escapeText(text)}\n` +
        `</file>`,
    );
  }
  if (parts.length === 0) return "";
  return `<editor-context>\n${[SELECTION_PREAMBLE, ...parts].join("\n\n")}\n</editor-context>`;
}

export function buildQuoteBlock(quotes: QuotedText[]): string {
  if (quotes.length === 0) return "";
  const body = quotes.map(quote => {
    const attributes = [
      quote.source ? ` source="${escapeAttribute(quote.source)}"` : "",
      quote.origin ? ` origin="${escapeAttribute(quote.origin)}"` : "",
    ].join("");
    return `<quote${attributes}>\n${escapeText(quote.text)}\n</quote>`;
  });
  return `<quote-context>\n${body.join("\n")}\n</quote-context>`;
}

export function buildProblemBlock(problems: ProblemEntry[]): string {
  if (problems.length === 0) return "";
  const body = problems.map(problem => {
    const attributes = [
      `file="${escapeAttribute(problem.path)}"`,
      `line="${problem.line}"`,
      `severity="${problem.severity}"`,
      problem.code ? `code="${escapeAttribute(String(problem.code))}"` : "",
      problem.source ? `source="${escapeAttribute(problem.source)}"` : "",
    ].join(" ");
    return `<problem ${attributes}>${escapeText(problem.message)}</problem>`;
  });
  return `<problem-context>\n${body.join("\n")}\n</problem-context>`;
}

export function buildNoteBlock(notes: FileNote[]): string {
  const usable = notes.filter(note => isValidFileNote(note) && note.note.trim().length > 0);
  if (usable.length === 0) return "";
  // One JSON object per line, with `<` escaped so a note cannot close the tag.
  const body = usable.map(note => JSON.stringify(note).replace(/</g, "\\u003c"));
  return `<file-notes>\n${body.join("\n")}\n</file-notes>`;
}

/** Put the parts in front of the message. With nothing to say, the text is returned untouched. */
export function wrapContext(parts: string[], text: string): string {
  const body = parts.filter(Boolean);
  if (body.length === 0) return text;
  return `${CONTEXT_START}\n${body.join("\n\n")}\n${CONTEXT_END}\n\n${text}`;
}

export function buildContextBlock(draft: ContextDraft, text: string): string {
  const clean = sanitizeDraft(draft);
  return wrapContext(
    [
      buildFileBlock(clean.files),
      buildSelectionBlock(clean.selections),
      buildQuoteBlock(clean.quotes),
      buildProblemBlock(clean.problems),
      buildNoteBlock(clean.notes),
    ],
    text,
  );
}

/* ------------------------------------------------------------------ parsing (round trip) */

/** Split a sent message back into its block and the user's own text. */
export function splitContextBlock(text: string): { body: string; userText: string } | null {
  if (!text.startsWith(CONTEXT_START)) return null;
  const afterHeader = CONTEXT_START.length;
  const end = text.indexOf(CONTEXT_END, afterHeader);
  if (end < 0) return null;
  const body = text.slice(afterHeader, end).trim();
  const remainder = text.slice(end + CONTEXT_END.length).replace(/^\s*\n/, "");
  return { body, userText: remainder };
}

/** Rebuild a draft from a stored message, so a past message shows the same chips as when it was sent. */
export function parseContextBlock(text: string): { draft: ContextDraft; userText: string } {
  const split = splitContextBlock(text);
  if (!split) return { draft: emptyDraft(), userText: text };
  const draft = emptyDraft();
  const sections = (tag: string): string[] =>
    [...split.body.matchAll(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, "g"))].map(match => match[1] ?? "");

  for (const body of sections("file-context")) {
    for (const rawLine of body.split("\n")) {
      const label = unescapeContextText(rawLine.trim()).replace(/^@/, "");
      if (parseLabel(label)) draft.files.push(label);
    }
  }

  for (const body of sections("editor-context")) {
    for (const [, rawPath = "", rawRange = "", rawTruncated, rawText = ""] of body.matchAll(
      /<file name="([^"\n]*)" lines="(\d+(?:-\d+)?)"( truncated="true")?>\n([\s\S]*?)\n<\/file>/g,
    )) {
      const item: QuotedLines = {
        path: unescapeContextText(rawPath.replace(/&quot;/g, '"')),
        lineRange: rawRange,
        text: unescapeContextText(rawText),
        ...(rawTruncated ? { truncated: true } : {}),
      };
      if (isValidQuotedLines(item)) draft.selections.push(item);
    }
  }

  for (const body of sections("quote-context")) {
    for (const [, rawSource, rawOrigin, rawText = ""] of body.matchAll(
      /<quote(?: source="([^"]*)")?(?: origin="([^"]*)")?>\n([\s\S]*?)\n<\/quote>/g,
    )) {
      const quote: QuotedText = { text: unescapeContextText(rawText) };
      if (rawSource) quote.source = unescapeContextText(rawSource.replace(/&quot;/g, '"'));
      if (rawOrigin) quote.origin = unescapeContextText(rawOrigin.replace(/&quot;/g, '"'));
      if (isValidQuotedText(quote)) draft.quotes.push(quote);
    }
  }

  for (const body of sections("problem-context")) {
    for (const [, rawPath = "", rawLine = "0", rawSeverity = "hint", rawAttributes = "", rawMessage = ""] of body.matchAll(
      /<problem file="([^"\n]*)" line="(\d+)" severity="(\w+)"([^>]*)>([\s\S]*?)<\/problem>/g,
    )) {
      const code = /code="([^"]*)"/.exec(rawAttributes)?.[1];
      const source = /source="([^"]*)"/.exec(rawAttributes)?.[1];
      const problem: ProblemEntry = {
        path: unescapeContextText(rawPath.replace(/&quot;/g, '"')),
        line: Number(rawLine),
        severity: rawSeverity as ProblemSeverity,
        message: unescapeContextText(rawMessage),
        ...(code ? { code } : {}),
        ...(source ? { source } : {}),
      };
      if (isValidProblem(problem)) draft.problems.push(problem);
    }
  }

  for (const body of sections("file-notes")) {
    for (const line of body.split("\n")) {
      try {
        const note = JSON.parse(line) as FileNote;
        if (isValidFileNote(note)) draft.notes.push(note);
      } catch {
        /* a malformed note line is dropped rather than failing the whole block */
      }
    }
  }

  return { draft, userText: split.userText };
}

/* ------------------------------------------------------------------ mentions */

/**
 * `@src/a.ts` and `@src/a.ts:12-30` typed into a message. A mention is a whitespace-delimited
 * token: an address inside a word (`bob@example.com`) never matches because the `@` has to start
 * the token, and trailing punctuation is stripped rather than treated as an end boundary.
 */
export function parseMentions(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@(\S+)/g)) {
    // Trailing sentence punctuation is not part of a path, but a range separator is.
    const label = (match[1] ?? "").replace(/[,.;:!)?\]"',]+$/, "");
    if (parseLabel(label)) found.push(label);
  }
  return [...new Set(found)];
}
