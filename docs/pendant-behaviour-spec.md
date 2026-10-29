# Pendant — behavioural specification (clean-room rewrite reference)

Synthesised solely from the Pendant user guide markdown at
`/media/jang/home/Deve/vsix-amulet/extension/dist/guide/pendant-guide/`
(README.md + chapters 01–20, 1798 lines, guide "Last updated: 2026-10-27", "Pendant release: 0.91.1").
No minified JS was consulted. Chapter citations are of the form `NN-file.md:LINE`.
Identifiers, keys, event names, file names and format names below are copied verbatim from the guide.
`[AMBIGUOUS]` marks places the guide does not pin down.

Pendant = a companion UI for the Pi coding agent (`https://pi.dev`), shipped as (a) a VS Code
extension and (b) a standalone desktop app. Pendant ships its own Pi; it is *not* open source, but
the EULA permits inspection/decompilation of your own copy for debugging (20-help.md:20).

---

## 1. PROCESS / COMPONENT ARCHITECTURE

### 1.1 Components

| Component | Responsibility (verbatim division from `02-pi-and-pendant.md:12-18`) |
| --- | --- |
| **Pi** (bundled SDK, separate process) | "The agent itself and its tools, the connection to model providers and your credentials, extensions, skills, prompt templates, and sessions." |
| **Pendant** (extension host + webview UI) | "The chat interface, how the agent's work is shown, the context it can take from your workspace, voice input, and how your sessions are listed and organised." |
| **You** | "Which providers and models you use, what the agent is allowed to touch, and keeping agents that work at the same time out of each other's way." |
| **Model provider** | Remote API, or a local model server. Optional: Hugging Face (voice model download only), npm registry (package browsing), the Pendant releases/site (manual download). |
| **Dictation helper** | "a small helper program" shipped with Pendant; records the mic and hosts whisper.cpp in-process (`14-voice.md:12-20`). |
| **Sandbox launcher** | OS-provided: macOS system sandbox (seatbelt), Linux `bubblewrap`. No Windows implementation (`10-settings.md:77`). |
| **Hook subprocess** | Your own command, run through the system shell (`13-hooks.md`). |
| **Phone app (unreleased)** | Connects directly to your computer over Noise (`15-remote.md`). |

### 1.2 Canonical data flow

`03-how-it-works.md:6` — "Pendant carries its own copy of Pi and runs it on your computer. You don't
install Pi or any other runtime separately, and nothing sits between Pi and the model provider you
chose."

`03-how-it-works.md:15` — "When you send a message, Pendant adds the context you allowed and hands
the message to Pi."

`03-how-it-works.md:19` — "Pi runs inside Pendant, in a background process of its own, apart from
the interface. It keeps the session, talks to your model provider directly and runs its tools on
your computer. While it works, it reports every step, such as text as it is written, its thinking,
tool calls and their results. Pendant turns these reports into the live transcript you watch."

`03-how-it-works.md:25` — "Nothing on this path passes through a Pendant server."

Guide's own `flow` block (`03-how-it-works.md:8-12`), one box per `label | caption` line:

```
Your workspace | your code and files
Pendant | the interface | highlight
Pi | built into Pendant | highlight
Your model provider | or a local model
```

`diagrams/data-flow.svg` boxes: `Chat (the interface)` → `Pendant (adds context)` → `Pi (the agent)` →
`Provider (your model)`; forward arrows labelled `message`, `prompt`, `request`; return arrows labelled
`live view`, `events`, `reply`; plus `tools on your computer` under Pi.

`diagrams/prompt-assembly.svg`: `Attached files` + `Quotes` → `context block` → joined with
`Your message` (`your text`) and `Pasted images` (`images`) → `one message to Pi` → `Pi`.

### 1.3 IPC boundaries

* **UI ⇄ Pi worker.** Only documented as "a background process of its own, apart from the interface"
  (03:19). Pi streams *events* (text deltas, thinking, tool calls, tool results) upward; Pendant
  renders them. Pi exposes an RPC-shaped extension UI surface (`ctx.mode === "rpc"`, Pi docs anchor
  `rpc-extension-ui`), so an RPC protocol exists between UI and worker. `[AMBIGUOUS]` exact transport
  (stdin/stdout JSON-RPC vs socket) and message framing are not described in the guide.
* **Pi → provider.** Direct HTTP; no Pendant intermediary (03:25, 19-privacy.md:8).
* **Pendant UI ⇄ editor host (VS Code).** Settings live in editor settings and are mirrored in
  Pendant's own screen (`17-vscode.md:14`); views, tabs, context-menu and explorer contributions
  (`17-vscode.md:20-42`); a hook log appears "in the editor's output view" (`13-hooks.md:74`).
  `[AMBIGUOUS]` whether the webview talks to the extension host directly, and how the Pi worker is
  spawned (the guide says only "a background process of its own").
* **Desktop runtime.** Additional processes/services are implied by "a restarted workspace service"
  (`18-desktop.md:196`), "Readers, decoders and rendering belong to each view's worker"
  (`18-desktop.md:171`), GPU/WebGL2 context failure fallbacks (`18-desktop.md:139,173`).
  `[AMBIGUOUS]` process topology of the desktop app (Electron-style split not stated).
* **Phone ⇄ computer.** Direct, LAN or same Tailscale tailnet, "encrypted end to end", Noise protocol
  framework, per-device keys; "Until the encrypted handshake completes, neither device says anything
  about itself or your sessions … A computer also stops accepting an address that fails the handshake
  repeatedly." (15-remote.md:39-45). Each editor window accepts phone connections "on its own port"
  (15-remote.md:53).
* **Reload semantics across the boundary.** "Pendant restarts Pi on its own once no session is
  running" for settings that change how Pi starts (`10-settings.md:16`); the Pi folder location needs
  a Pendant restart (`10-settings.md:17`). `ctx.shutdown()` "closes that session's Pi and leaves
  Pendant running" (`11-extensions.md:113`).

### 1.4 What lives where (persistence)

* Pi configuration folder (settings, providers, credentials, extensions, skills, prompt templates,
  sessions) — same folder as terminal Pi; overridable (`03:27-31`, `10-settings.md:82`).
* Session files: "Pi stores each one as a file in its own folder for sessions, grouped by
  workspace" (`07-sessions.md:6`); example path in the hook payload:
  `/path/to/agent/sessions/project/session.jsonl` → sessions are JSONL (`13-hooks.md:41`).
* Pendant-only state: pins, colours, prompt history, preferences, downloaded voice models
  ("Pendant's own storage on your computer, not in your project") (`07:6`, `19-privacy.md:28`,
  `14-voice.md:52`).
* Search index: "built in memory while Pendant runs and is never saved" (`07-sessions.md:16`).
* Worktrees: "a hidden folder inside your repository", new branch (`07-sessions.md:40`).
* Remote-access keys + paired-phone list kept on the computer; phone key in the OS secure keychain
  (15-remote.md:49).

### 1.5 Version / distribution rules

* "Each Pendant release includes one specific version of Pi, tested together with it… You can't point
  Pendant at a different Pi installation." (`03:35`); reaffirmed in `16-limits.md:14`.
* VS Code extension installable from the Marketplace or Open VSX; every release is also a hand-
  installable file on `/releases`, a zip archive (17-vscode.md:8, 62).
* Installed extension = "an ordinary folder inside your editor's extensions folder, named after the
  extension and its version" (17-vscode.md:62).
* Requires a desktop editor; "does not run in browser-based versions of VS Code" (17-vscode.md:58).

---

## 2. SESSION MODEL

### 2.1 Identity and storage

* Every conversation is "an ordinary Pi session" written through Pi in Pi's own format: "Pendant never
  edits Pi's session files by hand. It never rewrites, reorders or removes what a session already
  holds." (19-privacy.md:20).
* Files are JSONL, grouped by workspace under Pi's sessions folder (07:6; example path 13:41).
* Pendant's own additions are *entries inside the session*: "The chat's tool set and the skills you
  switched off are Pendant's own entries. Pi keeps them the way it keeps data from extensions and
  never shows them to the model." (19-privacy.md:24). Renaming a session and editing/omitting model
  visible content are "Pi's own kinds of entries" (19-privacy.md:24).
* Pins and colours are Pendant-side metadata, not session entries (07:6).
* Bookmarks "are saved in the session", show on other devices, and "carry over when you branch"
  (09-conveniences.md:48).
* Tool-result `details` (including `details.pendant`) are "saved … in the session file unchanged", so
  published views re-appear on reopen with nothing re-running (11-extensions.md:180).
* Deletion: "Deleting a session removes its file for good. It does not go to a trash folder."
  Removing a worktree keeps its sessions: "The worktree's sessions stay in your history." (07:46,54)

### 2.2 Lifecycle

* Start: new chat starts with Pi's default model unless a default model star / default preset is set;
  model/thinking/tools can be changed before the first message (05:26, 05:41, 05:52).
* Running: session shows "the step it is on, for example running a test command or reading a file" (`07-sessions.md:12`); a
  working-indicator dot per subagent child; session counts as *busy* while a subagent is active.
* Idle: tool set / skills / model may be changed; extension reloads apply to idle sessions at once.
* Stop: "Pi cancels the model's answer and the tool that is running, and any question an extension
  was waiting on is closed. What the agent already did stays done." (09:32)
* Reload in place: skills toggle "reloads in place and keeps its conversation" (05:66); extension
  reload "keeps the conversation" but clears widgets/statuses/title/working message/thinking label,
  returns open dialogs as dismissed and closes custom components, while "Text in the composer and the
  tool expansion stay as they were." (11:23)
* Close: `ctx.shutdown()` closes that session's Pi only (11:113).

### 2.3 Concurrency

* "Each open chat has its own session, and they run side by side. Pendant does not keep them out of
  each other's way." (07:50) — coordination is the user's job; worktrees are the sanctioned split
  (16-limits.md:12).
* Undo of recorded edits is refused while "no session in that workspace is running" is violated
  (08:13, 04:41).

### 2.4 Branching / forking / cloning

`07-sessions.md:36-40`:
* **Fork** — "Fork from one of your messages to continue from that point in a new session. It opens in
  the same view or in a new tab."
* **Edit-and-branch** — "Edit one of your messages, and the edited version is sent as a new branch
  from that point."
* **Clone** — "Clone a session to copy the conversation as it stands."
* Tree navigation exists via `ctx.navigateTree` even though "Pendant's own conversation tree explorer
  is disabled"; "Navigating changes the active conversation branch. It does not restore workspace
  files. Forking a session and undoing eligible recorded edits are separate operations." (11:115)
* List grouping: "A branch, a clone or a worktree session appears under the session it came from." (07:8)
* Forked subagent sessions are hidden from the list (12:102).

### 2.5 Naming

* Manual rename, plus optional automatic naming: "It then sends your first message to your model
  provider, in a separate temporary session, and asks for a short title. This is off until you turn
  it on." (07:22)
* `pi.setSessionName` changes are reflected in the UI (11:107); `ctx.ui.setTitle` sets the *view/tab*
  title only — "The session name stays unchanged. An empty title removes it." (11:49)

### 2.6 Worktree sessions (`07-sessions.md:40-48`)

* Runs "in its own Git worktree, on a new branch, in a hidden folder inside your repository".
* Can copy selected ignored files (e.g. local settings) into the new worktree.
* Can run per-worktree setup commands; "Your first message waits until setup finishes"; on failure you
  can retry or continue; commands "run in your shell, outside the sandbox, and only in a trusted
  workspace".
* Requires a trusted workspace and "a Git repository with at least one commit".
* Removal first shows uncommitted files and whether the branch is also removed.

### 2.7 Compaction (`06-context.md:78-84`)

* Trigger: Pi automatically "when the context gets close to full, unless you turn automatic compaction
  off" (a Pi setting, shared with terminal Pi). Manual compaction available; "Pendant asks first,
  because compaction can't be undone"; suggested when the context meter shows near-full.
* Mechanism: "Pi keeps the recent part of the conversation as it is and replaces the rest with a
  summary."
* Queued compaction: type `/compact` while the agent works or choose **Add compaction** under the
  queue; draggable; "Messages above it go out first, and messages below it go out after the context is
  compacted. A queued compaction doesn't ask first… If it fails, the queue carries on." (09:16)
* Not offered while a subagent run is active (12:112).

### 2.8 Restore / reopen semantics

* Long sessions "load their most recent messages first. You can change how many." (10:28)
* Cards restored from the session file; "A session opened again from history starts with every card
  closed, whatever `expanded` says" (11:206); "Background runs of pi-subagents that are still going are
  picked up again." (12:106)
* Drafts survive "a reload or a restart"; a draft on the start page "carries over into the chat it
  starts" (09:26).
* `[AMBIGUOUS]` whether an open chat is restored at startup by default — VS Code has a setting "to
  open the session you used last when it starts, instead of the start page" (17:16) but no default is
  stated.

### 2.9 Workspace mapping / multi-root

* Session list = "the sessions of the workspace you have open" (07:8).
* Cross-workspace access: "A session from another workspace opens read-only, and Pendant offers to open
  its folder in a new window." (07:16)
* Search scope: this workspace or all of them (07:16).
* File references are paths "relative to your workspace" (06:22); shell commands "run in your
  workspace" (09:22).
* Per-workspace scope for changes: "When a folder is open, a change you make in Pendant applies to
  that workspace. Otherwise it applies to your user settings." (17:14)
* `[AMBIGUOUS]` the guide never says what happens with a multi-root VS Code workspace (one list per
  folder? which root are `@` paths relative to?).

### 2.10 Export

* "You can export a chat as a web page to read or share. You can also export a session as a bug
  report. Personal details are redacted, and you decide whether diagnostic logs go with it." (07:52)
* Exports start with the user's display choices (thinking / timestamps / raw tool data); "The exported
  page can still change them." (10:96)

---

## 3. CONTEXT ASSEMBLY

### 3.1 Principle

