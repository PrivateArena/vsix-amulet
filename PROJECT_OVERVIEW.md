# PROJECT_OVERVIEW — vsix-amulet

Goal: build **Amulet**, an open-source VS Code coding-agent extension, by studying the
shipped (closed-source) **Pendant 0.91.1** VSIX in `extension/` and rewriting it from
scratch. Motivation: Pendant should have been open source; we want an auditable,
contributable replacement.

## Hard constraint (read before writing any code)

`extension/LICENSE.txt` is an EULA. It **permits** inspecting, decompiling and
deobfuscating your own copy to understand it; it **forbids** copying its code into other
software. Consequence: everything under `extension/` and `deobfuscate/out/` is a
**read-only study surface**. Amulet is written from recovered *behaviour and contracts*,
never by pasting generated JavaScript. Do not import, paste, or mechanically transliterate
those files into Amulet sources.



| area | what it is | what we do with it |
|---|---|---|
| `extension/dist/extension.js` (1.3 MB) | esbuild-minified extension host | study → reimplement |
| `extension/dist/webview.js` (2.1 MB) + `dist/chunks/*.js` (138 chunks) | chat webview, code-split | study → reimplement |
| `extension/dist/pi-sdk-worker.cjs` | SDK worker process (the Pi session lives here) | study → reimplement |
| `extension/dist/tui-xterm-surface.js` | xterm.js surface for Pi TUI extensions | study |
| `extension/dist/chat-export.js.br` | brotli'd standalone transcript viewer | study |
| `extension/dist/locales/*.ploc.br` | 3.6k localisation ids + English text | naming/behaviour oracle |
| `extension/dist/guide/pendant-guide/*.md` | 20-chapter user guide = behavioural spec | already extracted, see docs |
| `extension/dist/pi-sdk*.cjs`, `dist/pi-sdk-assets/**` | **open-source Pi SDK** `@earendil-works/pi-coding-agent@1.4.0` | **depend on it from npm — do not reverse it** |
| `extension/package.json` + `package.nls.*.json` | the full external contract: commands, views, menus, keybindings, ~178 settings | copy the *contract*, reword the descriptions |

Biggest single finding: the agent core is not Pendant's. It is the published Pi SDK, and
`dist/pi-sdk-assets/pi-coding-agent/index.mjs` preserves its complete export list
(~157 named exports: `AgentSession`, `SessionManager`, `createAgentSession`, tools,
`RpcClient`, compaction, skills, extensions). So Amulet's real work is the **VS Code
product layer** around a published SDK, not an agent framework.

The bundles are minified but **not obfuscated** — no string encoders, no control-flow
flattening, no sourcemaps. All string literals survive, which is what makes recovery tractable.

## Repository layout

```
extension/      vendored VSIX payload — read-only input, never edited
deobfuscate/    pipeline that turns the payload into readable, anchor-named JS (see its README)
docs/           recovered reference material for the rewrite
amulet/         the rewrite itself — a VS Code extension (TypeScript + esbuild)
```

## Amulet — current state

Architecture (the shape the payload shows, now built):

```
webview  --postMessage-->  extension host  --Node IPC, JSON envelope-->  agent worker
(vanilla TS)               (vscode API only)                            (the only Pi SDK importer)
```

* **Worker** forks per workspace folder, runs `createAgentSession()` from the published SDK,
  forwards SDK events as `WorkerEvent`, and answers Pi extension-UI requests with real editor
  dialogs (`bindExtensions({ uiContext, mode: "rpc" })`). Crash isolation plus a bounded restart
  onto the same session file, like the payload does.
* **Host** owns settings, the worker lifecycle, the log channel, and palette commands (session,
  model, thinking level, compact, abort, restart).
* **Webview** rebuilds the transcript from `message_start` / `message_update` deltas /
  `message_end` (authoritative) and `tool_execution_*`, with a composer that steers while busy.
  Each tool call is one expandable card — `read src/cart.ts · 128 lines`, `bash npm test · exit 1`,
  `edit src/cart.ts · +2 −1` with the hunk coloured — built by a pure summariser so the rules can be
  tested without a DOM and reused in logs or notifications.
* **Resources** (`src/worker/resources.ts`, `src/host/managePanel.ts`): the SDK's resource loader is
  reported through as extensions, skills, prompt templates, instructions files and load failures, in an
  editor tab, with `Reload Pi config` guarded against interrupting a response or a compaction.
* **Context** (`amulet/src/shared/contextBlock.ts`, `src/host/`, `src/webview/composer.ts`): files
  attach as references, lines that cannot be re-read from disk attach as quoted text, and the host
  — never the webview — renders the whole draft into one marked block in front of the message.
  Entry points: `@` picker, editor selection (command, context menu, `ctrl+shift+'`), explorer
  files and drops, reported problems, pasted images, long-paste folding, quoting from the
  transcript, and the two auto-attach settings. Format and budgets: `docs/amulet-context-format.md`.
* Every value crossing a boundary is declared once in `amulet/src/shared/protocol.ts`.

Verification (`npm run check` in `amulet/`; both smoke tests make one real model call against the
configured provider inside a throwaway workspace and session directory):

