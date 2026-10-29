/**
 * The "Manage Pi" panel: what Pi loaded, what failed, and a reload button.
 *
 * Rendered from the host, not from a bundle — it is a report with three buttons, and an inline
 * script with a nonce is smaller and easier to audit than a fourth build target.
 */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ResourceReport } from "../shared/protocol.js";

export interface ManagePanelActions {
  resources(): Promise<ResourceReport>;
  reload(): Promise<void>;
  openFile(filePath: string): Promise<void>;
  openSettings(): Promise<void>;
}

type PanelRequest = { type: "reload" } | { type: "open"; path: string } | { type: "settings" };

export class ManagePanel {
  private panel?: vscode.WebviewPanel;

  constructor(private readonly actions: ManagePanelActions) {}

  show(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.One);
      void this.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel("amulet.manage", "Amulet · Pi Resources", vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: false,
    });
    this.panel = panel;
    panel.onDidDispose(() => (this.panel = undefined));
    panel.webview.onDidReceiveMessage((message: PanelRequest) => {
      if (message?.type === "reload") void this.actions.reload().then(() => this.refresh());
      if (message?.type === "settings") void this.actions.openSettings();
      if (message?.type === "open" && typeof message.path === "string") void this.actions.openFile(message.path);
    });
    void this.refresh();
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    try {
      this.panel.webview.html = this.html(await this.actions.resources());
    } catch (error) {
      this.panel.webview.html = this.errorPage(error instanceof Error ? error.message : String(error));
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
  }

  /* ------------------------------------------------------------------ rendering */

  private html(resources: ResourceReport): string {
    const nonce = randomToken();
    const failed = resources.errors.length;
    const loaded = resources.extensions.filter(extension => !extension.hidden && !extension.error).length;
    const hidden = resources.extensions.filter(extension => extension.hidden).length;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.cspSource()} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Amulet · Pi Resources</title>
<style>${STYLES}</style>
</head>
<body>
<header>
  <div class="summary">
    <span class="count${failed ? " error" : ""}">${failed ? `${failed} failed` : "All loaded"}</span>
    <span>${loaded} extension${loaded === 1 ? "" : "s"}</span>
    ${hidden ? `<span title="Loaded by another extension, not listed in pickers">${hidden} hidden</span>` : ""}
    <span>${resources.skills.length} skill${resources.skills.length === 1 ? "" : "s"}</span>
    <span>${resources.prompts.length} prompt${resources.prompts.length === 1 ? "" : "s"}</span>
    <span>${resources.configuredExtensions.length} configured</span>
  </div>
  <div class="buttons">
    <button data-action="reload">Reload Pi config</button>
    <button data-action="settings">Open settings</button>
  </div>
</header>
${resources.errors.length ? section("Could not load", resources.errors.map(failure => `<li class="error"><b>${esc(failure.path)}</b><pre>${esc(failure.error)}</pre></li>`).join("")) : ""}
${section("Extensions", resources.extensions.length
  ? resources.extensions.map(extension => extensionRow(extension)).join("")
  : empty("No extensions are loaded."))}
${section("Skills", resources.skills.length
  ? resources.skills.map(item => resourceRow(item, "skill")).join("")
  : empty("No skills were found."))}
${section("Prompt templates", resources.prompts.length
  ? resources.prompts.map(item => resourceRow(item, "prompt")).join("")
  : empty("No prompt templates were found."))}
${resources.diagnostics.length
  ? section("Notes", resources.diagnostics.map(d => `<li class="warn">${esc(d.path ? `${d.path}: ` : "")}${esc(d.message)}</li>`).join(""))
  : ""}
${section("Instructions", [
    ...resources.instructionsFiles.map(file => `<li><button class="link" data-open="${esc(file)}">${esc(file)}</button></li>`),
    ...(resources.systemPromptFile ? [`<li>System prompt: <button class="link" data-open="${esc(resources.systemPromptFile)}">${esc(resources.systemPromptFile)}</button></li>`] : []),
  ].join(""))}
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
document.addEventListener("click", event => {
  const target = event.target instanceof Element ? event.target.closest("[data-action],[data-open]") : null;
  if (!target) return;
  const action = target.getAttribute("data-action");
  if (action === "reload") vscode.postMessage({ type: "reload" });
  if (action === "settings") vscode.postMessage({ type: "settings" });
  const open = target.getAttribute("data-open");
  if (open) vscode.postMessage({ type: "open", path: open });
});
</script>
</body>
</html>`;
  }

  private errorPage(message: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLES}</style></head>
<body><header><div class="summary"><span class="count error">Not available</span></div></header>
${section("The worker is not running", `<li class="error">${esc(message)}</li>`)}</body></html>`;
  }

  private cspSource(): string {
    return this.panel ? this.panel.webview.cspSource : "vscode-webview:";
  }
}

