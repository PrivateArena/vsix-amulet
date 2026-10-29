/**
 * Turning editor state into composer context, and composer context into the wire block.
 *
 * Two kinds of behaviour live here. Explicit ones — a command, a context menu, a clicked chip.
 * And automatic ones, which are the reason this class remembers anything: an auto-attached chip
 * the user removed must not come back until the thing that produced it actually changes.
 */
import * as vscode from "vscode";
import {
  buildContextBlock,
  mergeDraft,
  parseLabel,
  parseMentions,
  emptyDraft,
  type ContextDraft,
  type ContextFragment,
  type QuotedLines,
} from "../shared/contextBlock.js";
import {
  fileFragment,
  problemFragment,
  resolveRangeReference,
  searchWorkspaceFiles,
  selectionFragment,
  snapshotActiveEditor,
  toRelativePath,
} from "./contextSources.js";
import type { HostEvent } from "../shared/protocol.js";

export interface ContextBridgeDeps {
  getCwd: () => string | undefined;
  post: (event: HostEvent) => void;
}

export class ContextBridge {
  /** Ranges the user removed by hand: they stay off until the selection changes. */
  private readonly dismissedSelections = new Set<string>();
  /** Files the user removed by hand: they stay off until a different file becomes active. */
  private readonly dismissedFiles = new Set<string>();
  private lastAutoSelectionKey: string | undefined;
  private lastAutoFile: string | undefined;

  constructor(private readonly deps: ContextBridgeDeps) {}

  /* ------------------------------------------------------------ settings */

  private get settings() {
    const value = vscode.workspace.getConfiguration("amulet.context");
    return {
      attachFileReferences: !value.get<boolean>("disableFileReferences", false),
      attachSelectionOnFocus: value.get<boolean>("attachSelectionOnFocus", true),
      attachActiveFile: value.get<boolean>("attachActiveFile", false),
      pasteBadgeThreshold: value.get<number>("pasteBadgeThreshold", 700),
    };
  }

  /** Push collected context into the composer. */
  private append(fragment: ContextFragment, notice?: string): void {
    const useful = (fragment.files?.length ?? 0) + (fragment.selections?.length ?? 0) + (fragment.problems?.length ?? 0) > 0;
    if (!useful) {
      if (notice) this.deps.post({ type: "toast", message: notice, level: "info" });
      return;
    }
    this.deps.post({ type: "contextAppend", fragment });
  }

  /* ------------------------------------------------------------ explicit entry points */

  async attachSelection(): Promise<void> {
    const cwd = this.deps.getCwd();
    if (!cwd) return;
    const fragment = await selectionFragment(cwd);
    if (!fragment) {
      this.deps.post({ type: "toast", message: "Select the lines you want to send, then run Add Selection.", level: "info" });
      return;
    }
    for (const label of fragment.files ?? []) this.dismissedSelections.delete(label);
    this.lastAutoSelectionKey = fragment.files?.[0];
    this.append(fragment);
  }

  attachActiveFile(): void {
    const cwd = this.deps.getCwd();
    const snapshot = snapshotActiveEditor(cwd ?? "", vscode.window.activeTextEditor);
    if (!cwd || !snapshot) return void this.noWorkspaceFile();
    this.dismissedFiles.delete(snapshot.relativePath);
    this.append({ files: [snapshot.relativePath] });
  }

  /**
   * From an editor tab (no argument) or from the file explorer (one or many selected URIs).
   * A selection in the active editor rides along, because that is what the user was looking at.
   */
  async attachFiles(uris?: readonly vscode.Uri[]): Promise<void> {
    const cwd = this.deps.getCwd();
    if (!cwd) return void this.noWorkspaceFile();
    const targets = uris?.length ? uris : vscode.workspace.workspaceFolders?.map(folder => folder.uri);
    if (!targets?.length) return void this.noWorkspaceFile();
    for (const uri of targets) {
      if (uri.scheme !== "file") continue;
      const relative = toRelativePath(cwd, uri.fsPath);
      this.dismissedFiles.delete(relative);
      this.append(fileFragment(cwd, uri));
    }
  }

  async attachProblems(): Promise<void> {
    const cwd = this.deps.getCwd();
    if (!cwd) return void this.noWorkspaceFile();
    const active = vscode.window.activeTextEditor;
    const onlyPath = active?.document.uri.scheme === "file" ? toRelativePath(cwd, active.document.uri.fsPath) : undefined;
    const fragment = problemFragment(cwd, onlyPath);
    if (!fragment.problems?.length) {
      this.deps.post({ type: "toast", message: onlyPath ? `No problems reported in ${onlyPath}` : "No problems reported in this workspace", level: "info" });
      return;
    }
    this.append(fragment);
  }

  /** Host-side composer rules the UI has to honour. */
  get composerSettings(): { pasteBadgeThreshold: number; attachSelectionOnFocus: boolean } {
    const settings = this.settings;
    return { pasteBadgeThreshold: settings.pasteBadgeThreshold, attachSelectionOnFocus: settings.attachSelectionOnFocus };
  }