"Pi only knows what reaches it in your message and what it reads with its own tools. Pendant adds
only the context you attach." (`06-context.md:6`)
"Pendant adds no system prompt of its own and no hidden instructions. Only your own setup changes
Pi's system prompt." (`06-context.md:88`)

### 3.2 Attachment entry points (`06-context.md:12-27`)

1. Mention a file or folder by typing `@` in the message.
2. Drop files/folders from the editor or file manager onto the message box (in VS Code you must hold
   **Shift** while dragging, "VS Code keeps a drag for itself until you hold Shift", 17:36).
3. Pick files from a list.
4. Send a reference to the lines selected in the editor (also from the editor context menu, 17:34).
5. Pick lines by their line numbers and add them to the chat.
6. Quote a change from a diff.
7. Pin the file you have open, with the lines selected in it.
8. Auto-attach selection: select lines, then click into the message box; "attached with its line
   range. If you remove it, it stays off until you select something else. You can turn this off in the
   settings."
9. Auto-attach open file (off by default): "The file follows you when you switch files. If you remove
   it, it stays off until you switch to another file."
10. Select text in the transcript and quote it; the sent quote badge "takes you back to the passage".
11. Paste an image.
12. File explorer → "Add files to the chat" (17:35).
13. VS Code: "start a new chat beside the file you are editing. That last one attaches the file to the
    new chat." (17:26)
14. Desktop: file links / explorer openers are viewers only — "Previewing a PDF does not make it an
    attachment the chat model can read" (18:66); same for images (18:136) and 3D models (18:152).

Long pastes: "Pendant folds it into a small badge, so your message stays readable. The whole text is
still sent." (06:29)

### 3.3 Files travel as references (not contents) — `06-context.md:22-32`

* "An attached file is sent as its path, relative to your workspace. When you attached a selection,
  the path carries its line range. The agent then reads the file itself with its tools, so it always
  works with the current content. A reference to selected lines works the same way. It names the lines
  and does not copy them."
* Exception — un-readable-from-disk lines are quoted inline: "a change in a diff, an older version of
  a file, or a file you haven't saved. Pendant quotes those lines instead. It copies them into your
  message, with the file and the lines they come from."
* Consequences stated: small messages; agent sees disk state; "a file outside the agent's reach, for
  example on another machine, does not help it."

### 3.4 Images — `06-context.md:34-38`

* A pasted image "travels with your message as an image, for models that accept images… a message can
  carry a few of them."
* "Before the image goes to the model, Pi may scale it down or convert it, and it tells the model when
  it did."
* An image *file* that is dropped/attached is "a file reference like any other file".

### 3.5 The context block — exact wire format (`06-context.md:40-72`)

"Pendant puts all context in one marked block in front of your message. Inside it, each kind of
context has its own tag, always in the same order. Attached files come first, then quotes. A part with
nothing to say is left out. Images travel next to the text, not inside it."

Verbatim example (`06-context.md:50-68`), text exactly as Pi receives it:

```
--- pi-extension-context:start ---
<file-context>
@src/cart.ts
@src/cart.test.ts:12-30
</file-context>

<quote-context>
<quote source="8154cd9d">
Expected 3, received 2
</quote>
</quote-context>
--- pi-extension-context:end ---

Why does this test fail?
```

* Delimiters: `--- pi-extension-context:start ---` / `--- pi-extension-context:end ---`.
* Tags observed: `<file-context>` (lines of `@rel/path` or `@rel/path:START-END`), `<quote-context>`
  containing `<quote source="…">`, where `source` "names the session entry of the response it came
  from, which is how its badge finds the passage again."
* `[AMBIGUOUS]` the guide shows only these two tags; other context kinds (git state, problems, pinned
  selection) are listed as *attachable* in 04-capabilities.md:15 but their tag names inside the block
  are never shown.
* UI vs wire: "In the chat, Pendant shows only your text, with the context as small chips above it.
  The block above is what is stored in the session and what the model reads."

### 3.6 Expansions that happen before Pi sees the text (`06-context.md:74-78`)

* Prompt templates and slash-selected skills: "Pendant expands it into your message before sending.
  The expanded text follows the context block."
* Commands Pi or an extension handles itself are "sent exactly as you typed them, without a context
  block."
* Shell command from the message box: "runs directly, without an agent turn. Its output is recorded in
  the session, so the agent sees it with your next message."
* Consequence for extensions: "An `input` handler can therefore receive more text than the user typed.
  Its `source` is `"interactive"`. Messages that start with an extension command are the exception and
  reach Pi exactly as typed." (11:99)

### 3.7 Context sources named elsewhere

* 04-capabilities.md:15: "Attach files, folders, selections, problems reported in your code, the
  state of your Git repository, and images, without copying and pasting. You decide which kinds of
  context Pendant may include." → per-category user permission switch exists.
* Git state as context is used by the commit-message and PR-description generators (08:20-31) and by
  `footerData` ("reports the workspace's Git branch and the extension statuses", 11:56).
* Diagnostics are attached as *problems*; the desktop editor computes them from language servers, and
  "A file you are still editing is checked as it is on screen, not as it was last saved." (18:34)

### 3.8 Post-hoc context surgery (`06-context.md:80-88`)

* **Omit** a tool call, one of your messages, or one of the agent's replies. "Omitting a tool call
  also omits its results. When a reply made several tool calls at once, they are omitted together."
* **Edit** — for a tool call "only its result changes".
* **Restore** — "bring back the original".
* Transcript keeps showing the original, "marked as omitted or edited". Stored as "one of Pi's own
  entries, so it holds when you open the session again."
* Not permitted: while the agent is working; for "a reply that failed or was stopped"; "for anything
  compaction has already summarized".

### 3.9 Token budget rules

* Only mechanism described: the **context meter** — "A small meter shows how much of the model's
  context window the session uses. It warns you as the window fills up" (09:66) and drives the
  compaction suggestion (06:84). Each model's context-window size is shown in the model picker
  (05:22).
* No hard truncation budget for attachments is documented. `[AMBIGUOUS]` whether Pendant caps total
  attached bytes/tokens; only commit-message diffs are described as truncated ("A very large diff is
  cut short, and the model is told that the list of files is still complete", 08:26).

---

## 4. CHANGES / REVIEW

### 4.1 Tracking and display (`08-changes.md:8-12`)

* "The agent edits files on your computer." Edits are recorded by Pi/Pendant during the run; "Edits
  and new files appear in the chat as diffs while the agent works."
* "A long diff can open in a full editor tab instead." Threshold is a user setting: "Choose how large
  an edit must be before it opens in its own editor tab. Small finished edits open by themselves in the
  chat, and you choose up to which size." (10:34)
* "After a turn that changed files, a summary lists them, each with its diff." Summary is configurable:
  off / tree vs full paths / every file or only the first few (10:35).
* Diff layout: side-by-side or unified (10:32). Markdown diffs: formatted text or raw diff, plus a
  per-edit switch (10:33).
* Tool cards for built-in tools "show edits as diffs and command output as it arrives" (11:139).
* In VS Code a chat tab is an ordinary editor tab and diffs open in editor groups (17:22-30).
* Desktop: "A full code editor … where you also review the agent's changes as diffs" (18:12); gutter
  marks show "what changed since the last commit" (18:36).

### 4.2 Undo / revert (`08-changes.md:14-18`)

* Scope: "the text edits the agent recorded", launched from the changed-files summary.
* "Pendant asks first, because an undo can't be taken back."
* Preconditions: "This works as long as the file has not changed since, and no session in that
  workspace is running. Pendant refuses rather than overwrite work it cannot account for." (also
  04:41-42)
* Undo is per-workspace-wide-idle, not per-session; it is independent of forking (11:115).
* `[AMBIGUOUS]` whether command-made (bash) changes are ever undoable — the guide says only "text
  edits".

### 4.3 Git interaction

* "Git stays the full record of your work. Commit often, and worktree sessions keep an agent's changes
  apart." (08:18)
* VS Code: "Write a commit message with a button in the Source Control view." (17:39)
* GitHub Pull Requests extension: "Pendant can write the description in its view for creating a pull
  request." (17:40)
* Git config protection under the sandbox: configuration "that Pendant, Pi, Git, your editor or your
  shell would later run outside the sandbox stays read-only, for example Pi's extensions and Git
  hooks" (10:73).
* Desktop Git view: "review, stage and commit your changes, to switch branches, and to fetch and sync
  with your remote" (18:16). Staging UI is desktop-only; in VS Code staging is the editor's own.
* Branch switching: "any branch that already exists on your computer… Pendant asks you to confirm
  first. If Git cannot switch, Pendant shows its message. Creating branches, merging and rebasing stay
  with Git itself." (18:222)
* Worktree creation/removal flows as in §2.6.

### 4.4 Commit message generation (`08-changes.md:20-38`)

Inputs, in the order described:
1. "It reads your staged changes. If nothing is staged, it reads the changes in files Git already
   tracks. New files that Git does not track yet appear by name only."
2. "It also sends the branch name and the list of changed files."
3. "If you already typed a message, it goes along as a hint."
4. Optional user instructions, "as text or from a file in your repository", plus a language choice.
Redactions: "Files that look sensitive, for example keys or environment files, keep their name but not
their content." Over-size: "A very large diff is cut short, and the model is told that the list of
files is still complete."
Execution: "written in a separate temporary session, apart from your chats. It uses the model and
thinking level of the chat you are working in, unless you choose others in the settings."
Output: "The result replaces the text in the commit message box."
Auditability: "you can open the prompt and the model's reply from the last generation. Pendant keeps
that in memory only."
Egress: "The diff and file names go to your model provider, like any other prompt. With a local
model, they stay on your computer."
`diagrams/commit-message.svg`: `Staged changes` (or `the working tree`) + `Branch and file list`
(`plus your draft, if any`) + `Your instructions` (`optional`) → `Temporary session`
(`apart from your chats`) → `Commit message` (`in your message box`); footnote in the SVG:
"Contents of files that look sensitive are held back. Only their names are sent."

### 4.5 Pull request descriptions (`08-changes.md:32-36`, `18:26-28`)

* Reads "the branch's commits and its diff against the base branch"; has "its own setting for
  instructions".
* Output "opens as a new document, with the title on the first line and the description below it"; in
  desktop it "opens in a new editor tab, where you can edit it, copy it or save it".
* Base selection (desktop): "It compares your branch with the branch it would be merged into. It looks
  for a main branch on the remote your branch follows first."
* "You can stop a description while it is being written. If your branch has nothing to describe, or no
  branch to compare with, the app tells you why."

---

## 5. MODELS / PROVIDERS

### 5.1 Connecting a provider (`05-models.md:10-16`)

* **Plan sign-in** — "you sign in with your existing subscription in the browser, or with a code on
  another device. Pi runs the sign-in."
* **API key** — paste a key.
* **Custom provider** — "Point Pi at any server that speaks one of the common model APIs, for example a
  local model server. Pendant can ask the server which models it offers."
* Storage: "Pi stores what you connect in its own configuration folder, where Pi in a terminal finds it
  too. Pi keeps one credential per provider, so a new key or sign-in replaces the old one. A key that
  comes from an environment variable is shown as such. While a run is going, credentials can't be
  changed."
* `[AMBIGUOUS]` the concrete provider list is never enumerated — the guide only distinguishes "Pi's
  built-in providers", "your custom providers" and "providers that Pi extensions add" (05:20).

### 5.2 Model picker (`05-models.md:18-26`)

* Lists every model Pi can use right now, from all three sources above.
* Search matches "the model's name, its identifier and its provider".
* Each model shows "the size of its context window"; image-capable models are marked and searching
  `images` / `vision` finds them.
* Live reload of Pi's custom-models list: "the model list updates on its own. If Pi can't load the file
  after a change, the list stays as it was until the file loads again."
* If Pi's settings restrict a model set, "the list also offers that set on its own, and opens on it."
* Picking a model/thinking level is per-session: "it applies to that session only, as it does with
  Pi's own commands in a terminal. Pi's defaults for new sessions stay as they are."

### 5.3 Thinking levels (`05-models.md:28-34`)

* "The thinking levels on offer are the ones the current model supports."
* Downgrade rule: "If you switch to a model that doesn't support your level, Pendant moves to the
  nearest one it does."
* "For a model that doesn't think at all, the control disappears."
* "Thinking is hidden in the transcript unless you choose to show it. It is part of the session either
  way." Transcript preference: start open / start folded / fold when done (10:27).
* `ctx.ui.setHiddenThinkingLabel` sets the title of thinking blocks (11:48).

### 5.4 Presets (`05-models.md:36-52`)

* A preset = model + thinking level, as a button beside the composer. Add current choice, rename,
  reorder. "A preset whose model is not available is shown but can't be used."
* Presets live in the model picker; **Manage presets…** edits them.
* **Show in composer strip** per preset: once any preset has it, presets appear "as a strip before the
  model selector"; model and thinking buttons stay next to it; overflow "folds into one button that
  shows the current preset and opens the full list"; presets without the switch are not in the strip;
  "The model picker always lists every preset."
* Default model: hover a model in the picker → click the star; "Click a filled star to clear it."
* Default preset: **Default preset** in settings. "It overrides the default model. If its model isn't
  available, Pendant uses the default model instead. A default only applies to new chats."

### 5.5 Tool sets (`05-models.md:54-62`)

| Choice | Contents |
| --- | --- |
| **Pi's defaults** | "the tools your Pi setup names as defaults, otherwise reading, running commands, editing and writing files, plus the tools of your extensions" |
| **Read-only** | "Only reading and searching files, with no extension tools." |
| **None** | "No tools at all." |
| **Your own set** | "Any built-in tools you pick." |

* "The choice belongs to the chat. It is saved with its session and never changes Pi's own settings."
* New chats start from the set chosen in Pendant's settings; changeable before the first message and
  afterwards "whenever it is idle. An extension may still adjust them for a turn."