/* ------------------------------------------------------------------ fragments */

function section(title: string, body: string): string {
  return `<section><h2>${esc(title)}</h2><ul>${body}</ul></section>`;
}

function empty(message: string): string {
  return `<li class="muted">${esc(message)}</li>`;
}

function extensionRow(extension: ResourceReport["extensions"][number]): string {
  const provides = [
    extension.tools.length ? `tools: ${extension.tools.join(", ")}` : "",
    extension.commands.length ? `commands: ${extension.commands.join(", ")}` : "",
    extension.handlerCount ? `${extension.handlerCount} event handler${extension.handlerCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  const state = extension.error ? "error" : extension.hidden ? "muted" : "";
  return `<li class="${state}">
  <div class="row">
    <b>${esc(extension.name)}</b>
    <span class="tag">${extension.builtin ? "built-in" : esc(extension.scope)}</span>
    ${extension.hidden ? `<span class="tag" title="Loaded by another extension, not listed in pickers">hidden</span>` : ""}
    ${extension.error ? `<span class="tag error">failed</span>` : ""}
  </div>
  <div class="sub">${extension.error ? esc(extension.error) : esc(provides.join(" · ") || "registers nothing")}</div>
  <button class="link" data-open="${esc(extension.path)}" title="Open this file">${esc(extension.path)}</button>
</li>`;
}

function resourceRow(item: { name: string; description: string; path: string }, kind: string): string {
  return `<li>
  <div class="row"><b>${esc(item.name)}</b><span class="tag">${kind}</span></div>
  <div class="sub">${esc(item.description || "no description")}</div>
  <button class="link" data-open="${esc(item.path)}" title="Open this file">${esc(item.path)}</button>
</li>`;
}

function esc(value: string): string {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function randomToken(): string {
  return randomBytes(16).toString("base64url");
}

const STYLES = `
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 1.2rem 2rem; }
header { position: sticky; top: 0; background: var(--vscode-editor-background); padding: 0.8rem 0 0.6rem; border-bottom: 1px solid var(--vscode-panel-border); display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
.summary { display: flex; gap: 0.7rem; flex-wrap: wrap; color: var(--vscode-descriptionForeground); font-size: 0.9em; }
.summary .count { color: var(--vscode-charts-green); font-weight: 600; }
.summary .count.error { color: var(--vscode-errorForeground); }
button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; padding: 0.35rem 0.7rem; cursor: pointer; border-radius: 2px; }
button:hover { background: var(--vscode-button-secondaryHoverBackground); }
.buttons { display: flex; gap: 0.4rem; }
h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin: 1.4rem 0 0.4rem; }
ul { list-style: none; margin: 0; padding: 0; border-top: 1px solid var(--vscode-panel-border); }
li { padding: 0.5rem 0; border-bottom: 1px solid var(--vscode-panel-border); }
li.error b { color: var(--vscode-errorForeground); }
li.warn { color: var(--vscode-warningForeground); }
li.muted, .sub.muted { color: var(--vscode-descriptionForeground); }
pre { white-space: pre-wrap; margin: 0.3rem 0 0; font-family: var(--vscode-editor-font-family); font-size: 0.85em; color: var(--vscode-errorForeground); }
.row { display: flex; gap: 0.5rem; align-items: baseline; flex-wrap: wrap; }
.sub { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 0.15rem; }
.tag { font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.04em; border: 1px solid var(--vscode-panel-border); border-radius: 2px; padding: 0 0.25rem; color: var(--vscode-descriptionForeground); }
.tag.error { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
button.link { background: none; border: none; padding: 0; color: var(--vscode-textLink-foreground); font-size: 0.85em; text-decoration: underline; }
`;
