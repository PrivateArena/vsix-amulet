/**
 * The context half of the composer: the chips above the input and the `@` picker.
 *
 * The webview holds the draft the user is composing — it is the thing they see and edit — while
 * the *formatting* of that draft into the wire block happens in the host. This file only ever
 * builds plain data and DOM, never HTML strings: attached content is untrusted text and must not be
 * able to script the webview any more than it can script the model.
 */
import { emptyDraft, formatLabel, mergeDraft, type ContextDraft, type ContextFragment } from "../shared/contextBlock.js";
import type { ImageAttachment, WebviewRequest } from "../shared/protocol.js";

export interface PendingImage extends ImageAttachment {
  name: string;
  bytes: number;
}

export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface ComposerBridge {
  post(message: WebviewRequest): void;
  toast(message: string, level?: "info" | "warning" | "error"): void;
}

type Removable =
  | { kind: "file"; index: number }
  | { kind: "selection"; index: number }
  | { kind: "quote"; index: number }
  | { kind: "problem"; index: number }
  | { kind: "note"; index: number }
  | { kind: "image"; index: number };

/** The draft plus its pasted images, with the chip row that shows them. */
export class ContextChips {
  private contextDraft: ContextDraft = emptyDraft();
  private pendingImages: PendingImage[] = [];

  constructor(
    private readonly container: HTMLElement,
    private readonly bridge: ComposerBridge,
  ) {
    container.addEventListener("click", event => this.onChipClick(event));
  }

  get draft(): ContextDraft {
    return this.contextDraft;
  }

  get images(): PendingImage[] {
    return this.pendingImages;
  }

  get empty(): boolean {
    return this.pendingImages.length === 0 && countDraft(this.contextDraft) === 0;
  }

  add(fragment: ContextFragment): void {
    this.contextDraft = mergeDraft(this.contextDraft, fragment);
    this.render();
  }

  addImage(image: PendingImage): void {
    if (this.pendingImages.length >= MAX_IMAGES) {
      this.bridge.toast(`Only ${MAX_IMAGES} images fit in one message.`, "warning");
      return;
    }
    if (image.bytes > MAX_IMAGE_BYTES) {
      this.bridge.toast(`${image.name} is larger than ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`, "warning");
      return;
    }
    if (!image.data) return;
    this.pendingImages.push(image);
    this.render();
  }

  /** Take everything for sending; the composer is empty afterwards. */
  drain(): { draft: ContextDraft; images: ImageAttachment[] } {
    const sent = { draft: this.contextDraft, images: this.pendingImages.map(({ data, mimeType }) => ({ type: "image" as const, data, mimeType })) };
    this.contextDraft = emptyDraft();
    this.pendingImages = [];
    this.render();
    return sent;
  }

  /** Replace the whole draft, used when the host restates what the composer should hold. */
  replace(fragment: ContextFragment): void {
    this.contextDraft = mergeDraft(emptyDraft(), fragment);
    this.render();
  }

  private remove(target: Removable): void {
    const draft = this.contextDraft;
    switch (target.kind) {
      case "file": {
        const [label] = draft.files.splice(target.index, 1);
        // Tell the host, so an auto-attached chip does not come straight back.
        if (label !== undefined) this.bridge.post({ type: "contextDismissed", labels: [label] });
        break;
      }
      case "selection": {
        const [removed] = draft.selections.splice(target.index, 1);
        if (removed) {
          const label = formatLabel(removed.path, ...rangeBounds(removed.lineRange));
          this.bridge.post({ type: "contextDismissed", labels: [label] });
        }
        break;
      }
      case "quote":
        draft.quotes.splice(target.index, 1);
        break;
      case "problem":
        draft.problems.splice(target.index, 1);
        break;
      case "note":
        draft.notes.splice(target.index, 1);
        break;
      case "image":
        this.pendingImages.splice(target.index, 1);
        break;
    }
    this.render();
  }

