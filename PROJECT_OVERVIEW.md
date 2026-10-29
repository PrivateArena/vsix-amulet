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

## What the payload actually contains

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
* Every value crossing a boundary is declared once in `amulet/src/shared/protocol.ts`.

Verification (`npm run check` in `amulet/`; both smoke tests make one real model call against the
configured provider inside a throwaway workspace and session directory):

| test | covers | status |
|---|---|---|
| `test/smoke-worker.mjs` | start, empty history, prompt, streaming, tool call, new session, switch back + transcript recovery, session list | PASS |
| `test/host-activate.cjs` | `activate()` against a stubbed `vscode` API: registrations, CSP html, worker ready, webview command path, run settled, reply content | PASS |

Not yet verified: rendering inside a real VS Code window (needs a live workbench) and context
attachment, which is the next milestone.

## Roadmap

1. **M1 — vertical slice** *(done)*: worker, host, webview, sessions, models, thinking levels, compact, abort, restart.
2. **M2 — context**: selection / active file / diagnostics attachments, marked context block, images, file mentions.
3. **M3 — changes**: per-tool-call edit tracking, diff view, revert, Git/SCM integration, commit prompt.
4. **M4 — session rail**: session list, grouping, rename, branching tree, search.
5. **M5 — platform**: workspace trust, sandbox toggle, hooks, extension status widgets, TUI surface.
6. **M6 — extras**: voice, worktrees, subagent monitor, `.vsix` packaging, CI.


## Recovered reference material

| file | how it was produced |
|---|---|
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