* Application order vs extensions (11:103): "A saved choice is applied before prompts, steers and
  follow-ups, so it can replace a tool set chosen earlier with `pi.setActiveTools`… An identical set is
  left alone. Without a saved choice or a preset seeding a fresh session, Pendant keeps Pi's
  selection. A tool set chosen in a `before_agent_start` handler holds for that turn. This selection
  also respects Pi's hidden and callable-only tool exposure rules."

### 5.6 Skills (`05-models.md:64-68`)

* Per-session switches to stop auto-invocation; "You can still use such a skill by calling it with a
  slash. The switch is saved with the session, which reloads in place and keeps its conversation."

### 5.7 Prompt templates (`05-models.md:70-78`)

* Stored "in Pi's own configuration folder and in your project"; started with `/` + name; arguments
  fill placeholders the Pi way; "Pendant can show a small form with one field for each argument"; shows
  "a preview of the prompt as Pi will receive it".
* Create/edit from Pendant; external changes appear in the slash list automatically; a template that
  fails to parse is reported once and listed with "Pi's reason".

### 5.8 System prompt and resource loading (`05-models.md:80-86`)

* Replace Pi's system prompt (text or file); **append** prompts; **stop reading context files** such as
  `AGENTS.md` and `CLAUDE.md`; **load extra extensions, skills or prompt templates** from named paths,
  or stop automatic discovery.
* "Pendant hands these settings to Pi as they are. Pi's context files and skills are still added after
  a system prompt you set. When you change one of these settings, Pi restarts with it once no session
  is running."

### 5.9 Pi packages (`05-models.md:88-98`)

* Browse = "searches the npm registry for packages marked as Pi packages"; installing needs npm.
* Scope = user scope or the open project; "The project scope needs a trusted workspace."
* Off switches: whole package, or individual extensions/skills/prompts inside it.
* Updates: "Pendant checks for updates and offers them, unless you work offline."
* Recommendations: "Your list of installed packages also recommends a few packages that Pendant
  supports especially well. A package leaves the recommendations once you install it. You can dismiss
  them. The package manager's menu brings them back."
* Reload: "Extensions run with the same access as the agent, in every new session. After a change, idle
  sessions reload right away. A session that is working reloads after its current turn."

### 5.10 Cost / usage display (`10-settings.md:94`)

* "For subscriptions that report it, the footer shows how much of your usage limit is left. For
  providers with a credit balance, the model's tooltip shows it. Both can be turned off."
* Per-run cost appears in subagent cards (§6). `[AMBIGUOUS]` no per-message or per-session $ display is
  described for ordinary turns.

### 5.11 Cache warming (`05-models.md:100-102`)

* "Pi can keep that cache warm while the agent runs, or also while the session is idle, or not at all.
  This is one of Pi's own settings… Choose it in the Pi panel."

### 5.12 Pi panel / Pi-specific surfaces

* "Pi panel" hosts: switching from a private Pi folder to the standard one (11:14), cache warming
  (05:102), **Extension actions** picker (11:311).
* "Pendant can open Pi's own files for you, for example its settings and its list of custom models."
  (10:12)
* Retrying: "Pi retries on its own when a provider reports a passing error, such as a rate limit or a
  timeout. You can turn that off." (10:65)

## 6. SUBAGENTS (`12-subagents.md`)

"Pendant does not run subagents itself. It recognizes the tools of subagent extensions, follows their
runs and shows them in the chat." (12:6)

### 6.1 Recognized extensions — exact, case-sensitive tool names (12:10-18)

| Extension | Tools | Pendant affordance |
| --- | --- | --- |
| `pi-subagents` | `subagent` | Cards, subagent panel, transcripts, controls to interrupt / steer / stop / resume / answer |
| `@tintinweb/pi-subagents` | `Agent`, `get_subagent_result`, `steer_subagent` | Cards and the subagent panel |
| `pi-subagents-j0k3r` | `subagent_run`, `subagent_continue`, `subagent_status`, `subagent_result`, `subagent_list_tasks`, `subagent_cancel`, `subagent_list_agents` | Cards and the subagent panel |

Other subagent extensions "still work as ordinary Pi extensions. Their tools get ordinary tool cards."
Their runs appear in the panel only via the disk-session rule below.

### 6.2 Detection algorithm (12:22-28, ordered)

1. **Tool name** — a name from the table ties the call to that extension; arguments/results are then
   parsed in that extension's format. "A name match always wins."
2. **A subagent session on disk** — any other tool name counts as a subagent run only when its result
   `details` has `asyncDir` or `nested_session_path` set to a **string**. "Such a run belongs to an
   unknown extension."
* "No other field counts. A tool that reports an `agentId`, a `status` or a list of agents keeps its
  ordinary card and stays out of the subagent panel."
* Unknown-extension runs: appear in the working indicator and panel, keep an ordinary card, and "never
  outlive the turn that started it."
* `diagrams/subagent-detection.svg` mirrors this: known name → "That extension's run: card, panel,
  controls"; unknown name + "The details point to a session on disk" → "An unknown run: panel only,
  plain tool card"; note "a name match always wins".

### 6.3 Call roles (12:36-42)

* **Launch** — `subagent`, `Agent`, `subagent_run`. Exception: "a `subagent` call that has a non-blank
  `action`" manages an existing run/agents instead. "A call that resumes a step is the one kind that
  adds a run. The revived step becomes a run of its own, marked as resumed."
* **Continue** — `subagent_continue` sends a follow-up to an existing run.
* **Manage** — every other recognized tool; never creates a run; "its card shows the tool's result text".

### 6.4 Field-reading rules that apply to all formats (12:46-54)

* "Nothing is guessed. A missing field, or a field of the wrong type, stays empty."
* "Empty text counts as missing."
* **Cost** = number, or an object with one of `totalUsd`, `total`, `usd`, `amount`, `cost`, `costUsd`.
* **Agent names** from launch args must match "a letter, followed by up to 63 letters, digits, `_`, `.`
  or `-`" (i.e. ≤ 64 chars, `[A-Za-z][A-Za-z0-9_.-]{0,63}`); "Other names are dropped. A step without an
  agent name shows as `subagent`."
* **Statuses** are mapped to Pendant's own; "A status Pendant does not recognize becomes unknown and
  counts as still running. A run without a status of its own takes one from its steps."
* "If the call that launched a run fails, the run is marked failed, with the call's text as its error."
  (12:90)

### 6.5 Per-format fields

**pi-subagents** (12:58-66)
* Launch: `tasks` with >1 item → parallel run; `chain` with >1 item → chain; else one step. Agent named
  by `agent` or `name` per item; top-level `agent` names a single run's agent; `task` → label;
  `async: false` → foreground; otherwise treated as background "until the call's own progress or result
  shows it runs in the foreground".
* Run: `runId` or `asyncId` = id; `state` = status; `activityState` flags "needs attention or runs
  long"; also `error`, `startedAt`, `endedAt`, `totalTokens` or `totalChildUsage`, `totalCost`. "A
  result with `asyncId` or `asyncDir` belongs to a background run."
* Steps from `steps` or `progress`; per step: id from `workflowKey` or `childId`, plus `agent`,
  `status`, `label` or `task`, `model`, `thinking`, `activityState`, `currentTool`, `currentPath`,
  `recentTools`, `turnCount`, `toolCount`, `tokens`, `totalCost`, `startedAt`, `endedAt`,
  `lastActivityAt`, `error`, `transcriptPath`. From `steering`, "what became of the newest message sent
  to the step".
* Workflows: with `mode` = `workflow`, also reads `workflow.trace` (steps), `workflow.value`, `mission`
  (times), `workflowChildren.children`.
* Waiting: a `bg_wait` call keeps an ordinary card; each run in `completions` takes `state` there, or
  `completed`/`failed` from `success`.
* Results: items in `results` fill gaps — outcome, `transcriptPath`, `model`, cost, duration,
  `finalOutput` or `output`.

**@tintinweb/pi-subagents** (12:68-72)
* Launch: `subagent_type` = agent, `description` = label, `run_in_background: true` = background.
  "A run always has one step."
* Results: `subagentType` or `displayName`, `status`, `modelName`, `turnCount`, `maxTurns`, `toolUses`,
  `tokens`, `error`, `activity`, `description`, and `agentId` as the run's id.

**pi-subagents-j0k3r** (12:74-78)
* Launch: `agents` (list of names) or `agent`; `task` = label; `mode: "background"` = background.
  `subagent_continue` "only reads `prompt`".
* Results: steps from `tasks`, `results` or a single `task`; per step `id`, `agent`, `status`, `task`,
  `model`, `effort`, `last_activity`, `output_preview`, `usage`, `attempt`, `started_at`, `ended_at`,
  `last_activity_at`, `nested_session_path`, and `error` with `error_metadata`.

**Unknown extensions** (12:80-88)
* Launch agent from first item of `agents`, `tasks` or `chain`, else `agent`, `name`, `subagent_type`,
  `subagentType`; label from `task`, `description`, `prompt`.
* Steps from the first of `tasks`, `results`, `steps`, `progress` that "holds an item with `status` and
  either `agent` or `subagentType`"; takes `agent`/`subagentType` and `status`/`state`. "Items that have
  only `name` and `status` do not count, so a to-do list never becomes a list of steps." Otherwise the
  same fields are read from `details` itself.

### 6.6 Reserved names (12:92-102)