  private onChipClick(event: MouseEvent): void {
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const container = target.closest<HTMLElement>(".chip");
    if (!container) return;
    const kind = container.dataset.kind as Removable["kind"] | undefined;
    const index = Number(container.dataset.index);
    if (!kind || Number.isNaN(index)) return;
    if (target.dataset.action === "remove") return void this.remove({ kind, index } as Removable);
    // Clicking the body of a file chip reveals it.
    const label = container.dataset.label;
    if (label) this.bridge.post({ type: "openFile", label });
  }

  /** One chip per attached thing, in the same order the block will list them. */
  render(): void {
    const draft = this.contextDraft;
    this.container.replaceChildren();
    const chips: Node[] = [];

    draft.files.forEach((label, index) => {
      const parsed = splitLabel(label);
      chips.push(chip("file", index, parsed.text, parsed.title, `${label}`));
    });
    draft.selections.forEach((selection, index) => {
      const label = formatLabel(selection.path, ...rangeBounds(selection.lineRange));
      const suffix = selection.reason === "unsaved" ? " · unsaved" : selection.truncated ? " · part" : "";
      chips.push(chip("selection", index, `${label}${suffix}`, `Lines ${selection.lineRange} of ${selection.path}, quoted in the message`, label));
    });
    draft.quotes.forEach((quote, index) => {
      const preview = quote.text.replace(/\s+/g, " ").trim().slice(0, 42);
      chips.push(chip("quote", index, `“${preview}${quote.text.length > 42 ? "…" : ""}”`, quote.origin ? `From ${quote.origin}` : "Quoted from the conversation"));
    });
    const problemCount = countDraftProblems(draft);
    if (problemCount) {
      const byPath = new Map<string, number>();
      for (const problem of draft.problems) byPath.set(problem.path, (byPath.get(problem.path) ?? 0) + 1);
      for (const [path, count] of byPath) {
        chips.push(chip("problem", draft.problems.findIndex(problem => problem.path === path), `${count} problem${count === 1 ? "" : "s"} in ${path}`, "Reported by your editors", path));
      }
    }
    draft.notes.forEach((note, index) => {
      chips.push(chip("note", index, `note for ${note.path}`, note.note, note.path));
    });
    this.pendingImages.forEach((image, index) => {
      chips.push(chip("image", index, `${image.name} · ${Math.max(1, Math.round(image.bytes / 1024))} kB`, image.mimeType));
    });

    if (chips.length === 0) {
      this.container.hidden = true;
      return;
    }
    this.container.hidden = false;
    this.container.replaceChildren(...chips);
  }
}

const countDraft = (draft: ContextDraft): number =>
  draft.files.length + draft.selections.length + draft.quotes.length + draft.problems.length + draft.notes.length;

const countDraftProblems = (draft: ContextDraft): number => draft.problems.length;

function rangeBounds(lineRange: string): [number, number?] {
  const [start, end] = lineRange.split("-").map(Number);
  return end && end !== start ? [start, end] : [start];
}

function splitLabel(label: string): { text: string; title: string } {
  const [path, range] = label.split(/:(?=\d+(?:-\d+)?)$/);
  return { text: `@${path}${range ? `:${range}` : ""}`, title: range ? `${path}, lines ${range}` : path };
}

function chip(kind: Removable["kind"], index: number, text: string, title?: string, label?: string): HTMLElement {
  const element = document.createElement("span");
  element.className = `chip chip-${kind}`;
  element.dataset.kind = kind;
  element.dataset.index = String(index);
  if (label) element.dataset.label = label;
  if (title) element.title = title;
  const body = document.createElement("span");
  body.className = "chip-body";
  body.dataset.action = label ? "open" : "";
  body.textContent = text;
  const remove = document.createElement("button");
  remove.className = "chip-remove";
  remove.type = "button";
  remove.dataset.action = "remove";
  remove.title = "Remove from this message";
  remove.textContent = "×";
  element.append(body, remove);
  return element;
}

/* ------------------------------------------------------------------ @ picker */

interface PickerState {
  open: boolean;
  items: string[];
  cursor: number;
  requestId: number;
  pendingQuery: string;
  tokenStart: number;
  tokenEnd: number;
}

