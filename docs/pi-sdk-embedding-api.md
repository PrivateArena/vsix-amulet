# Pi SDK 1.4.0 — embedding API reference (verified against the published package)

Extracted from @earendil-works/pi-coding-agent dist/*.d.ts, docs/ and examples/. This is the dependency contract for Amulet: the agent layer is this package, not reversed Pendant code.

## BLOCKER (must state first)

I was cut off at the 30-turn limit **before writing `/media/jang/home/Deve/vsix-amulet/docs/pi-sdk-embedding-api.md`**. No file was created and nothing in the repo was modified. Below is the complete gathered reference (all verified against the installed package) so the document can be written in one pass from this report.

Package root: `/tmp/pisdk/node_modules/@earendil-works/pi-coding-agent/` (referred to as `PKG` below). Version 1.4.0, ESM-only, `engines.node >=22.19.0`, bin `pi` = `dist/bundle/cli.js` (package.json:1-30). Exports map: `"."` → `dist/index.js` / `"./rpc-entry"` → `dist/bundle/rpc-entry.js` (package.json exports).

---

## 1. EMBEDDING STRATEGY CHOICE

Three boundaries (docs/rpc.md:7-10):

| Option | Entry symbols | Boundary |
|---|---|---|
| In-process SDK | `createAgentSession`, `AgentSession`, `SessionManager`, `SettingsManager`, `ModelRuntime`, `AgentSessionRuntime` — all exported from `dist/index.d.ts:3-38` | Same process; crash = extension host crash |
| `RpcClient` (typed subprocess client) | `RpcClient`, `RpcClientOptions`, `RpcEventListener`, `ModelInfo` exported from `dist/index.d.ts:41` via `dist/modes/index.d.ts:7` | Child process, JSONL hidden |
| Raw `pi --mode rpc` | CLI spawn `node dist/cli.js --mode rpc`; types `RpcCommand`, `RpcResponse`, `RpcExtensionUIRequest`, `RpcExtensionUIResponse`, `RpcSessionState`, `JsonAgentSessionEvent`, plus helpers `serializeJsonLine`, `attachJsonlLineReader` (not in public index exports; live in `dist/modes/rpc/rpc-types.d.ts`, `dist/modes/rpc/jsonl.d.ts:8,16`) | Full control incl. extension UI |

**For VS Code**: use raw `pi --mode rpc` JSONL (or a thin wrapper around it) — `RpcClient` cannot answer `extension_ui_request` records (its `send()` is private, `dist/modes/rpc/rpc-client.js:441`; `handleLine` only forwards non-matching records to event listeners, rpc-client.js:412-431; no respond API in `rpc-client.d.ts:35-253`). Crash isolation + restart: both subprocess options give it; RpcClient is adequate if no extension-UI dialogs are needed.

**RpcClient exact surface** (`dist/modes/rpc/rpc-client.d.ts`):
- `RpcClientOptions` (lines 14-27): `{ cliPath?, cwd?, env?: Record<string,string>, provider?, model?, args?: string[] }`
- `constructor(options?: RpcClientOptions)` (:44); `start(): Promise<void>` (:48) spawns `spawn("node", [cliPath ?? "dist/cli.js", "--mode","rpc", "--provider"?, "--model"?, ...args])` with `cwd`, `env: {...process.env, ...options.env}`, `stdio:["pipe","pipe","pipe"]` (rpc-client.js:31-46). It waits 100 ms then checks exit code (js:79-84).
- `stop()` (:52) — removes stdout reader, `SIGTERM`, escalates `SIGKILL` after 1000 ms (js:89-108).
- `onEvent(listener: RpcEventListener): () => void` (:56); `RpcEventListener = (event: JsonAgentSessionEvent) => void` (:34). Not an EventEmitter; array of listeners, unsubscribe fn returned (js:112-120).
- `getStderr(): string` (:60). stderr also mirrored to host stderr (js:49-52).
- Methods (:66-247): `prompt(message, images?, streamingBehavior?)→Promise<PromptDisposition>`; `steer/followUp→QueuedInputDisposition`; `abort()`; `clearQueue()→{steering,followUp}`; `newSession(parentSession?)→{cancelled}`; `getState()→RpcSessionState`; `setModel(provider,modelId)`; `cycleModel()`; `getAvailableModels()→ModelInfo[]`; `setThinkingLevel(level)`; `cycleThinkingLevel()`; `getAvailableThinkingLevels()`; `setSteeringMode/setFollowUpMode(mode)`; `compact(customInstructions?)→CompactionResult`; `setAutoCompaction/setAutoRetry(bool)`; `abortRetry()`; `bash(command)→BashResult`; `abortBash()`; `getSessionStats()`; `exportHtml(outputPath?)→{path}`; `switchSession(path)→{cancelled}`; `fork(entryId)→{text,cancelled}`; `clone()`; `getForkMessages()`; `getEntries(since?)`; `getTree()`; `getLastAssistantText()`; `setSessionName(name)`; `getMessages()`; `getCommands()`; `waitForIdle(timeout=60000)` (resolves on `agent_settled`, rpc-client.js:366-380); `collectEvents(timeout=60000)`; `promptAndWait(message, images?, timeout=60000)` (js:404-408).
- Per-command response timeout 30 s in `send()` (js:463-466); process exit rejects all pending with `Agent process exited (code=… signal=…). Stderr: …` (js:432-434).
- `ModelInfo` (:28-33): `{provider, id, contextWindow, reasoning}`.
- Example: `examples/rpc-client.ts:15-35` (construct with `cliPath`, `args:["--no-session"]`; `start(); promptAndWait(); unsubscribe(); stop()`).

## 2. RPC COMMAND CATALOGUE

Authoritative union `RpcCommand` — `dist/modes/rpc/rpc-types.d.ts:14-136`; docs `docs/rpc-commands.md`. All commands: `{id?: string, type, ...}`. Response envelope: `{id?, type:"response", command, success:true, data?}` | `{id?, type:"response", command, success:false, error:string}` (rpc-types.d.ts:162-404).

Run control: `prompt {message, images?: ImageContent[], streamingBehavior?: "steer"|"followUp"}` → `data.disposition: PromptDisposition` = `"handled"|"queued"|"started"` (agent-session.d.ts:174-175; rpc-commands.md:37-42). Error if streaming & no streamingBehavior (rpc-commands.md:29). `steer {message, images?}` / `follow_up {message, images?}` → `{disposition: "handled"|"queued"}`. `abort` → success, no data (waits idle first, rpc-commands.md:96). `clear_queue` → `{steering: string[], followUp: string[]}`.

State: `get_state` → `RpcSessionState` (rpc-types.d.ts:148-161): `{model?: Model<any>, thinkingLevel, isStreaming, isCompacting, steeringMode, followUpMode, sessionFile?, sessionId, sessionName?, autoCompactionEnabled, messageCount, pendingMessageCount}`. `get_messages` → `{messages: AgentMessage[]}`.

Model/thinking: `set_model {provider, modelId}` → full `Model` object (rpc-commands.md:836-858: id,name,api,provider,baseUrl,reasoning,input,contextWindow,maxTokens,cost{input,output,cacheRead,cacheWrite}); `cycle_model` → `{model, thinkingLevel, isScoped}|null`; `get_available_models` → `{models: Model[]}`; `set_thinking_level {level}` (levels `"off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"`, rpc-commands.md:282); `cycle_thinking_level` → `{level}|null`; `get_available_thinking_levels` → `{levels}` (`["off"]` if no reasoning support).

Queue modes: `set_steering_mode {mode:"all"|"one-at-a-time"}`, `set_follow_up_mode {mode}` (no data).

Session mgmt: `new_session {parentSession?}` → `{cancelled}`; `switch_session {sessionPath}` → `{cancelled}`; `fork {entryId}` → `{text, cancelled}`; `clone` → `{cancelled}`; `get_fork_messages` → `{messages:[{entryId,text}]}`; `get_entries {since?}` → `{entries: SessionEntry[], leafId: string|null}` (entry-id cursor; bad `since` → `success:false`, rpc-commands.md:717); `get_tree` → `{tree: SessionTreeNode[], leafId}` (node = `{entry, children, label?, labelTimestamp?}`); `get_last_assistant_text` → `{text: string|null}`; `set_session_name {name}` → no data; `get_session_stats` → `SessionStats` (agent-session.d.ts:202-219: sessionFile,sessionId,userMessages,assistantMessages,toolCalls,toolResults,totalMessages,tokens{input,output,cacheRead,cacheWrite,total},cost,contextUsage?{tokens,contextWindow,percent}); `export_html {outputPath?}` → `{path}`.

Bash: `bash {command, excludeFromContext?}` → `BashResult` `{output, exitCode, cancelled, truncated, fullOutputPath?}` (rpc-commands.md:454-491); output streams via `bash_execution_update`. `abort_bash` → no data. Bash output reaches model only on next `prompt` as `Ran \`cmd\`` + fenced output (rpc-commands.md:493-509).

Compaction: `compact {customInstructions?}` → `CompactionResult` `{summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage?, details}` (rpc-commands.md:381-404). `set_auto_compaction {enabled}`. Retry: `set_auto_retry {enabled}`, `abort_retry`.

Commands: `get_commands` → `{commands: RpcSlashCommand[]}` (rpc-types.d.ts:138-147): `{name, description?, source:"extension"|"prompt"|"skill", sourceInfo:{path,source,scope:"user"|"project"|"temporary",origin:"top-level"|"package",baseDir?}}`. Built-in TUI commands not included (rpc-commands.md:834).

Framing: strict JSONL, LF-only, strip optional CR; **do not use Node `readline`** (splits U+2028/U+2029) — rpc.md:50-56, json.md:13-19. Correlate by `id`, not order (rpc.md:36-48). Malformed JSON → `{"type":"response","command":"parse","success":false,"error":...}` without id (rpc.md:81-85).

## 3. EVENT CATALOGUE

Wire events are `JsonAgentSessionEvent` = `Exclude<AgentSessionEvent,{type:"message_update"}> | {type:"message_update"; usage: Usage; assistantMessageEvent: ...}` (`dist/modes/json-event.d.ts:22-24`).

In-process `AgentSessionEvent` = core `AgentEvent` (pi-agent-core `dist/types.d.ts:452-193`, re-numbered 153-193 of that block: `agent_start`; `agent_end{messages}` [overridden below]; `turn_start`; `turn_end{message, toolResults: ToolResultMessage[]}`; `message_start{message}`; `message_update{message, assistantMessageEvent}`; `message_end{message}`; `tool_execution_start{toolCallId,toolName,args}`; `tool_execution_update{...+partialResult}`; `tool_execution_end{toolCallId,toolName,result,isError,durationMs?}`) **plus** session events in `dist/core/agent-session.d.ts:47-109`:
- `agent_end {messages, willRetry}` (:49-52)
- `agent_settled {aborted}` (:53-55)
- `queue_update {steering, followUp}` (:56-59, readonly string[])
- `compaction_start {reason:"manual"|"threshold"|"overflow"}` (:60-62)
- `entry_appended {entry: SessionEntry}` (:63-65)
- `session_info_changed {name: string|undefined}` (:66-68)
- `thinking_level_changed {level}` (:69-71)
- `compaction_end {reason, result: CompactionResult|undefined, aborted, willRetry, errorMessage?}` (:72-78)
- `auto_retry_start {attempt,maxAttempts,delayMs,errorMessage}` / `auto_retry_end {success,attempt,finalError?}` (:79-89)
- `summarization_retry_scheduled {attempt,maxAttempts,delayMs,errorMessage}` / `summarization_retry_attempt_start {source:"branchSummary"} | {source:"compaction",reason}` / `summarization_retry_finished` (:90-104)
- `bash_execution_update {id?, delta}` (:105-108, RPC-only)
- `extension_error {extensionPath, event, error}` (RPC-only, json.md:190-194)
- tool_execution_* may carry `parentToolCallId` (agent-session.d.ts:40-45)

On the wire, `message_update` **drops `message` and every `assistantMessageEvent.partial`** (json.md:72, json-event.d.ts:25-31). `assistantMessageEvent` union members (pi-ai `dist/types.d.ts:575-628`): `start`, `text_start{contentIndex}`, `text_delta{contentIndex,delta}`, `text_end{contentIndex,content}`, `thinking_start`, `thinking_delta`, `thinking_end`, `toolcall_start{contentIndex}` (wire adds `id, toolName`, json-event.d.ts:6-12 / json.md:85), `toolcall_delta{contentIndex,delta}` (serialized argument JSON), `toolcall_end{contentIndex, toolCall}`, `done{reason:"stop"|"length"|"toolUse"|"deferred", message}`, `error{reason:"aborted"|"error", error: AssistantMessage}`. In-process each also carries `partial: AssistantMessage` (:577 etc).

Reconstruction rules (json.md:70-99, rpc.md:58-71): provider `start/done/error` are translated into `message_start`/`message_end`, not `message_update` (json.md:91); buffer deltas keyed by `contentIndex` for live display but **replace with `text_end`/`thinking_end` content and `toolcall_end.toolCall`**; replace whole partial with `message_end.message` (authoritative). Tool results: `tool_execution_end.result` = `{content:[...], details, ...}`; correlate by `toolCallId`; assemble final `ToolResultMessage` from `message_end` with `role:"toolResult"`. `turn_end` follows assistant+toolResults. `agent_end` = one low-level run; retries/compaction/steering/follow-ups may follow — only `agent_settled` means "won't continue automatically" (json.md:48, rpc.md:69). `queue_update` carries complete current queues.

## 4. EXTENSION UI PROTOCOL

`RpcExtensionUIRequest` union — `rpc-types.d.ts:406-462`; docs `docs/rpc-extension-ui.md`. All: `{type:"extension_ui_request", id, method}`:
- `select {title, options: string[], timeout?}` → respond `{id, value}` or `{id, cancelled:true}`
- `confirm {title, message, timeout?}` → `{id, confirmed: boolean}` or cancelled
- `input {title, placeholder?, timeout?}` → `{id, value}` or cancelled
- `editor {title, prefill?}` → `{id, value}` or cancelled
- `notify {message, notifyType?:"info"|"warning"|"error"}` — fire-and-forget
- `setStatus {statusKey, statusText: string|undefined}` — undefined clears
- `setWidget {widgetKey, widgetLines: string[]|undefined, widgetPlacement?:"aboveEditor"|"belowEditor"}` — string arrays only
- `setTitle {title}`; `set_editor_text {text}`

`RpcExtensionUIResponse` (`rpc-types.d.ts:464-476`): `{type:"extension_ui_response", id, value:string} | {id, confirmed:boolean} | {id, cancelled:true}`. Cancellation → extension sees `undefined`/`false` (rpc-extension-ui.md:188-194). `timeout` → agent auto-resolves with default server-side; client needn't track (:10). UI responses do **not** produce a command response (rpc.md:48). Degraded methods list (rpc-extension-ui.md:14-25): `custom()`→undefined, no-op setters, `getAllThemes()`→[], `setTheme()` error string; `ctx.mode==="rpc"`, `ctx.hasUI===true`.

## 5. MESSAGE AND SESSION TYPES

`docs/message-types.md`: content blocks `TextContent{type:"text",text,textSignature?}` (:17-23), `ImageContent{type:"image",data,mimeType}` (:29-35), `ThinkingContent{type:"thinking",thinking,thinkingSignature?,redacted?}` (:41-48), `ToolCall{type:"toolCall",id,name,arguments,thoughtSignature?,namespace?}` (:54-63); `Usage` (:71-88). Messages: `SystemMessage` (:96-105), `UserMessage{role:"user",content:string|(Text|Image)[] ,timestamp}` (:111-117), `AssistantMessage` (:121-141, incl. `api,provider,model,responseModel?,responseId?,thinkingLevel?,usage,stopReason:"pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred",errorMessage?,rawStopReason?,endTurn?`), `ToolResultMessage{role:"toolResult",toolCallId,toolName,content,details?,usage?,nestedCalls?,isError,timestamp}` (:163-175). Coding-agent extras: `BashExecutionMessage` (:204-216), `CustomMessage` (:224-233), `BranchSummaryMessage` (:239-246), `CompactionSummaryMessage` (:252-259); `AgentMessage` union (:267-277). Message timestamps: unix ms; session entry timestamps: ISO 8601 (message-types.md:5, session-format.md:47).

Session format (`docs/session-format.md`, `dist/core/session-manager.d.ts`): files `~/.pi/agent/sessions/--<encoded-path>--/<timestamp>_<session-id>.jsonl`; encoding strips leading sep, replaces `/ \ :` with `-` (session-format.md:10-14). Header `SessionHeader{type:"session",version?(3),id,timestamp,cwd,parentSession?}` (session-manager.d.ts:5-12, `CURRENT_SESSION_VERSION=3` :4). `SessionEntryBase{id,parentId,timestamp,type}` (:17-22). Entry union (:128): `message{message: AgentMessage}` | `thinking_level_change{thinkingLevel}` | `model_change{provider,modelId}` | `usage{kind,provider,model,usage,note?}` | `compaction{summary,firstKeptEntryId,tokensBefore,details?,usage?,fromHook?,systemMessage?}` | `branch_summary{fromId,summary,...}` | `custom{customType,data?}` | `custom_message{customType,content,display,details?}` | `context_edit{targetId,replacement}` | `label{targetId,label}` | `session_info{name?}`. `SessionTreeNode{entry,children,label?,labelTimestamp?}` (:132-139). `SessionInfo{path,id,cwd,name?,parentSessionPath?,created,modified,messageCount,firstMessage,allMessagesText}` (:163-177). `SessionManager` statics: `create(cwd, sessionDir?, options?)`, `open(path, sessionDir?, cwdOverride?)`, `continueRecent(cwd, sessionDir?)`, `inMemory(cwd?, options?, entries?)`, `forkFrom(sourcePath,targetCwd,sessionDir?,options?)`, `findById(cwd,id,sessionDir?)`, `list(cwd, sessionDir?, onProgress?, signal?)`, `listAll(...)` (:371-414); instance: `appendMessage`, `getBranch`, `getEntries`, `getTree`, `buildSessionContext`, `newSession`, `branch`, `createBranchedSession`, etc.

## 6. MODELS & PROVIDERS

`ModelRuntime` (`dist/core/model-runtime.d.ts:36-144`): `static create(options?: CreateModelRuntimeOptions)` (:56) with `{credentials?, authPath?, modelsPath?, modelsStore?, allowModelNetwork?(default false), catalogBaseUrl?, signal?, refreshOnCreate?}` (:4-20); `getModel(providerId, modelId)`, `getModels(providerId?)`, `getAvailable(providerId?, opts?)` (:70-78), `checkAuth`, `hasConfiguredAuth`, `getProviderAuthStatus`, `isUsingOAuth`, `setRuntimeApiKey(providerId, apiKey)` (:93), `removeRuntimeApiKey`, `login/logout`, `registerProvider(providerId, config: ProviderConfigInput)` (:117), `registerVirtualModel`. `ModelRegistry` = sync facade (`model-registry.d.ts:21-62`): `getAll/getAvailable/find/hasConfiguredAuth/getApiKeyAndHeaders/getProviderAuthStatus…`. Scoped models: `resolveCliModel`, `resolveModelScopeWithDiagnostics`, `ScopedModel`, `ModelScopeDiagnostic` (index.d.ts:12); `session.scopedModels`/`setScopedModels` (agent-session.d.ts:477-485); `AgentSession.setModel(model, {persist?})` (:663), `setThinkingLevel(level,{persist?})` (:680), `getAvailableThinkingLevels()` (:690), `cycleModel(direction?,options?)` (:671). Cost/usage on assistant messages per §5. Env API keys: providers.md#use-an-api-key-from-the-environment (`ANTHROPIC_API_KEY` etc., environment-variables.md:99).

## 7. CONFIG & ENV

`SettingsManager` (index.d.ts:33; `SettingsManager.create(cwd, agentDir?)`, `inMemory(overrides)`, `applyOverrides`, `flush()`, `drainErrors()`, `setDefaultThinkingLevel` — examples/sdk/10-settings.ts:12-46). Config dir `.pi` (package.json piConfig.configDir), default agent dir `~/.pi/agent` via `getAgentDir()` / `CONFIG_DIR_NAME` (index.d.ts:2). Env (docs/environment-variables.md:75-100): `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR` (overridden by `--session-dir`), `PI_PACKAGE_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, `PI_TELEMETRY`, `PI_CACHE_RETENTION`, `PI_CODEMODE_MAX_WORKERS`, `VISUAL/EDITOR`, `HTTP(S)_PROXY`; markers set by CLI/RPC entry: `AI_AGENT=pi`, `PI_CODING_AGENT=true` (NOT set by SDK embedding, :18); shell tools get `PI_SESSION_ID/PI_SESSION_FILE/PI_PROVIDER/PI_MODEL/PI_REASONING_LEVEL` (:24-33). Per-workspace: `cwd` in `CreateAgentSessionOptions` (sdk.d.ts:11-12), `agentDir` (:13), `RpcClientOptions.cwd/env` or CLI `--session-dir`/`-n` (sessions.md:50, rpc-commands.md:784).

## 8. LIFECYCLE & FAILURE

Startup: spawn → `start()` (100 ms liveness check); no session header record in RPC (json.md:29) — use `get_state`. `prompt` success = accepted/queued/handled only; `data.disposition:"handled"` → don't await `agent_settled` (rpc.md:60-67). Abort: `abort` command waits for idle (rpc-commands.md:96). Esc-style cancel: `clear_queue` then `abort`, restore returned text (:128). Shutdown: close child stdin → orderly dispose (rpc.md:91-93); `RpcClient.stop()` uses SIGTERM→SIGKILL. Unexpected exit: RpcClient rejects pending requests with exitError (js:53-66, 435-439); commands then throw until restart. In-process: `session.dispose()` aborts work + removes listeners (sdk.md:56); `runtime.dispose()` for `AgentSessionRuntime`. Restart must preserve: session file path/`sessionId` (re-pass via `--session`/`switch_session` or `SessionManager.open`), model+thinkingLevel (persisted as `model_change`/`thinking_level_change` entries), last entry id (`get_entries.leafId` as durable cursor, rpc-commands.md:691).

## 9. MINIMAL SKELETON (verified symbols)

```ts
import { RpcClient } from "@earendil-works/pi-coding-agent"; // index.d.ts:41
const client = new RpcClient({ cliPath: "/…/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
  cwd: workspaceFolder, args: ["--session-dir", sessionDir, "--name", "vsix"] });
const off = client.onEvent(e => {
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta")
    panel.appendText(e.assistantMessageEvent.delta);                       // rpc-client.d.ts:56, json.md:82
  if (e.type === "tool_execution_start") showToolCall(e.toolCallId, e.toolName, e.args);
  if (e.type === "agent_settled") markIdle(e.aborted);                    // agent-session.d.ts:53-55
});
await client.start();                                                     // rpc-client.d.ts:48
const state = await client.getState();                                    // :97
await client.setModel("anthropic", "claude-sonnet-4-20250514");           // :101
await client.setThinkingLevel("medium");                                  // :123
await client.prompt("Explain this repo");                                 // :66
await client.waitForIdle();                                               // :239 (or promptAndWait :247)
await client.compact("Focus on code changes");                            // :145
off(); await client.stop();                                               // :52
```
(For extension-UI dialogs, replace `RpcClient` with raw spawn + JSONL per `examples/rpc-extension-ui.ts:259-296, 540-544` and `docs/rpc.md:101-129`.)

## Gaps — `[NOT IN SDK DOCS]` (top 5)

1. **Extension UI responses through `RpcClient`**: no public method to send `extension_ui_response`; requests arrive as unrecognized `onEvent` records. Must use raw JSONL client. (rpc-client.d.ts has no such API; example hand-rolls spawn.)
2. **`RpcClient.stop()` closes stdin gracefully** — SIGTERM immediately; docs describe stdin-close shutdown (rpc.md:93) but RpcClient doesn't use it; ordering/flush guarantees of in-flight writes on SIGTERM are unspecified.
3. **JSON-schema validation of `RpcCommand`/`RpcResponse`**: only TS types + prose docs; no versioned schema file (schemas/ has only settings/models/keybindings/theme). Wire-compat across versions is `[NOT IN SDK DOCS]`.
4. **Event ordering guarantees between `get_entries` cursor and streamed events** (whether an event can precede the entry being visible to `get_entries since`) — unspecified.
5. **Per-workspace session-dir resolution rule** (`--session-dir` vs `sessionDir` setting vs env precedence is stated once in sessions.md:50 but the exact default-dir encoding of Windows drive letters and reuse across VS Code workspace reloads) is only partially documented (session-format.md:14).
Also: `docs/rpc-commands.md` documents no `navigate_tree`/`/tree` navigation command over RPC despite `AgentSession.navigateTree` existing in-process (agent-session.d.ts:869) `[NOT IN SDK DOCS]`.

Files I did **not** fully read before the cutoff (may still need checking when writing the doc): `docs/models.md`, `docs/providers.md`, `docs/compaction.md`, `docs/settings.md`, `docs/extensions.md`, `docs/skills.md` (only structure seen), `dist/core/settings-manager.d.ts`, `dist/core/compaction/*.d.ts` (CompactionResult fields taken from rpc-commands.md:381-404), `examples/sdk/03,04,05,06,07,08,14`.