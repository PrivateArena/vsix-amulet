# Amulet — Pi Agent for VS Code

A chat and agent surface for [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent),
running inside VS Code. Open source, MIT, no telemetry, no account, nothing leaves the machine except
the model calls you make yourself.

**Status: alpha.** The core loop works; see *What is not finished* before judging the edges.

## What you get

- A chat view in the activity bar that talks to your Pi provider set — the same sessions, the same
  `~/.pi` configuration, the same extensions and skills, in the editor instead of a terminal.
- Context that is attached, not guessed: `@` files, an editor selection, reported problems, images,
  quotes from the transcript. Files travel as references so the agent reads live content; only lines
  it could not re-read itself are quoted to it.
- Tool calls shown as they happen: what ran, what it returned, what it cost, expanded on demand.
- Sessions you can list, switch, name and compact, shared with `pi` in a terminal.
- A worker process, so a crash in the agent takes down the agent and not your editor.

## Install

1. Sign in to a provider once, in a terminal: `pi` then `/login`, or set an API key in the
   environment. Amulet uses the same credentials and config as Pi itself.
2. Install the extension: `Install from VSIX…` in the command palette, pick `amulet-<version>.vsix`.
3. Open the Amulet view in the activity bar.

## Building from source

```
npm ci
npm run check     # typecheck, build, and the suites described below
npm run vsix      # produces dist/amulet-<version>.vsix
```

The build is three bundles, because the product has three execution contexts: the extension host
(CommonJS, `vscode` external), the agent worker (ESM, with the Pi SDK bundled into it), and the
webview (ESM, no Node).

There is no test framework on purpose; the suites are scripts you can run directly:

| command | what it proves |
| --- | --- |
| `npm run test:context` | the context block format: tag order, budgets, escaping, injection cases, round trip |
| `npm run test:worker` | a real Pi session against a real model: streaming, a tool call, session switch, transcript recovery |
| `npm run test:host` | `activate()` against a stubbed `vscode` API: registrations, worker spawn, context capture, the text the worker actually received |

`npm run test:worker` and `npm run test:host` make real model calls in throwaway temporary
directories, so they need credentials and take about ten seconds.

## Architecture

```
webview  --postMessage-->  extension host  --Node IPC, JSON-->  agent worker (Pi SDK, own process)
```

The webview is untrusted UI and never sees the SDK. The host owns policy: which folder a worker runs
in, what counts as valid context, what a crash means. The worker is the only place that imports Pi,
and it reports everything over a typed protocol, so the transcript in the UI is always the transcript
on disk.

`docs/amulet-context-format.md` in the source repository specifies the context block, including
where its parts came from.

## What is not finished

- Diff review and revert of agent edits, per-file or per-message.
- Session branching and forking.
- Provider sign-in from inside the editor; use `pi` in a terminal for now.
- Windows and macOS: developed and tested on Linux. Contributions welcome, but assume rough edges.
- Markdown is rendered conservatively; long tool output is collapsed rather than paginated.

## Privacy

No telemetry, no crash reporting, no analytics, and no requests to any host except the model
providers your Pi configuration already talks to. Context attachments are sent to the model because
that is what asking about them means; nothing is sent anywhere else.

## License

MIT, see `LICENSE`. Amulet bundles the MIT-licensed Pi SDK and an Apache-2.0 WASM image library; the
attribution details are in `THIRD-PARTY-NOTICES.txt`.
