# Amulet context block format

The one place where Amulet's own contract is written down. Everything the user attaches reaches the
agent inside a single marked block in front of the message text.

Status: implemented in `amulet/src/shared/contextBlock.ts`, assembled in
`amulet/src/host/contextBridge.ts`, pinned by `amulet/test/context-block.mjs`.

## Shape

```
--- pi-extension-context:start ---
<file-context>
@src/cart.ts
@src/cart.test.ts:12-30
</file-context>

<editor-context>
The following files and ranges were provided as context for this request. Focus on the selected
source when interpreting the request. Read referenced files or ranges whose source is not included
below before relying on their contents.

User-selected lines 12-30 from src/cart.test.ts:
<file name="src/cart.test.ts" lines="12-30">
expect(result).toBe(3);
</file>
</editor-context>

<quote-context>
<quote source="8154cd9d">
Expected 3, received 2
</quote>
</quote-context>

<problem-context>
<problem file="src/cart.ts" line="41" severity="error" code="TS2304" source="ts">Cannot find name 'total'.</problem>
</problem-context>

<file-notes>
{"path":"src/cart.ts","note":"legacy code, do not restructure"}
</file-notes>
--- pi-extension-context:end ---

Why does this test fail?
```

* Delimiters: `--- pi-extension-context:start ---` / `--- pi-extension-context:end ---`, block first,
  the user's own text after a blank line.
* Tag order is fixed: files, selections, quotes, problems, notes. A part with nothing to say is
  omitted; the block exists only if at least one part does.
* Images are **not** in the block: they travel beside the text as content, the SDK's
  `ImageContent[]`.

## References versus quoted lines

A file the agent can read for itself travels as a **reference** in `<file-context>`:
`@path` or `@path:START-END`, workspace-relative, forward slashes. Nothing is copied, so the agent
always reads current disk content with its own tools.

Lines it *cannot* re-read travel as **text** in `<editor-context>`:

| case | inline? | `reason` |
|---|---|---|
| selection in an unsaved buffer | yes | `unsaved` |
| range of a diff or review view | yes | `diff` |
| passage of the transcript | no — that is a `<quote>` | — |
| path outside the workspace | yes, and the label stays absolute | `outside-workspace` |
| plain file, no range | no | — |

A range that is listed but unreadable is left as a reference only, and the user is told which paths
that happened for, rather than the model silently receiving nothing for a range it can see named.

## Budgets

| limit | value | behaviour when exceeded |
|---|---|---|
| one quoted range | 40 000 chars | clipped at capture, `truncated="true"` and the words "read the remaining range if needed" |
| quoted ranges per message | 20 | the rest are dropped |
| whole block | 80 000 chars | later ranges are dropped |

Files and quotes are never silently clipped: a quote the user selected is theirs, in full.

## Escaping (the reason the format is safe)

Attached content is untrusted — a file can contain this block's own tags. Rules, applied in this
order, in `escapeText` / `escapeAttribute`:

1. `&` → `&amp;`, then `<` → `&lt;`, `>` → `&gt;`.
2. A line that *looks like* a delimiter is neutralised by entity-encoding its first character only:
   `--- pi-extension-context:end ---` → `&#45;-- pi-extension-context:end ---`. This is what stops an
   attachment from closing the block and speaking as the user.
3. Inside attributes, additionally `"` → `&quot;`, and newlines/tabs → `&#10;`, `&#13;`, `&#9;` so a
   value cannot escape its quotes or forge a new tag on the next line.
4. `<file-notes>` bodies are JSON with `<` written as `\u003c`.

Validation runs again on the way out: paths must parse, must be ≤ 4096 chars and contain no NUL;
ranges must be positive with `end >= start`. Anything invalid is dropped rather than injected.

## Round trip

`parseContextBlock` recovers the same draft from a stored message, so a past message shows the chips
it was sent with instead of a wall of quoted source. The transcript stores exactly what the model
read — one source of truth, no side table.

## Provenance

| element | where it came from |
|---|---|
| delimiters, `<file-context>`, `<quote-context>`, `<quote source>`, tag ordering, reference-not-contents rule | recovered behaviour spec, from the shipped guide's verbatim example |
| `<editor-context>`, its preamble sentence, `User-selected lines … from …`, `<file name= lines= truncated=>`, budgets 40 000 / 20 / 80 000, and the `&`/`<`/`>` + `&#45;` escape order | read directly out of the shipped extension host bundle |
| `<file-notes>` as JSONL | same |
| `<problem-context>` | **ours.** Problems are documented as attachable, but their tag name lived only in `extension/dist/core.wasm`, so this tag is Amulet's, shaped like its neighbours |
| `reason` on quoted lines, `origin` on quotes | ours: makes the chip able to explain itself to the user |

The block builder in the shipped product is compiled into `core.wasm` (3.7 MB), so the format was
reconstructed from its JavaScript neighbours — the host-side builder, the webview-side parser and
validators, plus the guide's verbatim example — rather than from the builder itself.