  /** Files dropped onto the composer: the editor resolves URIs, the webview never reads them. */
  async attachUris(uris: string[]): Promise<void> {
    const parsed = uris.map(uri => { try { return vscode.Uri.parse(uri); } catch { return undefined; } }).filter((value): value is vscode.Uri => value?.scheme === "file");
    if (!parsed.length) {
      this.deps.post({ type: "toast", message: "Drag files from the Explorer while holding Shift.", level: "info" });
      return;
    }
    await this.attachFiles(parsed);
  }

  private noWorkspaceFile(): void {
    this.deps.post({ type: "toast", message: "Amulet works on files inside the open folder.", level: "warning" });
  }

  /* ------------------------------------------------------------ automatic entry points */

  /**
   * Composer focus: attach the current selection, once per selection. Removing the chip keeps it
   * off until the user selects something else.
   */
  async onComposerFocused(): Promise<void> {
    const cwd = this.deps.getCwd();
    if (!cwd || !this.settings.attachSelectionOnFocus) return;
    const fragment = await selectionFragment(cwd);
    const label = fragment?.files?.[0];
    if (!label || this.dismissedSelections.has(label) || label === this.lastAutoSelectionKey) return;
    this.lastAutoSelectionKey = label;
    this.append(fragment);
  }

  /**
   * Active file follows the user when the setting is on. A removed file chip stays off until the
   * user switches to another file.
   */
  onActiveEditorChanged(): void {
    const cwd = this.deps.getCwd();
    if (!cwd || !this.settings.attachActiveFile) return;
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return;
    const relative = toRelativePath(cwd, editor.document.uri.fsPath);
    if (relative === this.lastAutoFile || this.dismissedFiles.has(relative)) return;
    this.lastAutoFile = relative;
    this.append({ files: [relative] });
  }

  dismiss(labels: string[]): void {
    for (const label of labels) {
      const parsed = parseLabel(label);
      if (!parsed) continue;
      // A chip with a range is a selection; a bare path is a file.
      if (parsed.lineRange) this.dismissedSelections.add(label);
      else this.dismissedFiles.add(parsed.path);
    }
  }

  /* ------------------------------------------------------------ chip interactions */

  async search(requestId: string, query: string): Promise<void> {
    const cwd = this.deps.getCwd();
    if (!cwd) return void this.deps.post({ type: "fileResults", requestId, items: [] });
    try {
      const items = await searchWorkspaceFiles(cwd, query);
      this.deps.post({ type: "fileResults", requestId, items });
    } catch (error) {
      this.deps.post({ type: "fileResults", requestId, items: [], error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Reveal what a chip points at, scrolled to the attached range. */
  async open(label: string): Promise<void> {
    const cwd = this.deps.getCwd();
    const parsed = parseLabel(label);
    if (!cwd || !parsed) return;
    const absolute = parsed.path.startsWith("/") ? parsed.path : `${cwd}/${parsed.path}`;
    const uri = vscode.Uri.file(absolute);
    try {
      const start = parsed.start || 1;
      const range = new vscode.Range(Math.max(0, start - 1), 0, Math.max(0, start - 1), 0);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      editor.selection = new vscode.Selection(range.start, parsed.end > start ? new vscode.Position(parsed.end - 1, 0) : range.start);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch {
      this.deps.post({ type: "toast", message: `Cannot open ${label}`, level: "warning" });
    }
  }

  /* ------------------------------------------------------------ the wire block */

  /**
   * Final text for the worker: the typed `@mentions` become references, references with a range
   * get their lines quoted when we can read them, and the whole thing goes in front of the text.
   */
  async buildPromptText(text: string, draft?: ContextDraft): Promise<string> {
    const cwd = this.deps.getCwd();
    const settings = this.settings;
    let merged = mergeDraft(draft ?? emptyDraft(), { files: parseMentions(text) });
    if (!settings.attachFileReferences) merged = { ...merged, files: [], selections: [] };

    if (!cwd) return buildContextBlock(merged, text);

    const quoted = new Set(merged.selections.map(selection => `${selection.path}:${selection.lineRange}`));
    const selections: QuotedLines[] = [...merged.selections];
    const unavailable: string[] = [];
    for (const label of merged.files) {
      const parsed = parseLabel(label);
      if (!parsed?.lineRange) continue;
      const key = `${parsed.path}:${parsed.lineRange}`;
      if (quoted.has(key)) continue;
      const resolved = await resolveRangeReference(cwd, label);
      if (resolved.quoted) {
        selections.push(resolved.quoted);
        quoted.add(key);
      } else if (resolved.unavailable) {
        unavailable.push(resolved.unavailable);
      }
    }
    if (unavailable.length) {
      // Say so rather than leaving the model to wonder why a listed range has no text.
      this.deps.post({ type: "toast", message: `Could not read the attached lines in ${unavailable.join(", ")}; sent as references only`, level: "info" });
    }
    return buildContextBlock({ ...merged, selections }, text);
  }
}
