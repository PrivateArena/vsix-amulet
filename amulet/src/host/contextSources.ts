/**
 * Reading context out of the editor.
 *
 * The rule the format imposes: a file that the agent can read for itself travels as a *reference*,
 * and only lines it could not re-read from disk travel as text. So this module answers three
 * questions and nothing else — what is the path relative to the workspace, what did the user
 * select, and what does the editor currently think is wrong with this file.
 */
import * as vscode from "vscode";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  clipSelectionText,
  formatLabel,
  parseLabel,
  type ContextFragment,
  type ProblemEntry,
  type ProblemSeverity,
  type QuotedLines,
} from "../shared/contextBlock.js";

/** Workspace-relative, forward-slashed — the form the block and the agent both speak. */
export function toRelativePath(cwd: string, fsPath: string): string {
  const relative = path.relative(cwd, fsPath);
  const normalised = relative.split(path.sep).join("/");
  // Never let a path outside the workspace come back as `../../secret`: keep it absolute and honest.
  if (!relative || relative.startsWith("..")) return fsPath;
  return normalised;
}

export interface EditorSnapshot {
  uri: vscode.Uri;
  relativePath: string;
  /** Empty when nothing is selected. */
  selection: vscode.Selection | undefined;
  isDirty: boolean;
  label: string;
}

export function snapshotActiveEditor(cwd: string, editor = vscode.window.activeTextEditor): EditorSnapshot | undefined {
  if (!editor || editor.selection.isEmpty) return undefined;
  if (editor.document.uri.scheme !== "file") return undefined;
  const relativePath = toRelativePath(cwd, editor.document.uri.fsPath);
  const { start, end } = editor.selection;
  return {
    uri: editor.document.uri,
    relativePath,
    selection: editor.selection,
    isDirty: editor.document.isDirty,
    label: formatLabel(relativePath, start.line + 1, end.line + 1),
  };
}

/** The selected lines, quoted, plus the range reference for the file block. */
export async function selectionFragment(cwd: string, editor = vscode.window.activeTextEditor): Promise<ContextFragment | undefined> {
  const snapshot = snapshotActiveEditor(cwd, editor);
  if (!snapshot?.selection) return undefined;
  const raw = snapshot.selection ? editor!.document.getText(snapshot.selection) : "";
  const { text, truncated } = clipSelectionText(raw.replace(/\r\n/g, "\n"));
  if (!text.trim()) return undefined;
  const start = snapshot.selection.start.line + 1;
  const end = snapshot.selection.end.line + 1;
  const quoted: QuotedLines = {
    path: snapshot.relativePath,
    lineRange: start === end ? `${start}` : `${start}-${end}`,
    text,
    ...(truncated ? { truncated: true } : {}),
    ...(snapshot.isDirty ? { reason: "unsaved" as const } : {}),
  };
  return { files: [snapshot.label], selections: [quoted] };
}

/** A whole file, by reference only — the agent has its own tools. */
export const fileFragment = (cwd: string, uri: vscode.Uri): ContextFragment => ({
  files: [toRelativePath(cwd, uri.fsPath)],
});

const severityName = (severity: vscode.DiagnosticSeverity): ProblemSeverity => {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
};

export const MAX_PROBLEM_ENTRIES = 50;

/**
 * Reported problems. When the user asked from inside a file, that file's problems; otherwise
 * everything the language servers have to say, errors first, capped.
 */
export function problemFragment(cwd: string, onlyPath?: string): ContextFragment {
  const entries: ProblemEntry[] = [];
  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") continue;
    const relativePath = toRelativePath(cwd, uri.fsPath);
    if (onlyPath && relativePath !== onlyPath) continue;
    for (const diagnostic of diagnostics) {
      if (diagnostic.message.trim().length === 0) continue;
      entries.push({
        path: relativePath,
        line: diagnostic.range.start.line + 1,
        severity: severityName(diagnostic.severity),
        // A multi-line diagnostic message is one line here; the block is line-oriented.
        message: diagnostic.message.replace(/\s+/g, " ").trim().slice(0, 2_000),
        ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
        ...(diagnostic.source ? { source: diagnostic.source } : {}),
      });
    }
  }
  const rank = { error: 0, warning: 1, info: 2, hint: 3 } as const;
  entries.sort((a, b) => rank[a.severity] - rank[b.severity] || a.path.localeCompare(b.path) || a.line - b.line);
  if (entries.length === 0) return {};
  return { problems: entries.slice(0, MAX_PROBLEM_ENTRIES) };
}

/**
 * Materialise a `path:lines` reference whose text we may still be able to quote: an open unsaved
 * buffer wins over disk, otherwise the range is read from disk. A range that cannot be read is
 * left as a reference — the agent can read it itself, and saying so beats quoting a guess.
 */
export async function resolveRangeReference(
  cwd: string,
  label: string,
): Promise<{ quoted?: QuotedLines; unavailable?: string }> {
  const parsed = parseLabel(label);
  if (!parsed || !parsed.lineRange) return {};

  const absolute = path.isAbsolute(parsed.path) ? parsed.path : path.join(cwd, parsed.path);
  const open = vscode.workspace.textDocuments.find(document => document.uri.fsPath === absolute && document.isDirty);
  if (open) {
    const lines = open.getText().split("\n");
    const text = lines.slice(parsed.start - 1, parsed.end).join("\n");
    return { quoted: { path: parsed.path, lineRange: parsed.lineRange, ...clipSelectionText(text), reason: "unsaved" } };
  }

  try {
    const content = await readFile(absolute, "utf8");
    if (content.includes("\0")) return { unavailable: parsed.path };
    const lines = content.split("\n");
    if (parsed.end > lines.length) return { unavailable: parsed.path };
    const text = lines.slice(parsed.start - 1, parsed.end).join("\n");
    return { quoted: { path: parsed.path, lineRange: parsed.lineRange, ...clipSelectionText(text) } };
  } catch {
    return { unavailable: parsed.path };
  }
}

const SEARCH_LIMIT = 40;

/** Workspace files for the `@` picker, ranked by how tightly the query hits the path. */
export async function searchWorkspaceFiles(cwd: string, query: string): Promise<string[]> {
  const needle = query.replace(/[\\%*?]/g, "").toLowerCase();
  const include = new vscode.RelativePattern(cwd, needle ? `**/*${path.basename(needle)}*` : "**/*");
  const exclude = new vscode.RelativePattern(vscode.Uri.file(cwd), "**/{.git,node_modules,dist,out,build}/**");
  const found = await vscode.workspace.findFiles(include, exclude, SEARCH_LIMIT * 4);
  const relative = found.map(uri => toRelativePath(cwd, uri.fsPath)).filter(label => parseLabel(label) !== null);
  if (!needle) return relative.slice(0, SEARCH_LIMIT);
  const scored = relative
    .map(label => ({ label, score: scoreMatch(label, needle) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => a.score - b.score || a.label.length - b.label.length || a.label.localeCompare(b.label));
  return scored.slice(0, SEARCH_LIMIT).map(item => item.label);
}

/** Lower is better: basename prefix beats basename substring beats a hit further up the path. */
function scoreMatch(label: string, needle: string): number {
  const lower = label.toLowerCase();
  const base = path.basename(lower);
  if (base.startsWith(needle)) return 0;
  if (base.includes(needle)) return 1;
  if (lower.includes(needle)) return 2;
  return -1; // no match
}