* Recognized **tool names** (a tool registered under one gets Pendant's subagent card; "its
  `renderCall` and `renderResult` renderers are not used").
* `details` keys **`asyncDir`** and **`nested_session_path`** — set them and your tool shows up as a run.
* **Widget keys** hidden by Pendant: `agents`, `subagent-async`, `subagent-fleet-status`,
  `subagent-inspect`, `subagents-claude-background`, plus any text widget with a line starting
  `PI_SUBAGENT_ASYNC_JSON:` or `PI_SUBAGENT_INSPECT_JSON:`.
* **Event channels**: `subagents:created`, `subagents:started`, `subagents:completed`,
  `subagents:failed` "keep a session counted as busy"; `subagent:async-started` announces a background
  run into the panel, `subagent:async-complete` brings its final state — "Neither keeps a session busy."
* **`PI_SUBAGENTS_TEMP_ROOT`** — if set for pi-subagents, "Pendant looks for that extension's runs there
  too".
* **Forked sessions** — "A session that was forked from another one, and whose first message contains
  the instructions pi-subagents gives a delegated fork, is treated as a subagent's session. Pendant
  leaves it out of your session list."

### 6.7 Display (12:104-114)

* Transcript card: "one row per step, with its status, agent or label, elapsed time and any error"; a
  step's details show "model, effort, turn, tokens, cost, recent tools, the tool it is running, a
  preview of its output and its error".
* Above the composer: "the working indicator shows one dot for each child, or a bar when there are
  many. Clicking it opens the subagent panel with every run of the session."
* Parallel runs and chains → one row per step. Nested runs from pi-subagents background runs appear as
  runs of their own in the panel.
* **Stale rule:** "A step that still claims to be running but has not reported anything for five
  minutes is marked as stale."
* Transcripts: pi-subagents steps whose result or status file names a transcript can show it in the
  panel (foreground and background).
* Runs without a tool call (pi-subagents commands) "appear in the panel too"; "A paused background run
  of pi-subagents stays followed until the extension finishes it."
* Retention: "After a run ends, it stays in the panel for a few seconds. A failed run stays until you
  have seen it."
* Busy semantics: "While a subagent is active, the chat counts as busy. The stop button stays,
  compacting is not available, and queued messages wait until everything is idle."
* Between tool updates Pendant "follows the progress the recognized extensions write to disk".

### 6.8 Controls (12:118-128)

| Control | Available for |
| --- | --- |
| Interrupt | pi-subagents foreground runs except "a parallel run with several steps"; pi-subagents background runs with one step, except workflows |
| Steer | pi-subagents background runs, and children of pi-subagents workflows in the foreground; delivery choice = "now, after its current turn, or automatically" |
| Stop | pi-subagents background runs; on a step's page it stops that step only; "It asks you to click a second time." |
| Resume | pi-subagents background runs that paused, finished or failed; you give the step a message; "it continues as a new run" |
| Reply | "A pi-subagents step that asks for a decision"; the answer reaches the step "the way the agent's own answer would" |
| Abort the turn | every foreground run; "the only control for the other extensions" |

* "Pausing is not offered. A run that was stopped, or that ended in the foreground, has no controls.
  After you steer a step, its page says whether the step got the message."
* `details.pendant` on a recognized subagent tool replaces the live view at completion, while "The
  working indicator and the panel keep following the run either way." (12:134)
* No general subagent protocol exists: "The extensions in the table get full support because Pendant
  knows their formats." (12:134) Guidance for authors: set `asyncDir`/`nested_session_path` +
  `agent`/`subagentType` + `status` per step for panel support, or leave them out and put progress text
  in each partial result's `content`; never reuse a recognized tool name; keep plain text in `content`.

---

## 7. HOOKS (`13-hooks.md`)

"A hook is a command of your own that Pendant runs when it needs your attention." Typical use: a
remote window where a system notification would land on the wrong machine (13:8). Marked
**experimental** in settings (13:10). Hooks are Pendant-side, run *outside* Pi, need no extension, and
"they don't see Pi's events" (13:16).

### 7.1 Events — the complete list (13:20-27)

| Event | Fires when | Window-focus condition |
| --- | --- | --- |
| `input_request` | "An extension waits for an answer. That is every dialog from `ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.input` and `ctx.ui.editor`, and every custom component from `ctx.ui.custom` when it first appears." | "runs whether or not Pendant's window has focus" |
| `agent_finished` | "A run ends and Pi is not about to retry it. That includes a run that finished normally, a run the user stopped and a run that ended with an error." | "runs only while Pendant's window does not have focus" |

* Default enabled event: "By default only `input_request` runs it." (13:18)
* "Each event runs the hook once. Several dialogs at once run it several times. Hooks run for every
  session in the window, including sessions that are not in view."
* Never fired by: "Messages from `ctx.ui.notify`, statuses and widgets" (13:29).
* Independent of the other notification settings: "A hook runs even when system notifications and
  sounds are off." (13:31)

### 7.2 Configuration (13:33-42)

* Two settings, both under notification settings: the **hook command** and the **list of events**.
  "While the command is empty, no hook runs."
* The command "is a command line, and Pendant runs it through the system shell. On macOS and Linux that
  is `/bin/sh`. On Windows it is `cmd.exe`. Pendant adds no arguments of its own."
* Setup: write script on the machine where Pendant runs → `chmod +x` (macOS/Linux) → enter absolute path
  → choose events.

### 7.3 Payload — environment (13:46-53)

Set in addition to "the environment Pendant itself runs with":

| Variable | Value |
| --- | --- |
| `PENDANT_EVENT` | `input_request` or `agent_finished` |
| `PENDANT_TITLE` | Always `Pendant` |
| `PENDANT_MESSAGE` | "A short sentence for a notification, in the editor's display language. For `agent_finished` it includes the session's name." |
| `PENDANT_SESSION_PATH` | "The path of the session's file, or an empty string when the session has none." |

### 7.4 Payload — stdin JSON (13:55-67)

"One JSON object… a single line with no line break at the end, and Pendant closes standard input after
it." Keys `event`, `title`, `message`, `sessionPath` mirror the env vars 1:1 (all strings). Verbatim
example:

```json
{"event":"agent_finished","title":"Pendant","message":"Pendant finished working in “Fix the flaky login test”.","sessionPath":"/path/to/agent/sessions/project/session.jsonl"}
```

* "Nothing in the data tells a finished run from a stopped or failed one. Every `agent_finished` event
  looks the same."
* "Decide what to do from `event`. The message is meant to be read by a person. Its wording follows the
  display language, so don't parse it."

### 7.5 Execution rules (13:69-79)

* **Where:** on the machine where Pendant runs — "In a remote window, for example over SSH, in WSL or in
  a container, that is the remote machine."
* **Working folder:** "Pendant does not choose one. Use absolute paths."
* **Time limit:** "Pendant stops a hook that runs longer than ten seconds and counts that as a failure."
* **Success:** exit code `0`; any other code is a failure.
* **Concurrency:** "Every event starts its own process straight away. Pendant does not queue hooks or
  wait for one to finish before it starts the next."
* **Non-blocking:** "The agent carries on while a hook runs, and a failing hook never stops it."
* **Failure reporting:** notification in the editor with "the exit code and the start of what the hook
  wrote to standard error"; plus a per-run log "in the editor's output view" recording "the command,
  the event, the session's file, every line the hook wrote to standard output and standard error, and
  how the run ended and how long it took". "Pendant has a command that opens this log." `[AMBIGUOUS]`
  the command's identifier is not named.

### 7.6 Hook security rules (13:110-116) — see also §12

* "A hook runs as you… with your user account's rights."
* "Workspace settings count too. The hook command is an ordinary editor setting, so a workspace's own
  settings can set it as well."
* "Settings may sync. Settings Sync can copy the hook command to your other computers."
* "Events carry session details" (session name may derive from the first message; session path reveals
  where sessions live).

### 7.7 Documented example scripts (13:120-160)

* ntfy forwarder using `$PENDANT_EVENT` / `$PENDANT_TITLE` / `$PENDANT_MESSAGE`, `curl --max-time 8`
  ("Stay well inside Pendant's time limit"), `priority=high` for `input_request`.
* JSONL event log: `{ cat; echo; } >> "$HOME/pendant-events.jsonl"` — "adds the line break that Pendant
  leaves out".
* Windows: `powershell -NoProfile -File "%USERPROFILE%\pendant-hook.ps1"`, reading
  `$env:PENDANT_EVENT`, `$env:PENDANT_MESSAGE`.

---

## 8. EXTENSIONS API (`11-extensions.md`, 348 lines) — treated as an API spec

Scope: "Pendant uses Pi's extension loader and runtime. Extensions can register tools, commands,
providers and event handlers through Pi's public API. Pendant adapts their presentation to its chat…
Some terminal features are unsupported, and native subagent sessions have a narrower UI." (11:6)
Package import name in examples: `@earendil-works/pi-coding-agent`, `import { Type } from 'typebox'`.

### 8.1 Loading (11:10-25)

* Discovery order: "the extensions folder in Pi's configuration folder, the one in your project's Pi
  folder, and the packages and extension paths your Pi settings list", plus Pendant's own
  "additional extension paths", and a switch to turn off automatic discovery so "only those explicit
  paths load".
* Legacy: "An install that started on an early Pendant version may still use a private Pi folder of its
  own. Pendant then loads nothing from Pi's standard folder. The Pi panel offers to switch to the
  standard folder, or to keep the private one."
* Trust: "Project resources follow the host's resource-trust policy. `ctx.isProjectTrusted()` reports
  the decision supplied to Pi. Do not assume that it came from a separate Pi trust question or that
  your `project_trust` handler ran. Pendant does not dispatch that event to extensions in its production
  session setup." → "Only trust folders whose extensions you trust."
* Reload triggers: "when you ask Pendant to reload Pi's configuration, when a package changes, and when
  an extension calls `ctx.reload()`" — plus the package rules in §5.9.
* Reload effects: "A reload keeps the conversation. It clears the widgets, statuses, title, working
  message and thinking label the extension set. Dialogs that were still open return as if dismissed,
  and custom components close. Text in the composer and the tool expansion stay as they were."
* "A change to Pendant's extension settings applies when Pendant next starts Pi."
* Failure reporting: "Pendant reports extensions that fail to load as errors in the chat when it starts
  Pi." A throwing component/renderer → "its card says that the terminal could not be displayed, and the
  rest of the chat carries on". Extensions are listed alongside skills and prompt templates (11:346).

### 8.2 Two presentation modes (11:27-38)

`Pendant's extension UI mode` setting → `ctx.mode`:

| Setting value | `ctx.mode` | Purpose |
| --- | --- | --- |
| **Dialogs** (default) | `"rpc"` | "Extensions that offer both dialogs and a terminal interface choose their dialogs, and Pendant shows them as its own controls." |
| **Terminal** | `"tui"` | "Extensions that choose terminal UI can show custom components as terminal cards." |

* "In both modes `ctx.hasUI` is true" → cannot be used to distinguish Pendant from terminal Pi.
* "It does not switch any feature on or off… The mode is a hint about which presentation the user
  prefers. It does not enable editor replacement, automatic extension keybindings or other unsupported
  features."
* **Terminal card** = "a small terminal inside the chat… drawn in Pendant's colors. Keyboard and mouse
  input reach the card while it has focus." Used for custom components, component widgets, custom
  renderers. "Headers and footers are the exception. Pendant draws their lines as styled text, because
  they never take input."

### 8.3 `ctx.ui.*` surface — complete behaviour table (11:40-73)

| Member | Pendant behaviour |
| --- | --- |
| `ctx.ui.select` | Card at the end of the chat listing the options; "Dismissing it returns `undefined`." |
| `ctx.ui.confirm` | Card with the message and a yes/no answer; "Dismissing it returns `false`." |
| `ctx.ui.input` | Card with a text field and its placeholder; dismissing → `undefined`. |
| `ctx.ui.editor` | Card with a multi-line field prefilled; dismissing → `undefined`. |
| `ctx.ui.notify` | "a notice in the chat, styled as information, a warning or an error. Nothing is returned." |
| `ctx.ui.setStatus` | "status text in the chat's footer. It stays hidden until the user chooses to show statuses, in the chat's footer, the status bar or both. The user can also pick which keys to show. Pass `undefined` to clear a status." |
| `ctx.ui.setWorkingMessage` | Replaces the working indicator text; "Terminal escape codes are removed."; no argument → restore default |
| `ctx.ui.setWorkingVisible` | Hides or shows the working indicator |
| `ctx.ui.setWorkingIndicator` | Custom frames + interval; "Escape codes in the frames are removed, so colors do not carry over." |
| `ctx.ui.setHiddenThinkingLabel` | Sets the title of thinking blocks; no argument → default |
| `ctx.ui.setTitle` | "the title of its view or of the chat's tab. The session name stays unchanged. An empty title removes it." |
| `ctx.ui.setWidget` (lines of text) | Card above the composer, or below with the `"belowEditor"` placement; "drawn… as text, not as a terminal, and keeps its colors"; a short first line makes a multi-line widget fold under it; checklist-form lines → checklist card; "The user can pin widgets under the chat header instead. `undefined` or blank lines remove the widget." |
| `ctx.ui.setWidget` (component) | Terminal card in the same place, takes keyboard/mouse focus |
| `ctx.ui.setHeader` | "a band below the chat header, drawn as styled text. It starts folded, and the user can open it. It takes no input." |
| `ctx.ui.setFooter` | "a band below the composer and its controls, drawn as styled text. It takes no input." `footerData` "reports the workspace's Git branch and the extension statuses." |
| `ctx.ui.custom` | Terminal card at the end of the chat, takes keyboard focus on appearance; "It closes when the component calls `done`. Overlay options are accepted, but the card stays in the chat instead of floating above it. The promise rejects if the card is taken down before `done`, for example by a stop or a reload." |
| `ctx.ui.setEditorComponent` | "accepted and ignored. Pendant's composer always stays in place. An extension cannot replace it." |
| `ctx.ui.getEditorComponent` | "always returns `undefined`" |
| `ctx.ui.setEditorText`, `ctx.ui.pasteToEditor` | Replace / add to the composer text |
| `ctx.ui.getEditorText` | Returns the composer text |
| `ctx.ui.addAutocompleteProvider` | Adds suggestions to the composer's suggestion list (see 8.4) |
| `ctx.ui.onTerminalInput` | Sees what is typed into a focused terminal card, before the component; "It never sees what the user types into the composer." |
| `ctx.ui.theme`, `getAllThemes`, `getTheme`, `setTheme` | Present but "Pendant does not apply Pi themes. There is one theme, named `system`." (see 8.4) |
| `ctx.ui.getToolsExpanded` / `setToolsExpanded` | Read/set whether tool cards are open; "Setting it opens or closes every tool card in the chat and decides how later ones start. When the user opens or closes a card, `getToolsExpanded` follows." |

### 8.4 Detailed notes (11:75-87)

* **Themes:** `ctx.ui.theme` "is always the `system` theme, and its color and style functions return
  text unchanged"; renderers/component factories receive the same theme; `getAllThemes` lists only
  `system`; `getTheme` "returns nothing for any other name"; `setTheme` "succeeds for `system` and
  changes nothing. For any other theme it returns `success: false` with an error message." "The theme
  in Pi's settings and theme files from packages have no effect in Pendant."
* **Autocomplete:** Pendant asks providers "while the user types a slash command at the start of the
  message, or a word that starts with `@`, `#` or one of the characters a provider lists in
  `triggerCharacters`." The provider passed to the factory as `current` "supplies registered commands'
  argument completions. It does not supply file or command-name suggestions, which Pendant handles
  separately. Delegate to `current` when your provider has no suggestions of its own."
* **Headers:** "A header starts folded, so the user may never open it."

### 8.5 Dialog lifecycle rules (11:89-101)

* All dialogs appear "as a card at the end of the conversation"; "Pendant treats every way a dialog can
  end without an answer the same way. It returns what dismissing returns."
* **Timeouts:** "With a positive `timeout`, the card shows a countdown and closes when it runs out."
* **Abort signals:** "Aborting the `signal` closes the card. A signal that is already aborted returns at
  once, without showing a card."
* **Concurrency:** "Tools that run in parallel can each ask something. Every dialog gets its own card
  and its own answer."
* **Stopping:** "When the user stops a run, open dialogs return as dismissed. Until the stop has
  finished, any further dialog returns as dismissed straight away, and `ctx.ui.custom` rejects."
* **Cross-session:** "A dialog waits while the user looks at a different session. The session list marks
  the session as waiting for an answer, and the card comes back, with its countdown still running, when
  the user returns."
* Pi's `ui_prompt_start` / `ui_prompt_end` events "fire around dialogs and custom components, as they do
  in the terminal."

### 8.6 Commands (11:103-117)

* `pi.registerCommand` registrations appear "in the composer's slash command list, with their description
  and the name of the extension they come from"; the user's text is handed to Pi "unchanged"; "Pendant
  does not add extension commands anywhere else, for example to the editor's list of commands."
* `getArgumentCompletions` "after a space follows the command name on the first line. The argument is the
  text between that space and the caret. Suggestions come from the session's active commands, so a reload
  picks up replacement commands. A failed or malformed reply supplies no suggestions, and a superseded
  query stops waiting for its answer."
* Name collisions: "Pendant handles a few commands itself, for example to start a chat, pick a model or
  open its settings. If an extension command has the same name, Pendant's own command wins whenever it is
  typed without arguments."
* Command context: `ctx.newSession`, `ctx.fork`, `ctx.navigateTree`, `ctx.switchSession`,
  `ctx.waitForIdle`, `ctx.reload`, `ctx.abort()` ("stops the run"), `ctx.shutdown()` ("closes that
  session's Pi and leaves Pendant running").

### 8.7 Messages and input (11:99, 107-105)

* `pi.sendMessage` messages appear "when `display` is true"; with a `pi.registerMessageRenderer` the
  renderer's component is shown as a terminal card; otherwise (or when the renderer returns `undefined`)
  "Pendant shows its own card, labelled with the message's custom type and with the content rendered as
  Markdown". `display: false` → "stay out of the chat".
* `pi.sendUserMessage` → "appear like any other".
* `pi.setSessionName`, `pi.setModel`, `pi.setThinkingLevel` changes surface in Pendant's UI.
* Tool-set precedence rules: see §5.5.

### 8.8 Custom tools (`pi.registerTool`) (11:129-145)

* Each call → one Pendant tool card.
* Without renderers: shows call + result in Pendant's style; "While the call runs, the card shows the
  partial results the tool sends through `onUpdate`. The text in their `content` shows as it is, and each
  update replaces the one before. A partial result without text shows a summary of its `details`
  instead."
* With `renderCall` / `renderResult`: renderer components appear as terminal cards inside the tool card,
  "below its title. The call comes first and the result follows." The result renderer "takes the place of
  the card's own result view, except for images, which Pendant keeps showing."
* Expansion: "Opening or closing it renders again with the changed `expanded` value, and
  `context.invalidate()` renders again at any time."
* Pi built-in tools keep Pendant's cards; "An extension that replaces a built-in tool with its own
  definition gets its own renderers instead."
* Recognized subagent tools keep Pendant's subagent card; their renderers are unused.
* A tool can publish a Pendant-only view via `details.pendant`.

### 8.9 `details.pendant` — the Pendant-only tool-result view (11:146-230)

* Placement: `details.pendant` on a tool result, produced either by the tool's `execute` or by a
  `tool_result` handler registered with `pi.on` (which "can return changed `details` for any tool",
  including other extensions' and Pi's built-ins; "Pi then stores the changed `details` in place of the
  original ones"). "Pi's terminal ignores the object."
* Contract: "Pi hands the model the result's `content`. The `details` are for rendering and for state.
  So keep a plain-text version of the result in `content`."
* Fields (all optional, independent):

| Field | Type | Behaviour |
| --- | --- | --- |
| `markdown` | string | "Renders it as Markdown in place of the card's result view. Raw HTML inside it shows as plain text. Task list items such as `- [x] done` become checkboxes." |
| `html` | string | Rendered "after Pendant's sanitizer has cleaned it… only when `markdown` is missing or blank." |
| `title` | string | "Replaces the tool's name in the card's header. For a built-in tool it also replaces the icon and the file link that Pendant would show." |
| `subtitle` | string | Shown after the name, in the muted header area; "With no `title`, it annotates Pendant's own name for the tool." |
| `expanded` | boolean | `true` opens the card when the call finishes, `false` keeps it closed; overrides Pendant's own choice "including the tool display setting that opens every successful call". A closed card still opens on click. |

* Reading rules: only the final result counts (partial results keep the live view); wrong types ignored;
  "a string that is empty or only whitespace" ignored; `expanded` "must be a real boolean, so a string
  such as `"true"` is ignored"; unknown fields and non-object `pendant` values ignored; "Markdown wins
  over HTML"; with no usable body Pendant's own view/`renderResult` stays; "Bodies have no length limit";
  labels are single-line — "Line breaks, tabs, control characters and invisible formatting characters in
  `title` and `subtitle` become single spaces", never treated as markup, not truncated, ellipsised in the
  header with the full label as tooltip.
* Card-open exceptions: "A result that is an error always opens."; a session reopened from history starts
  with everything closed; "An edit or a write whose diff is too large for the chat keeps opening in a
  separate diff view."
* **HTML allowlist** — allowed elements: `a`, `blockquote`, `br`, `button`, `code`, `div`, `em`, `h1`–`h6`,
  `hr`, `img`, `input`, `kbd`, `label`, `li`, `ol`, `option`, `p`, `pre`, `progress`, `section`, `select`,
  `small`, `span`, `strong`, `summary`, `table`, `tbody`, `td`, `textarea`, `th`, `thead`, `tr`, `ul`.
  Removed **with their content**: `script`, `style`, `iframe`, `object`, `embed`. Other elements: element
  removed, content kept.
* Attributes: event handlers such as `onclick` removed, and so is `style`; `data-` and `aria-` stay, as do
  "common ones such as `class`, `id`, `title`, `alt`, `value`, `checked`, `disabled`, `colspan` and
  `rowspan`".
* Links: `href` only for `http:`, `https:`, `mailto:` and `#` anchors; `target` only `_blank` or `_self`.
* Images: `src` only `data:` and `blob:`; "Pendant removes every other image address."
* "Buttons and form fields appear, but nothing is connected to them. Use them for display only."
* Interaction with renderers: a published body replaces Pendant's own result view (including for built-in
  tools); if the tool also has `renderResult` "its terminal card takes the result's place, and the
  published body stays hidden. `title`, `subtitle` and `expanded` still apply. Images in the result stay
  visible"; `renderCall` is unaffected; subagent tools: live subagent view → published body at completion.
* "`details.pendant` works the same way in both extension UI modes."
* Worked examples given in the guide: a `list_releases` tool returning
  `details.pendant = { title, subtitle, markdown, expanded: true }`, and a `tool_result` handler that
  turns a `todo` tool's `details.tasks` into a checklist markdown with
  `{ subtitle: '<n> of <m> done', markdown, expanded: false }`.

### 8.10 Recognised extension output (both modes) (11:260-278)

* **Checklists** — a text widget becomes a checklist card with a progress bar when "every non-blank line
  is a checkbox item", i.e. `☐`/`☑` + text or `- [ ] text` / `- [x] text`; "One heading line may come
  before the first item"; a trailing count such as `(3/5)` in the heading "is removed, because the card
  shows its own"; anything else keeps it a plain widget; when all items tick while watched "the card
  hides itself a few seconds later. It stays while the user points at it or has it open."; users can
  hide checklist cards.
* **Plans** — "Pendant recognizes plans from Plannotator. Once the user approves a plan, it shows the
  plan's steps as a checklist and ticks them off as the agent reports each one done."
* **Subagents** — recognized subagent tools get subagent cards with progress and transcripts; "It hides
  those extensions' own status widgets".
* **Questions** — "A tool named `ask_user_question`, as in rpiv-ask-user-question, appears as Pendant's
  own question dialogs."
* **MCP** — "Pi connects to MCP servers itself. Pendant shows Pi's MCP manager in the chat, in your
  language. There you sign in to a server, reconnect it, turn it on or off, see its tools and choose how
  the agent reaches them. You can also add, edit and remove servers from Pendant, and a change to an MCP
  configuration file takes effect on its own. Before you save a server, you can test the connection… A
  test saves nothing and never starts a sign-in." A tool named `mcp` (pi-mcp-adapter) "keeps Pendant's
  own card".
* **Web tools** — tools named `web_search`, `fetch_content`, `get_search_content`, `source_check` (as in
  pi-web-access) "keep Pendant's own tool cards. A search shows its query, and the results show as
  Markdown, with their links. Any extension that names its tool the same way gets the same card."
* **Task lists** — "Pendant shows the task list of rpiv-todo as a checklist card titled `Tasks`. It hides
  the extension's own widget."

### 8.11 Tested-extension matrix and test method (11:280-298)

| Extension | Presentation | Test method (verbatim) |
| --- | --- | --- |
| `@juicesharp/rpiv-ask-user-question` | questions as Pendant dialogs, answers, free text, cancelling | "Automated tests run the real extension" |
| `pi-mcp-adapter` | Pendant's own card for its `mcp` tool | "Tests of how Pendant reads its format" |
| Plannotator | approved plan → checklist, ticks steps | "Automated tests replay output recorded from the real extension" |
| `pi-subagents` | cards, panel, transcripts, run controls | "Automated tests use a stand-in that reproduces its tools, results and files" |
| `@tintinweb/pi-subagents` | cards + panel | "Tests of how Pendant reads its format" |
| `pi-subagents-j0k3r` | cards + panel | "Tests of how Pendant reads its format" |
| `pi-web-access` | own cards for web tools, query + linked results | "Automated tests run the real extension against a local search server" |
| `@juicesharp/rpiv-todo` | task list as checklist card | "Automated tests run the real extension" |

* "Real-package fixtures use pinned versions… A newer version of an extension can change its format."
* "[That] coverage does not certify every API an extension uses or every later version of the package."

### 8.12 Native subagent sessions (11:108-114)

"Extensions in a native subagent cannot control the main chat as though they were the main session."
* Allowed: dialogs and custom components "can ask the user through the owning chat".
* **Suppressed:** notices, statuses, widgets, headers, footers, titles, working indicators; composer
  writes; autocomplete providers; terminal-input listeners; tool-expansion changes. "Reading the composer
  returns empty text."

### 8.13 Unsupported / adapted APIs (11:307-318)

"Registration can succeed without the requested behavior taking effect."

| API | Pendant behaviour |
| --- | --- |
| `pi.registerShortcut` | Use **Extension actions** in the Pi panel or `/actions` to "search and invoke effective registered actions". The picker shows description, source, registered chord. "Chords are informational: Pendant does not install or remap extension keybindings. Pi's shortcut resolution can exclude restricted or displaced registrations." |
| `pi.registerFlag`, `pi.getFlag` | "Pendant starts Pi without command-line flags, so nothing can set one. `getFlag` returns the flag's default, or `undefined` if it has none." |
| `pi.registerMarkdownTransformer` | "Never applied. Pendant renders the conversation's Markdown itself." |
| `project_trust` handlers | "Not dispatched to extensions by Pendant's production session setup." |
| `ctx.ui.setEditorComponent` | accepted and ignored; `getEditorComponent` → `undefined` |
| Overlay positioning in `ctx.ui.custom` | "Accepted, but the card stays in the chat." |

* Action picker rules: "The action picker belongs to the current live session. Selecting an action closes
  the picker before its handler UI opens. Reload or session replacement invalidates old selections. A
  handler can use the normal native dialogs; errors are reported through the existing notice path. Stop
  cancels owned dialogs, but cannot forcibly terminate arbitrary extension JavaScript."

### 8.14 Authoring rules Pendant implements (11:327-342)

Guidelines the guide states, each of which is an observable Pendant behaviour to reproduce: prefer the
standard dialogs; branch on `ctx.mode` (`"rpc"` → dialogs) and never on `ctx.hasUI`; treat `undefined` /
`false` as cancellation and don't re-ask in a loop; `try`/`catch` around `ctx.ui.custom`; expose
discoverable actions (slash command + registered shortcut, chords not global); don't depend on flags —
"Read configuration from a file or from settings instead"; use `getArgumentCompletions` for command
arguments and autocomplete providers for other triggers; give commands distinctive names; write checklists
in checklist form with at most one heading line; keep widgets short with a short first line so they can
fold; "Don't rely on color alone"; keep essential information out of the header; keep essential behaviour
out of a replacement editor ("Pendant never calls or mounts the factory passed to `setEditorComponent`").

## 9. VOICE DICTATION (`14-voice.md`)

Engine: **whisper.cpp**, "an open-source speech recognition engine", running inside a shipped helper
program, on the user's computer. "Your audio never leaves it, and neither does the text made from it."

### 9.1 Pipeline (guide `flow` block, 14:8-13)

```
Your microphone | recorded by a small helper program
whisper.cpp | turns speech into text on your computer | highlight
The composer | the text appears at your cursor
```

Verbatim process description (14:15-23): "When you start dictating, Pendant starts a small helper
program that ships with it and records from your microphone. The helper runs only while you dictate.
Each dictation starts a fresh one, and it closes once the text is ready. … When you stop, the helper
trims the silence at the start and the end of the recording. It then hands the recording to
whisper.cpp … together with the model file. whisper.cpp runs inside the helper, on your computer.
Nothing is sent over the network, and no audio or text reaches Pendant's developers or anyone else."
Live input-loudness meter while speaking. Result inserted at the cursor: "Pendant does not send it for
you." One-step removal of the just-dictated text is offered.

### 9.2 Trigger and devices

* Default: hold the microphone button; "A quick click starts and stops dictation as well." Hold can be
  turned off in settings.
* Microphone: system default unless chosen in settings.
* Platform support: macOS, Windows, Linux; "On Windows and Linux, both x64 and Arm processors are
  supported." Apple silicon → GPU; Intel Mac / Windows / Linux → CPU.
* Mic permission: macOS prompts naming "the app Pendant runs in, or Pendant's helper"; denial → error,
  revocable in system privacy settings; Windows/Linux: no Pendant prompt, follows system privacy/sound
  settings. No microphone → "dictation tells you".
* First press opens the model dialog; "That press ends with your choice, and the model downloads
  straight away. The next press dictates."
* Remote: dictation "runs where Pendant runs" — the remote machine's microphone and model store;
  "A server or a container usually has no microphone, so dictation cannot record there." (14:82-84)

### 9.3 Assets — the eight built-in models (14:26-40)

Repository: `huggingface.co/ggerganov/whisper.cpp` (the whisper.cpp project's model repo).

| Model | Languages | File | Download size |
| --- | --- | --- | --- |
| Base multilingual, **the default** | Many | `ggml-base.bin` | about 142 MB |
| Base multilingual (Q5_1), recommended | Many | `ggml-base-q5_1.bin` | about 57 MB |
| Tiny multilingual | Many | `ggml-tiny.bin` | about 75 MB |
| Tiny multilingual (Q5_1) | Many | `ggml-tiny-q5_1.bin` | about 31 MB |
| Base English | English only | `ggml-base.en.bin` | about 142 MB |
| Base English (Q5_1), recommended | English only | `ggml-base.en-q5_1.bin` | about 57 MB |
| Tiny English | English only | `ggml-tiny.en.bin` | about 75 MB |
| Tiny English (Q5_1) | English only | `ggml-tiny.en-q5_1.bin` | about 31 MB |

* Naming: `ggml-<size>[-q5_1][.en].bin`; Q5_1 = the "smaller quantized build, which trades a little
  accuracy for a smaller download".
* Model dialog lists "the languages, the speed, the download size and the exact download address"; also
  reachable later to switch model/language/microphone.

### 9.4 Custom model files (14:42-46)

* Full path given "in the dictation dialog or in Pendant's settings"; "Pendant then uses that file
  directly and never downloads a model. The path must be absolute, and the file must exist. The file
  must be in the format whisper.cpp reads."

### 9.5 Download / storage rules (14:48-58)

* Download happens only when dictating with a model not yet present, or when selecting it in the
  dialog; "Pendant downloads only the model you selected and shows its progress."
* Atomic-ish write: "It writes the file under a temporary name and keeps it only once the download is
  complete. **It does not compare the file against a checksum.**"
* Storage: "Pendant's own storage on your computer, not in your project… They stay there until you
  delete them. Pendant can show how much space they take and delete them for you."
* Offline: "With Pendant's offline setting turned on, Pendant never downloads a model. If the selected
  model is not on your computer yet, dictation says so instead. A model file of your own always works
  offline."
* Egress note: the download request "goes to Hugging Face, which sees ordinary network information such
  as your IP address."

### 9.6 Language handling (14:60-66)

* Multilingual models cover the languages whisper.cpp supports; "Pendant does not detect the language you
  speak. You choose it… English is the default." "Cantonese is not offered separately. Choose Chinese for
  it." English-only models "ignore the language setting".

### 9.7 Latency

* The guide gives **no measured latency figures**. Only qualitative statements: "Smaller models
  transcribe faster"; GPU on Apple silicon; silence trimming; per-dictation helper start/close (fresh
  process each time). `[AMBIGUOUS]` sample rate, threading/`n_threads`, streaming vs one-shot decode,
  and end-of-speech latency are unspecified.

---

## 10. REMOTE / DESKTOP

### 10.1 "Remote access" = phone companion, unreleased (`15-remote.md`)

* Status: "Remote access and its phone app already work, but both are still in internal development.
  Neither is published yet." (15:8-10); "It is still in internal development and not in the published
  versions yet." (04:47)
* Capability set: list the sessions your computer has open and pick one; "Watch the session as the
  agent works, and scroll back"; "Answer an extension's questions"; "Send a prompt, steer the agent or
  queue your next message"; "Stop a run, or cancel a tool call."
* The phone renders the *same interface*: "the computer sends the phone Pendant's own chat interface."
  Answering on either side clears the question on the other.
* Out of scope on the phone: "The phone is for following and steering sessions. Settings, Git and the
  rest of Pendant stay on the computer."
* Notifications: local to the app — "There is no push service behind this… so they arrive only while it
  is still running in the background."
* Transport: direct connection, "Both need to be on the same network, or on the same Tailscale tailnet";
  "encrypted end to end. The keys are held only by your phone and your computer. Pendant uses the Noise
  protocol framework for this, with keys it creates on each device."
* Stealth before handshake: "Anything else that reaches the port sees only handshake bytes, with no name
  and no version. A computer also stops accepting an address that fails the handshake repeatedly."
* No relay: "Nothing passes through a Pendant server. Pendant has no account, relay or push service. If
  you use Tailscale or another VPN, it carries the encrypted traffic, but it cannot read it."
* Pairing: opt-in; "your computer's firewall may ask whether Pendant may accept incoming connections.
  When Pendant runs inside your editor, the firewall asks about the editor." QR code carries "your
  computer's network addresses and what the phone needs to recognise your computer. It works once and
  expires after a few minutes. Showing a new code cancels the previous one." Re-pairing "only refreshes
  the addresses."
* Revocation: revoke in Pendant's remote-access settings → "disconnected at once and refused afterwards";
  turning remote access off "closes the connection point on your computer"; on the phone you can forget
  a computer.
* Key storage: computer keeps "its own key and the list of phones you paired, with each phone's name,
  model and public key. On macOS and Linux only your user account can read them." Phone key in "the
  system's secure keychain, tied to that device, so a backup never restores it onto another one."
* Windows/profiles: "every window where it runs accepts phone connections on its own port. Pairing once
  covers every local window of the same editor installation and profile. A window in another profile is
  paired separately. So is a window connected to another machine over SSH, in WSL or in a container,
  because its pairing is kept on that machine. Settings Sync does not carry remote access."

### 10.2 Remote *development* (SSH / WSL / containers) — different thing

* `17-vscode.md:52`: "When your editor is connected to another machine, for example over SSH, in WSL or
  in a container, Pendant runs on that machine. It then uses that machine's Pi configuration and
  sessions, and the agent works on that machine's files." Voice and hooks also run there.
* MCP sign-in across the boundary: browser runs locally, callback must land on the remote machine; "the
  browser may show an error page. That is expected. Copy the full address from the browser's address bar
  and paste it into the sign-in screen in Pendant."
* System notifications on a remote machine are the motivation for hooks (`13-hooks.md:8`).
* Settings that "belong to the computer rather than a workspace, for example remote access, … always
  stay there" (17:14).

### 10.3 Worktrees

See §2.6. Additional framing (04-capabilities.md:41): "Start a session in its own Git worktree, so its
changes stay separate from your main checkout." Worktree folder is "hidden… inside your repository".

### 10.4 "Desktop" chapter meaning (`18-desktop.md`)

"Pendant for Desktop is a standalone app for macOS, Windows and Linux. It is still in development."
Unlike the VS Code extension it owns the whole window, so it can add editor-side features: (18:8)
"Because Pendant owns the whole app, it can also tie Pendant and Pi together much more closely."
Not a replacement: "The desktop app does not replace Pendant in VS Code. Both remain supported." (18:238)

Feature inventory (18:12-24): full code editor with file explorer and tabs (also the diff review
surface); **language-server** code navigation (hover, go-to-definition, references, symbols) with
built-in servers for common languages and help finding/installing others; folder-wide search with
replace; a Git view (review, stage, commit, switch branches, fetch/sync); a terminal; a place for
recurring background tasks; several folders side by side "each in its own tab"; and "the same chat,
sessions, context, extensions and voice input as Pendant in VS Code".

* Command palette "reaches more than commands, files and symbols… From it you can switch to another
  session, pick a model or set the thinking level for the chat. It also lists every keyboard shortcut,
  including the chat's own."
* Folder tabs and session tabs show a working indicator "even while you look at another folder".
* File explorer follows the edited file (opens ancestor folders, scrolls, "without taking focus or
  changing your selection of several files"); can be turned off.
* **Language servers:** global off, per-server off, pick which server handles a language; per-server
  program path, arguments, environment variables, and the options/settings the server reads; "A change
  to how a server starts restarts that server. A change to its settings reaches it while it runs.";
  per-helper switches (diagnostic severity threshold, hover details, outline/current-location); crashed
  server shows "its last error" and can be restarted; "A file you are still editing is checked as it is
  on screen, not as it was last saved."; gutter marks = changes since last commit, live while typing.
* **Search & replace:** match-case, whole-word, regex; single-file or all files; regex capture reuse
  (`$1`); confirm first; per-file diff preview; "Replacing changes exactly the places the search listed.
  It keeps each file's line endings and encoding."; skips files with unsaved editor changes and files
  that changed on disk, reporting the skipped count.
* **Read-only viewers** (all local, all offline, none of them create chat attachments, none modify the
  file):
  * **PDF** — paging, zoom, rotate, search (`Cmd/Ctrl+F` find bar, **Done**/**Esc**), select/copy,
    thumbnails, bookmarks, per-view scroll position, password-protected files; forms/annotations not
    editable; no OCR ("Scanned pages display without text recognition"); links open only on click;
    external change → **Reload** keeping your place.
  * **Images / game textures** — Fit or 100% ("one image pixel per physical screen pixel"), pan/zoom,
    nearest/smooth sampling, transparency background, per-channel inspection; **I** inspects centre,
    **Shift+Arrow** moves the source-pixel probe, **1**/**Home**/**+**/**−** zoom. Formats: PNG, JPEG;
    static+animated GIF/WebP; still AVIF 8/10/12-bit with alpha; BMP; multi-entry ICO; QOI; true-color/
    grayscale TGA (raw and RLE); grayscale/RGB TIFF 8/16-bit integer, alpha, either byte order, chunky or
    planar, raw/PackBits/LZW/Deflate; sanitized SVG rasterized (probe labeled **Rendered preview**); PSD/
    PSB flattened composite (grayscale/RGB 8/16-bit, merged alpha, raw/RLE/ZIP/ZIP-prediction — no layer
    reconstruction, missing composite → re-save with **Maximize Compatibility**; CMYK/Lab/32-bit
    unsupported); Radiance RGBE and flat single-part scanline RGB/RGBA OpenEXR (half/float, uncompressed/
    RLE/ZIP; tiled, deep, multipart and other EXR compressions unsupported; exposure + optional Reinhard
    tone mapping for SDR display; probe keeps decoded source values incl. negative/>1 before exposure/
    tone-mapping/channel changes; EXR data/display windows visible; ICC/CICP used where supported with
    explicit sRGB/linear overrides; unqualified profiles and non-Rec.709 EXR chromaticities fall back;
    HDR monitor output and print-proof fidelity deferred); DDS (2D, mip chains, arrays, cubemap faces;
    RGBA8/BGRA8, BC1–BC7, signed BC4/BC5, signed/unsigned BC6H); KTX1 (RGBA8, BC1–BC3); KTX2 (RGBA8, BC
    formats, Basis ETC1S/UASTC LDR incl. qualified Zstandard variants); legacy RGBX/XRGB masks
    unsupported; independent mip/array-layer/face selection plus a labeled cubemap cross; block-compressed
    probes report decoded samples; untagged textures default to linear interpretation; volumes, Basis HDR
    and unqualified encodings keep metadata and an **Open as Hex** action. Decoders "ship locally and work
    offline"; CPU fallback when GPU/context allocation fails; tiled presentation for large sources;
    "Changing a file keeps the last completed preview with a Reload action."
  * **3D models** — glTF 2.0 (`.gltf`/`.glb`), OBJ+MTL, ASCII/binary STL, ASCII and little/big-endian
    binary PLY incl. point clouds; "The preview preserves source coordinates and transforms";
    undeclared units → **Unspecified units** ("the viewer does not guess a physical size or rescale the
    asset"); orbit/pan/zoom by mouse or keyboard, frame, perspective/orthographic, material/neutral/
    wireframe shading, lighting, background, grid; scene outline of nodes with select/frame/hide;
    orientation cube with face/edge/corner snapping; X/Y/Z marker; per-split camera and scene state;
    **Open source** for textual formats; glTF extensions supported: `KHR_draco_mesh_compression`,
    `EXT_meshopt_compression`, `KHR_meshopt_compression`, `KHR_mesh_quantization`, `KHR_texture_basisu`,
    `KHR_texture_transform`, `KHR_materials_unlit`, `EXT_texture_webp`, `EXT_texture_avif`; other *required*
    extensions → unsupported explanation, optional unqualified features → warnings with core fallback;
    skin/morph/transform animation paused initially, choose clip / play / pause / seek, playback repeats
    the selected clip, hidden tabs suspend; materials can use the local image/GPU texture decoders incl.
    qualified DDS/KTX; "Remote asset URLs are never fetched automatically"; "Closing a tab releases them;
    a changed root or dependency retains the completed frame until **Reload** replaces it"; "No arbitrary
    file-size or triangle ceiling is imposed; available memory, WebGL2 and hardware capabilities
    determine whether a preview can be rendered"; active allocations accounted locally, no decoded-model
    cache after close; FBX/Blender/USD/CAD/Office deferred.
  * **CSV/TSV tables** — shows the saved file; source text kept separate; "Inspecting or sorting a table
    never writes the file"; click header to cycle ascending/descending/original; **Ctrl+G** → **Go to**
    accepting a row or `row, column`; **View** selects encoding/delimiter/first-record-as-header, with
    UTF-8, both UTF-16 byte orders, Windows-1252 explicit, and delimiters comma/tab/semicolon/pipe;
    "Detection shows its interpretation so ambiguous files can be corrected without editing their bytes";
    "Values remain text" (leading zeroes, long identifiers, formula-like strings, whitespace, embedded line
    breaks preserved); missing vs empty fields distinguished; search spans off-screen columns; stable text
    sort; selected-cell inspector shows source coordinates and reads long values in segments; explicit
    cell copy includes the whole value; per-split selection/interpretation; progressive rendering with
    "only a visible portion mounted"; hidden tables pause; invalid quoting keeps complete records before
    the error and offers text + hex views.
  * **Audio/video** — open paused; Play, Restart, Go to Time, position slider, loop, volume, mute,
    playback speed; fit-to-pane vs actual size for video; per-split settings; "playing one pane pauses
    the other pane in that window"; hiding pauses, returning stays paused; baseline codecs "PCM WAV and
    VP8/Vorbis WebM", others (MP3, FLAC, Ogg, Opus, VP9, H.264, AAC) vary; "A recognized extension does not
    guarantee decoding"; unsupported/damaged → **Reload** and **Open as Hex**; PCM and float WAV get an
    automatic progressive waveform (click/drag to seek, **Waveform** switch in **View**, cancelable; a
    cancelled scan restarts from the beginning; playback doesn't require the waveform).
  * **Fonts** — TTF, OTF, TTC, OTC, WOFF, WOFF2, inspected without installing; three modes **Specimen**,
    **Waterfall** (12/16/24/36/56 px), **Characters**; specimen editing of sample text, size, background
    (light/dark/theme), direction, kerning, standard ligatures; collection face selection and variable
    axes; per-split sample/settings; **Characters** browses mapped Unicode incl. private-use and
    supplementary, **Go to character** accepts a character or `U+E000`; inspector shows glyph ID, advance,
    available outline bounds, **Copy character**; metadata pages for names, metrics, license text, detected
    color tables; "Unicode mappings and missing sample characters are reported separately from native
    rendering"; "Symbol-only fonts are not remapped to guessed Unicode characters"; "The WOFF2 decoder
    rejects some large or unusually compressible fonts, including expansions over its 128 MiB or 100:1
    limits"; hiding a font releases "its worker and native font resources", returning revalidates the
    source; "Previewing stays local and never installs, edits or exports the font."
* **Terminal** — clickable links; title from the shell plus a user name; split panes side by side or
  stacked, "Each pane runs its own shell"; cwd tracking when the shell reports it ("for example with the
  OSC 7 sequence") so restarted/new terminals resume there; optional output history after restart, "off
  until you turn it on. Output can contain secrets, so it stays on your computer."
* **Folder trust (desktop):** "when a folder has one [Pi setup] and you haven't decided yet, the app asks
  whether you trust it before Pi uses it. You can trust the folder, its parent folder, or only this
  session. If you don't trust it, Pi still works there with your own setup. Pi in a terminal keeps its
  answers in the same place, so a folder you trusted there is trusted here too." Changing the answer
  restarts Pi for that folder.
* **Updates:** "The app checks for its own updates and downloads them in the background. You can have it
  only tell you about a new release, or never check."

---

## 11. SETTINGS TABLE

Only one settings **key** is printed anywhere in the guide: `pendant.sandbox.allowWrite`
(`10-settings.md:72`). Everything else is named by its UI label; the guide also states Pendant's
settings are "an ordinary editor setting[s]" values in VS Code (`13-hooks.md:101`), i.e. they live in
editor settings under an as-yet-unstated prefix (inferred `pendant.*`). `[AMBIGUOUS]` full key names.

Effective-immediately rules (`10-settings.md:12-17`): most settings apply at once, including to open
chats; settings that change how Pi start apply "once Pi restarts" (prompt and resource settings, the
default tool set, the sandbox, working offline, the extension UI mode, Pi's environment variables) —
"Pendant restarts Pi on its own once no session is running"; the **location of Pi's folder** applies
"after Pendant itself restarts".

### 11.1 Transcript
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| View mode | enum `focused` \| `detailed` | `[AMBIGUOUS]` | focused "folds runs of the agent's routine tool activity into quiet rows"; detailed "shows every tool call on its own" |
| Tool expansion | enum folded \| normal \| fully open, + per-tool-by-name overrides | `[AMBIGUOUS]` | "Errors, and tools you opened yourself, stay open." |
| Group file exploration | boolean | `[AMBIGUOUS]` | groups consecutive reads/searches/listings into one openable row |
| Hide malformed tool calls | boolean | on ("hidden by default") | "Tool calls the model wrote incorrectly… are hidden by default" |
| Show failed read-only calls quietly | boolean | `[AMBIGUOUS]` | e.g. reading a non-existent file "shown quietly instead of as errors" |
| Command labels | enum readable \| raw | readable | "Common commands, for example Git or test runs, get a readable label." |
| Thinking fold | enum open \| folded \| fold when done | `[AMBIGUOUS]` | thinking hidden in the transcript unless shown (05:34) |
| Long-session load size | integer | `[AMBIGUOUS]` | "Long sessions load their most recent messages first. You can change how many." |

### 11.2 Diffs and changes
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Diff layout | enum side-by-side \| inline | `[AMBIGUOUS]` | "Show removed and added lines side by side, or one after the other." |
| Markdown diff | enum rendered \| raw + per-edit toggle | `[AMBIGUOUS]` | "Each edit also has a switch." |
| Open-in-tab threshold | size | `[AMBIGUOUS]` | "how large an edit must be before it opens in its own editor tab" |
| Auto-open-in-chat ceiling | size | `[AMBIGUOUS]` | "Small finished edits open by themselves in the chat, and you choose up to which size" |
| Changed-files summary | enum off \| on | on | "can be turned off" |
| Summary path style | enum tree \| full paths | `[AMBIGUOUS]` | |
| Summary file count | enum first few \| every file | `[AMBIGUOUS]` | |

### 11.3 Message box
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Send / steer keys | two key bindings | `[AMBIGUOUS]` | "If the two collide, sending wins." Inverted option: sending steers, second key queues (09:12) |
| Long-paste fold threshold | length \| off | on | "how long a pasted text must be before it folds into a badge" |
| Prompt history | boolean | on | "Prompt history can be turned off." |
| Cursor shape | enum line \| underline \| block | `[AMBIGUOUS]` | |
| Attach selection on clicking into the box | boolean | on | "You can turn this off in the settings." |
| Keep the open file attached | boolean | **off** ("off until you turn it on") | follows you across file switches; removal sticky until next file switch |

### 11.4 Appearance
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Own messages right-aligned | boolean | on | "Both can be turned off" (alignment + tint) |
| Accent tint on own messages | boolean | on | |
| Stronger contrast | boolean | off | clearer borders/backgrounds for tool calls, thinking, replies |
| Interface font / code font / base font size | string/number | theme defaults | "For accessibility" |
| Scrolling | enum smooth \| jump | smooth | "The transcript scrolls smoothly as new output arrives, or jumps if you prefer." |
| **Group running sessions** | boolean | **off** ("This is off by default. Turn on … to use it.") | running sessions move to a `Running` group at the top; return when done |
| Theme | follows editor | — | "Pendant's colours follow your light, dark or high-contrast theme." |

### 11.5 Extensions
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Widget placement | enum beside composer \| pinned at top of chat | beside | "pinned at the top of the chat so they stay visible while you scroll" |
| Checklist cards | boolean | on | "can be turned off" |
| Show status values | enum off \| footer \| status bar \| both | **hidden** ("stays hidden until the user chooses") | also a key allowlist: "You can also limit them to the values you care about." |
| Extension UI mode | enum **Dialogs** \| **Terminal** | Dialogs (`ctx.mode = "rpc"`) | maps to `ctx.mode`; "decides whether extensions show dialogs or terminal cards" |

### 11.6 Pi
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Pi's folder | path | "the same folder as Pi in a terminal" | needs a Pendant restart |
| Environment variables | map | empty | "Give the Pi that Pendant runs extra environment variables, for example a proxy" |
| Retrying | boolean | on | "Pi retries on its own when a provider reports a passing error… You can turn that off." |
| Working offline | boolean | off | "switches off Pi's and Pendant's own network use, apart from talking to your model provider" |
| Cache warming | enum agent-run \| also idle \| never (Pi setting, in the Pi panel) | `[AMBIGUOUS]` | 05:100-102 |
| Automatic compaction | boolean (Pi setting) | on | 06:82 |

### 11.7 Sandbox (off by default)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Sandbox enabled | boolean | **off** | "The sandbox is off by default." Unavailable (cannot be enabled) on Windows |
| Where the agent can write | enum workspace \| read-only | `[AMBIGUOUS]` | workspace: files there "and in temporary folders"; read-only: "allows temporary files" |
| `pendant.sandbox.allowWrite` | path list | empty | extra writable folders in both modes, "for example package manager caches" |
| Extra protected files/folders | path list | empty | "You can add files of your own, for example a project's secrets file." |
| Network for agent commands | boolean | on | "Commands the agent runs can be cut off from the network." |

### 11.8 Notifications
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| System notifications | enum off \| finished \| waiting \| both | `[AMBIGUOUS]` | "They appear only while Pendant is not in front."; clicking jumps to the session where supported |
| Sound | boolean + custom sound file | `[AMBIGUOUS]` | "can play at the same moments" |
| Hook command | command line (shell) | empty = disabled | run through `/bin/sh` or `cmd.exe`; 10 s limit |
| Hook events | list of `input_request`, `agent_finished` | `input_request` only | marked experimental |

### 11.9 Providers / usage
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Usage-limit footer | boolean | on | "the footer shows how much of your usage limit is left" |
| Credit balance in model tooltip | boolean | on | "Both can be turned off." |

### 11.10 Models, tools, prompts (described in 05)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Presets (model + thinking level) | ordered list, rename, **Show in composer strip** per item | none | strip appears once any preset enables it; folding overflow button |
| Default model | model id | Pi's default | set/clear via the star in the model picker |
| **Default preset** | preset id | none | overrides the default model; new chats only |
| New-chat tool set | enum defaults \| read-only \| none \| custom | `[AMBIGUOUS]` | "A new chat starts with the set you chose in Pendant's settings" |
| Replace system prompt | text \| file | none (Pi's own) | applied on Pi restart |
| Append prompts | text | empty | appended after Pi's prompt |
| Read context files (`AGENTS.md`, `CLAUDE.md`) | boolean | on | can be stopped |
| Extra extension/skill/template paths | path list | empty | plus "switch off automatic discovery" |

### 11.11 Sessions (described in 07)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Automatic session naming | boolean | **off** ("This is off until you turn it on") | sends the first message to a temporary session for a title |
| Search scope | this workspace \| all workspaces | `[AMBIGUOUS]` | other-workspace sessions open read-only |

### 11.12 Git (described in 08)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Commit-message model / thinking level | model + level | "the model and thinking level of the chat you are working in" | override pair |
| Commit-message instructions | text \| repo file path | empty | "as text or from a file in your repository" |
| Commit-message language | language | `[AMBIGUOUS]` | "choose the language of the message" |
| PR-description instructions | text | empty | "it has its own setting for instructions" |

### 11.13 Conveniences (09) and privacy/diagnostics (10, 19)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Prompt-suggestions model | model | **off** ("off until you choose a model for it") | sends your last message + the agent's last reply |
| Send-vs-steer key inversion | boolean | off | 09:12 |
| Exported-chat defaults | display choices (thinking, timestamps, raw tool data) | `[AMBIGUOUS]` | follow the user's display choices |
| Diagnostic logs | boolean | **off by default** | writes logs to files locally; "They never leave your computer unless you send them." |

### 11.14 VS Code host (17)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Session list side | enum left \| right \| hidden | `[AMBIGUOUS]` | "The list can sit on either side of the chat, or be hidden." |
| Open last session at startup | boolean | off (start page) | "instead of the start page" |
| Extension status value location | enum status bar \| Pendant panel \| both | hidden | 17:16 |
| Scope of writes | workspace if folder open, else user | — | computer-scoped settings (e.g. remote access) stay machine-local |

### 11.15 Voice (14)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Model | one of the eight `ggml-*.bin` | `ggml-base.bin` | downloaded on first use |
| Custom model path | absolute path | empty | must exist; no download when set |
| Language | language code | English | ignored by `.en` models; Chinese covers Cantonese |
| Microphone | device | system default | |
| Hold to dictate | boolean | on | "You can turn off holding in Pendant's settings." |

### 11.16 Remote access (15)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Remote access enabled | boolean | **off** | machine-scoped, never synced |
| Paired devices | list (name, model, public key) | empty | revocable; "disconnected at once and refused afterwards" |
| Address list | network addresses | — | shown in settings; re-pair after address changes |

### 11.17 Desktop-only (18)
| Setting | Type | Default | Semantics |
| --- | --- | --- | --- |
| Explorer follows the edited file | boolean | on | "You can turn this off." |
| Language servers | global + per-server on/off, per-server program/args/env/options/settings | built-ins on | restart semantics per §10.4 |
| Editor helpers | per-helper toggles incl. diagnostic severity threshold, hover, outline | on | |
| Terminal output history | boolean | **off** | "Output can contain secrets, so it stays on your computer." |
| Update behaviour | enum auto-download+install \| notify only \| never check | `[AMBIGUOUS]` | "checks for its own updates and downloads them in the background" |
| Folder trust | trust folder \| trust parent \| trust this session \| don't | undecided → prompt | shared storage with terminal Pi |

---

## 12. LIMITS, PRIVACY, SECURITY

### 12.1 Hard limits — "Pendant does not" (`16-limits.md:6-18`, verbatim-critical)

* "**Provide models.** There are no built-in models, subscriptions or credits. You bring a provider or a
  local model through Pi."
* "**Add an agent of its own.** The agent is Pi. The settings Pendant offers, for example tool sets or
  extra prompts, are handed to Pi."
* "**Ask before the agent acts.** Nothing in Pendant asks before a command runs or a file changes. By
  default tools run with your permissions, as they do when you run Pi in a terminal. The optional
  sandbox … limits what they can reach on macOS and Linux, but it does not ask either."
* "**Need an account or a server.** Pendant has no account, server or telemetry. It does not report
  crashes or sync sessions between computers."
* "**Coordinate several agents in one folder.** If you run more than one session at a time in the same
  workspace, keeping them out of each other's way is up to you."
* "**Use a Pi you installed yourself.** Pendant brings its own Pi, tested together with each release."
* "**Offer everything the terminal offers extensions.** … a few terminal-only ones, for example an
  extension's own keyboard shortcuts, do not."
* Also (01-at-a-glance.md:17-20): no models/subscriptions/credits; no approval prompts; "Route anything
  through a Pendant server, need an account or collect telemetry".
* Not listed as supported: browser-based VS Code (17:58); Windows sandbox (10:77); pausing subagent runs
  (12:126); branch creation/merge/rebase in the desktop Git view (18:222).

### 12.2 What is sent where (`19-privacy.md`)

* Model traffic: "Pi sends your prompts and the context they need directly to your model provider,
  using the credentials you gave Pi. Some optional features, for example generated session names or
  prompt suggestions, send the text they need to the same provider. With a local model, your prompts and
  code never leave your computer. Pi may still look up its model list online unless you turn on the
  offline setting."
* Commit messages / PR descriptions: "The diff and file names go to your model provider, like any other
  prompt. With a local model, they stay on your computer." (08:38)
* Prompt suggestions send "your last message and the agent's last reply" (09:70).
* Automatic session naming sends "your first message" (07:22).
* Pendant-originated connections: none of its own — "It sends no telemetry, no crash reports, and no
  prompts or code to anyone but your model provider. Beyond that, it connects to the internet only for
  conveniences you can do without. For example, it downloads a voice model the first time you dictate,
  and it lets you browse and update Pi packages. An offline setting switches these off." (19:12)
* Hugging Face sees "ordinary network information such as your IP address" during model downloads
  (14:50). npm is contacted for package browsing/updates (05:90).
* **Never sent:** voice audio and transcripts ("no audio or text reaches Pendant's developers or anyone
  else", 14:21); nothing to any Pendant server (03:25, 15:43).
* Remote access: "The phone connects directly to your computer, encrypted end to end, and nothing passes
  through a Pendant server." (19:16)

### 12.3 Trust model

* Two independent trust surfaces:
  1. **Workspace / folder trust.** In VS Code: "Pendant supplies a trusted project-resource decision to Pi
     in the editor. It does not ask a separate Pi folder-trust question or consult Pi's saved folder
     decisions in this setup. Project resources can include executable extensions, so open projects whose
     setup you trust. **The tool sandbox does not confine extension code.**" (17:48)
     In Desktop: an explicit prompt with `trust folder` / `trust parent` / `trust this session`, stored
     where terminal Pi stores its answers (18:208-212).
     Gated on trust: project-scoped package installs (05:92), worktree setup commands (07:44), worktree
     sessions (07:48), project resources (11:19).
  2. **Extension trust** — extensions "run with the same access as the agent" (05:98) and "Pendant
     dispatches no `project_trust` event to extensions", so `ctx.isProjectTrusted()` is the only signal
     (11:19-21).
* Hook trust: "A hook runs as you… with your user account's rights"; "Workspace settings count too";
  "Settings Sync can copy the hook command to your other computers. Keep secrets such as access tokens in
  the script or in a file it reads, not in the command itself." (13:110-116)
* Phone trust: "A paired phone can do in these sessions what you can do at the keyboard. So pair only
  phones you own." (15:29)
* MCP trust: sandbox does not cover extension/MCP tools → "turn off the ones you don't trust" (10:81).

### 12.4 Sandbox rules (`10-settings.md:64-80`) — verbatim-critical

* Confines "the tools Pi uses to read files, change files and run commands".
* Write scope: workspace (workspace + temporary folders) or read-only (temporary files only); plus
  `pendant.sandbox.allowWrite` extras in both modes.
* Read protections: "Configuration that Pendant, Pi, Git, your editor or your shell would later run
  outside the sandbox stays read-only, for example Pi's extensions and Git hooks. Credentials such as
  SSH keys, cloud logins and Pi's stored provider keys can't be read at all, and commands don't see
  provider keys from the environment or reach helpers such as the SSH agent."
* Network: when off, "macOS still allows access to host localhost; Linux blocks access to the host
  network, including host localhost. On macOS, keep debugging ports and local admin tools closed while
  the agent works."
* Transparency: "The agent learns what the sandbox allows, and a refused tool call says why, so it can
  tell you instead of trying to get around it."
* Implementation: macOS system sandbox; Linux bubblewrap ("most distributions offer as a package"). Where
  bubblewrap is missing/can't start: "the agent can still read and change files within the limits, but it
  can't run commands while the sandbox is on." **Windows: "there the sandbox is not available and its
  settings can't be turned on."**
* Linux symlink rule: "shell commands are also refused if protected configuration contains a symbolic link
  in a writable folder. Bubblewrap can protect the link's target but cannot stop a command from replacing
  the link itself."
* Scope caveat: "The sandbox covers the tools Pi comes with. Tools that Pi extensions or MCP servers add
  run as they always do… The settings belong to your computer, so a project's own settings can't loosen
  them."
* Risk-reduction note (16:20): sandbox on, read-only tool sets, an approval-asking extension, version
  control, worktrees for parallel work.

### 12.5 Data written to disk / session integrity

* "Pendant never edits Pi's session files by hand. It never rewrites, reorders or removes what a session
  already holds. Everything that goes into a session is added through Pi, in Pi's own format, so Pi in a
  terminal can always open it." (19:20)
* "The only time Pendant removes a session file is when you delete that session." (19:26)
* Choices that mutate **Pi's own settings**: "connecting a provider or adding a custom one, switching
  packages or parts of them on or off, automatic compaction, and cache warming. Picking a model or
  thinking level in a chat does not. It changes only that session." (19:30)
* Local-only stores: "your preferences, prompt history and any voice model you download" (19:28).
* Search index never persisted (07:16). Commit-prompt audit trail "in memory only" (08:36). Hook log lives
  in the editor's output view (13:74).
* Bug reports: "Personal details are redacted, and you decide whether diagnostic logs go with it." (07:52)
* Licence boundary (20-help.md:20): "Pendant is not open source. But its licence explicitly allows you to
  inspect, unpack, decompile and deobfuscate your copy for this, and to quote what you find in a bug
  report. You may not redistribute Pendant or copy its code into other software."

---

## 13. TERMINOLOGY GLOSSARY

Terms the guide defines or uses in a load-bearing way:

* **Pi** — the coding agent: "a coding agent. You give it a task in plain language, and it works through
  it on your computer. It reads files, edits them, runs commands and reports back." (02:6)
* **Pendant** — the companion UI around Pi; two forms: "Pendant in VS Code … an extension for your
  editor. Pendant for Desktop … a standalone app with everything built in." (02:8)
* **Pi configuration folder** — "It holds your settings, the providers and credentials you set up,
  extensions, skills, prompt templates and sessions." (03:27)
* **Pi session** — the stored conversation file, shared with terminal Pi (07:6).
* **Turn** — one agent run; used as the unit for tool-set choices, steering, queued-message delivery,
  compaction ("If it fails, the queue carries on"), and "never outlives the turn that started it".
* **Run** — an agent execution; ends normally, stopped, or with an error, and `agent_finished` fires when
  "Pi is not about to retry it" (13:26).
* **Steer** — a message delivered "to the running turn right away" (09:10).
* **Queue** — per-session pending messages; "A queued message goes out when its session's turn ends, even
  while you look at another session. A queued shell command waits until you come back to its session."
  (09:12)
* **Draft** — unsent message text held per session (and one for the start page), with a separate
  **saved-draft** archive capped at 20 per session (09:26-30).
* **Context block** — the `--- pi-extension-context:start ---` … `:end ---` wrapper around attached
  context (06:44).
* **Reference vs quote** — files travel as `@path[:lines]`; only lines unreadable from disk are copied
  into the message (06:22-30).
* **Chip / badge** — UI chips for attachments; a folded long paste; a quote badge that "takes you back to
  the passage" (06:26, 06:70).
* **Omit / Edit / Restore** — per-entry model-visibility overrides stored as Pi session entries (06:80).
* **Compaction** — summarising older turns into one entry (06:78).
* **Context meter** — window-fill indicator that triggers the compaction suggestion (09:66).
* **Thinking (level)** — model reasoning; levels are model-specific, nearest-supported substitution on
  model change (05:28).
* **Preset** — "a model and a thinking level together, as a button next to the message box" (05:36).
* **Tool set** — per-chat choice of Pi tools: defaults / read-only / none / custom (05:54-62).
* **Skill** — "instructions Pi can pick up on its own when they fit the task" (05:64); switchable per
  session; still callable by slash.
* **Prompt template** — "a prompt you saved as a file", started with a slash and its name (05:70).
* **Context file** — `AGENTS.md`, `CLAUDE.md` etc. that Pi may read (05:82).
* **Pi package** — distributable bundle of extensions/skills/prompts on npm, marked as Pi packages
  (05:88-90); user scope vs project scope.
* **Extension** — code loaded by Pi's extension loader using Pi's public API (11:6).
* **Extension UI mode** — Pendant setting mapping to `ctx.mode` = `"rpc"` (Dialogs) or `"tui"` (Terminal)
  (11:27-33).
* **Terminal card** — "a small terminal inside the chat" hosting Pi TUI components (11:36).
* **Widget / status / header / footer / working indicator** — the non-modal extension surfaces (11:40-60).
* **Checklist card** — recogniser for checkbox-form widgets, with a progress bar and auto-hide (11:264).
* **Plan** — a Plannotator plan turned into a ticked checklist after approval (11:266).
* **Tool card** — the per-tool-call transcript entry (11:129).
* **`details.pendant`** — the Pendant-only published view on a tool result (11:147).
* **Subagent** — "another agent that takes one task, works through it and reports back" (12:6); **run**,
  **step**, **chain**, **parallel run**, **workflow**, **background run**, **stale step**, **subagent
  panel** (12:36-112).
* **Native subagent session** — a Pi session that is itself an agent, with a narrower extension UI
  (11:119).
* **Hook** — "a command of your own that Pendant runs when it needs your attention" (13:6); distinct
  from Pi event handlers (`pi.on`) (13:14-16).
* **Worktree session** — a session bound to its own Git worktree and new branch (07:40).
* **Fork / Clone / Branch** — see §2.4.
* **Pinned session / session colour / session name** — Pendant-side organisation kept with the session
  (07:20-22).
* **Bookmarks** — message- or passage-level saved positions stored in the session (09:40-48).
* **Working indicator** — the busy spinner that extensions can restyle and that shows subagent dots
  (11:45-49, 12:104).
* **Busy (session)** — "the chat counts as busy": stop stays, compaction unavailable, queue waits
  (12:112); also "a session that is working" (07:10).
* **Trusted workspace / folder trust / resource trust** — see §12.3.
* **Sandbox** — optional OS-sandboxed confinement of Pi's file/command tools (10:64).
* **Remote access** — the (unreleased) phone-to-computer session following/steering feature (15).
* **Remote development window** — SSH/WSL/container execution of Pendant on a remote host (17:50).
* **Pi panel** — Pendant's panel for Pi-specific controls (folder switch, cache warming, Extension actions).
* **Extension actions** — the picker for `pi.registerShortcut` registrations, also `/actions` (11:311).
* **Read-only session** — a session from another workspace opened for viewing only (07:16).
* **Start page** — the default view at startup instead of a restored session (17:16, 09:26).
* **Changed-files summary** — the post-turn list of touched files with diffs (08:10).
* **MCP manager** — Pendant's in-chat UI for Pi's MCP server list, sign-ins and tool access (11:272).

---

## APPENDIX A — diagrams/ inventory

| File | Depicts (guide caption + box text) |
| --- | --- |
| `diagrams/data-flow.svg` | "Your message goes from the chat to Pendant, which adds context, then to Pi and your model provider. Replies and live events come back the same way, and Pi runs its tools on your computer." Boxes: Chat (the interface) → Pendant (adds context) → Pi (the agent) → Provider (your model); arrows `message`, `prompt`, `request` outbound; `live view`, `events`, `reply` inbound; "tools on your computer". |
| `diagrams/prompt-assembly.svg` | "Attached files and quotes become one context block. Your text follows it, and pasted images travel alongside, all as one message to Pi." |
| `diagrams/composer-context.svg` | "The message box with attachments above the text and a file mentioned inside the text." Shows `@src/cart.ts`, `cart.test.ts:12-30`, `quote`, `image`, `attachments`, `a mention`. |
| `diagrams/commit-message.svg` | "Your staged changes, the branch and file list, and your optional instructions go to a temporary session, which writes the commit message into your message box." Footnote: "Contents of files that look sensitive are held back. Only their names are sent." |
| `diagrams/session-branching.svg` | "A conversation runs down the left. From one of Pi's replies, a new branch starts with a different message from you and continues on its own. The original conversation stays unchanged." Labels `fork or edit here`, `new branch`. |
| `diagrams/subagent-detection.svg` | "A tool call whose name Pendant knows becomes a run of that extension, with its card, the panel and the controls. A call with another name whose result points to a subagent session on disk becomes an unknown run, which appears in the panel while its tool keeps a plain card." |
| `diagrams/drag-session-to-editor.svg` | "A session is dragged from the list in the sidebar into the editor area. Dropped on the right-hand editor group, it opens there as a tab." |

Inline (non-SVG) diagrams in the guide: two `flow` blocks — the architecture chain
(`03-how-it-works.md:8-12`) and the dictation chain (`14-voice.md:8-13`); one `prompt` block with the
exact wire format (`06-context.md:50-68`); one JSON payload example (`13-hooks.md:57`); two TypeScript
extension examples (`11-extensions.md:232-300`).

## APPENDIX B — `[AMBIGUOUS]` register (highest-value items to check against code)

1. **IPC transport and message schema** between the UI and the Pi worker process; between webview and
   extension host; Pi's RPC protocol version/framing. Guide only says "a background process of its own"
   (03:19) and names the `"rpc"` mode.
2. **Settings keys** — every key except `pendant.sandbox.allowWrite` is unnamed; the prefix, the JSON
   types and the defaults are all unstated (§11).
3. **Session file format details** — file naming scheme, the entry type names for Pendant's own entries
   (tool set / skills-off), how pins/colours are keyed, and the exact directory layout under Pi's
   sessions folder. Only `…/agent/sessions/project/session.jsonl` is shown (13:41).
4. **The `pi-extension-context` block for the other context kinds** (problems/diagnostics, Git state,
   pinned selection, quoted diff lines) — tag names and ordering beyond `file-context` → `quote-context`
   are never shown (06:40-72).
5. **Token/size budget rules for attachments** — none documented other than the context meter, the
   "very large diff" cut in commit-message generation, and "Bodies have no length limit" for
   `details.pendant`.
6. **Undo/recorded-edit semantics** — which tool calls count as "recorded text edits", where the undo
   record lives, and how command-based changes are excluded (08:13-16).
7. **Sandbox profiles** — exact OS-level mechanism/policy file names, the default write scope, and the
   concrete list of protected credential paths (10:64-80).
8. **Whether a per-message/per-session cost display exists** for normal turns; only subagent cost
   parsing and provider usage footers are described (05, 10:92).
9. **Hook log command identifier** ("Pendant has a command that opens this log") and the log's file
   location (13:74-78).
10. **Multi-root behaviour** — session list grouping, `@`-path base, and search scope with more than one
    root open (07:8, 06:22, 17:14).
11. **Worktree branch naming and the "hidden folder" location** inside the repository (07:40).
12. **Voice pipeline parameters** — sample rate, threading, streaming, expected latency; no checksum
    verification of downloads (14:50, 14:70).
13. **`ctx.mode` vs actual gating** — the guide insists mode "does not switch any feature on or off",
    but also that native-subagent sessions *do* suppress surfaces; the precise gating conditions for
    suppression live elsewhere in code (11:108-114).
14. **Subagent transcript reading** — "a step whose result or status file names a transcript"; the status
    file path convention is unstated except for `PI_SUBAGENTS_TEMP_ROOT` (12:102, 12:110).
15. **Command palette / slash command inventory** — only `/compact` and `/actions` are named; Pendant's own
    command names (start chat, pick model, open settings) are referenced generically (09:16, 11:311, <PENDING>).
16. **Desktop process model** — "workspace service", per-view workers, GPU context lifetimes; and whether
    the VS Code extension shares any of that (18:171-196).
17. **Which editor APIs are used for chat tabs** (custom editor descriptors) and how tabs restore
    (17:22-30).
18. **Remote-access port/protocol specifics** — per-window port allocation, QR payload schema, Noise
    handshake pattern (15:33-56).