| test | covers | status |
|---|---|---|
| `test/smoke-worker.mjs` | start, empty history, prompt, streaming, tool call, new session, switch back + transcript recovery, session list | PASS |
| `test/tool-summary.mjs` | tool call cards: counts, diff honesty, images, errors, and inputs that must not throw (24 checks, no model call) |
| `test/package-vsix.mjs` | unpacks the built `.vsix` and re-runs both integration suites against the files VS Code would load; also checks package contents and size |
| `test/context-block.mjs` | wire format, tag order, budgets, escaping and injection cases, round trip, mention parsing, draft merging (23 checks, no model call) | PASS |
| `test/host-activate.cjs` | `activate()` against a stubbed `vscode` API: registrations, CSP html, worker ready, selection/file/problem capture, dismissal and focus semantics, `@` search, assembled block reaching the worker, resource report, thinking-level availability, payload commands, palette-to-header sync, reload guards, the resources panel's HTML, run settled, reply content (38 checks) | PASS |

Not yet verified: rendering inside a real VS Code window (needs a live workbench). The webview's
chip and picker DOM is exercised only by types and by the host-side half of its protocol.

## Packaging

`npm run vsix` produces `dist/amulet-<version>.vsix` — **2.7 MB**, 19 files. The Pi SDK and its whole
dependency graph are bundled into `dist/worker.mjs`; the one package that stays a real package is
`@silvia-odwyer/photon-node`, which loads its `.wasm` relative to its own folder — the payload ships
that same library unpacked, for the same reason. Everything is MIT apart from that Apache-2.0
dependency, and `amulet/THIRD-PARTY-NOTICES.txt` names both: bundling is not a licence to drop
attribution. `npm run test:vsix` unpacks the built package and re-runs the integration suites against
the files VS Code would actually load, which is the only way the bundle is proven.

## Roadmap

1. **M1 — vertical slice** *(done)*: worker, host, webview, sessions, models, thinking levels, compact, abort, restart.
2. **M2 — context** *(done)*: references vs. quoted lines, `@` picker, selection/file/problem/image
   attachment, auto-attach rules with dismiss-then-stay-off memory, context chips on sent messages.
3. **M3 — product surface** *(done)*: what a chat pane needs before it is usable — tool calls that
   read as calls, model and session switching, the resource report and `Reload Pi config`, and a
   `.vsix` that ships and runs. Diff review moved to M4, the next milestone.
4. **M4 — changes**: per-tool-call edit tracking, diff view, revert, Git/SCM integration, commit prompt.
5. **M5 — session rail**: session list as a view, grouping, delete, branching and fork, search across
   workspaces. Switching, naming and the current marker already exist as quick picks.
6. **M6 — platform**: workspace trust, sandbox toggle, hooks, extension status widgets, TUI surface.
7. **M7 — extras**: voice, worktrees, subagent monitor, CI.

Deliberately not planned: speech-to-text prompting. It is a large, environment-specific surface for a
convenience, and an alpha needs a trustworthy core first.


## Recovered reference material

| file | how it was produced |
|---|---|
| `docs/amulet-context-format.md` | Amulet's own context block contract: tags, order, budgets, escaping rules, and which pieces came from the payload versus which are ours |
| `docs/pi-sdk-embedding-api.md` | the Pi SDK embedding contract, transcribed from the published package's own `.d.ts`, docs and examples (verified against v1.4.0) |
| `docs/pendant-behaviour-spec.md` | 1.8 k lines condensed from the 20-chapter shipped guide: process model, sessions, context assembly, changes, models, subagents, hooks (2 events), extension API, voice, remote, settings, limits, glossary, `[AMBIGUOUS]` register |
| `deobfuscate/out/INDEX.md` | binding → kind → line → anchor evidence; subsystem census over all bundles |
| `deobfuscate/out/PROTOCOL.md` / `.json` | every `type`/`kind`/`event` discriminant with sibling fields — the IPC envelope shapes |
| `deobfuscate/out/STRINGS.md` | all 3.6k localisation ids with English text, grouped by subsystem |
| `deobfuscate/out/annotated/*.js` | readable code with `// @rN [pendant-analysis] subsystem=…` banners |

## Subsystems the payload shows (recovered vocabulary)

`sessions` / `sessionTree` / `sessionRail`, `composer`, `chat` / `transcript`, `providers` /
`customProviders` / `models`, `scm` (git, commit prompt, changes), `worktrees`, `subagentMonitor` /
`subagentFleet`, `mcpManager` / `mcpPanel`, `packages`, `voice`, `sandbox` / `computerUse`,
`settingsPanel` / `settingsModal`, `bookmarks`, `hooks`, `runtime`, `host`, `chatExport`,
`themeDiagnostics`, `generationSpeed`, `piPanel`.


## Note on `extension/dist/core.wasm`

Part of the shipped product is not JavaScript at all: `core.wasm` (3.7 MB, plus `photon_rs_bg.wasm`
for image scaling) is a compiled core the host dispatches into by numeric method id — context-block
assembly, mention parsing, title sanitising. It is why some formats were reconstructed from their
JavaScript neighbours (host-side builders, webview-side parsers and validators) and from the shipped
guide's verbatim examples instead of being read directly. Nothing here disassembles it.