/** Typing `@` searches the workspace; accepting writes the path into the text. */
export class MentionPicker {
  private state: PickerState = { open: false, items: [], cursor: -1, requestId: 0, pendingQuery: "", tokenStart: -1, tokenEnd: -1 };
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly input: HTMLTextAreaElement,
    private readonly popup: HTMLElement,
    private readonly bridge: ComposerBridge,
  ) {}

  get isOpen(): boolean {
    return this.state.open;
  }

  /** Recompute the token under the cursor; called on every input and cursor move. */
  sync(): void {
    const token = this.tokenAtCaret();
    if (!token) return this.close();
    const query = token.query;
    if (query.length === 0) return this.close();
    if (query === this.state.pendingQuery && this.state.items.length) return this.show();
    this.state.pendingQuery = query;
    this.state.tokenStart = token.start;
    this.state.tokenEnd = token.end;
    this.state.items = [];
    this.state.cursor = -1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.request(query), 120);
    this.show();
  }

  private request(query: string): void {
    this.state.requestId += 1;
    this.bridge.post({ type: "searchFiles", requestId: String(this.state.requestId), query });
  }

  /** Results arrive asynchronously; ignore anything the user has since typed over. */
  onResults(requestId: string, items: string[]): void {
    if (requestId !== String(this.state.requestId)) return;
    this.state.items = items;
    this.state.cursor = items.length > 0 ? 0 : -1;
    this.show();
  }

  /** Returns true when the key belonged to the picker, so the caller skips its own handling. */
  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.state.open) return false;
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        this.move(1);
        return true;
      case "ArrowUp":
        event.preventDefault();
        this.move(-1);
        return true;
      case "Enter":
      case "Tab":
        if (this.state.cursor < 0) return false;
        event.preventDefault();
        this.accept(this.state.items[this.state.cursor]);
        return true;
      case "Escape":
        event.preventDefault();
        this.close();
        return true;
      default:
        return false;
    }
  }

  private move(delta: number): void {
    const count = this.state.items.length;
    if (!count) return;
    this.state.cursor = (this.state.cursor + delta + count) % count;
    this.show();
  }

  private accept(path: string | undefined): void {
    if (!path) return;
    const { tokenStart, tokenEnd } = this.state;
    const value = this.input.value;
    const caret = this.input.selectionStart ?? value.length;
    const end = Math.max(tokenEnd, caret);
    const inserted = `@${path} `;
    this.input.value = value.slice(0, tokenStart) + inserted + value.slice(end);
    const position = tokenStart + inserted.length;
    this.input.selectionStart = this.input.selectionEnd = position;
    this.input.focus();
    this.close();
  }

  private tokenAtCaret(): { query: string; start: number; end: number } | undefined {
    const caret = this.input.selectionStart ?? this.input.value.length;
    const before = this.input.value.slice(0, caret);
    const match = /(^|\s)@([^\s@]*)$/.exec(before);
    if (!match) return undefined;
    const start = caret - match[2].length - 1;
    return { query: match[2], start, end: caret };
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.state = { ...this.state, open: false, items: [], cursor: -1, pendingQuery: "" };
    this.popup.hidden = true;
    this.popup.replaceChildren();
  }

  private show(): void {
    this.state.open = true;
    this.popup.hidden = false;
    this.popup.replaceChildren(
      ...(this.state.items.length
        ? this.state.items.map((path, index) => {
            const row = document.createElement("button");
            row.type = "button";
            row.className = "picker-item" + (index === this.state.cursor ? " is-active" : "");
            row.textContent = path;
            row.title = path;
            row.addEventListener("mousedown", event => {
              event.preventDefault();
              this.accept(path);
            });
            return row;
          })
        : [notice(this.state.pendingQuery ? `No files match “${this.state.pendingQuery}”` : "Type to search files…")]),
    );
  }
}

function notice(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "picker-empty";
  element.textContent = text;
  return element;
}

/** Turn a dropped or pasted file into an image chip payload. */
export async function readImageFile(file: File): Promise<PendingImage | undefined> {
  if (!file.type.startsWith("image/")) return undefined;
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? "").split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the pasted image"));
    reader.readAsDataURL(file);
  });
  return { type: "image", data, mimeType: file.type, name: file.name || "pasted image", bytes: file.size };
}
