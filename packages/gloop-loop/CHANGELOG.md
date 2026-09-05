# Changelog

All notable changes to `@hypen-space/gloop-loop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.3.0]

### Breaking
- **Event-sourced actor.** Every input, output, tool call, memory write, prompt change and lifecycle transition is appended to an `EventLog` (`agent.log`). Subscribers (`on`, `onEvent`, `nextEvent`, `attach`) now receive `LogEvent`s: the same payloads as before plus an envelope — `seq`, `eventId`, `ts`, `run`, `agent`, `turn`, `parent`. `turn_end` now carries `status: "ok" | "error" | "interrupted" | "fatal"`. Existing handlers keep working with two exceptions: `error.error` / `fatal.error` are typed `Error | ErrorInfo` (an `ErrorInfo` after a round-trip through a store), so code that relied on the `Error` type must narrow; and all subscribers (`onEvent`, `on`, `attach`) are now one mechanism — a handler that throws produces a `hook_error` event instead of being silently swallowed.
- An `AbortError` thrown inside a tool's `execute` now propagates and interrupts the turn instead of being reported as a failed tool result.
- **Spawned subagent results reach the model.** A spawn-classified call (`classifySpawn`) is now executed inside `evalInvoke` like any tool: visible as `tool_start` / `tool_done`, its result recorded as a native `tool_message`. Previously an all-spawn response echoed the result to the UI and sent the model an empty user turn. `toolCallsToForm` keeps its optional `classifySpawn` parameter for hosts with their own interpreter; its spawn chain now feeds results back as a synthetic user message instead of dropping them.
- `Effects` gains an optional `record(event)` callback and `toolStart` takes optional `args` / `callId`; the interpreter now owns every history write (via `AIConversation.append` + `request()`) instead of relying on the conversation's streaming wrapper. Hosts that implement `Effects` by hand are unaffected unless they relied on `convo.stream()` pushing history for them.
- `manageContextFork` takes an optional 4th `options` argument (`eventLog`, `id`, `onReplaced`).
- `AbortError` / `raceAbort` moved to `core/abort.ts` (still re-exported from the package root and `core/core.ts`).

### Added
- `EventLog` — append-only, ordered, subscribable log with pluggable `EventStore` persistence, `flush()`, load-time dedupe, and graph helpers (`get`, `ancestors`, `children`). `MemoryEventStore` and `createJsonlEventStore(path, { filter })` (one JSON line per event, corrupt lines skipped) are included; `isEphemeralEvent` identifies the progress-only events a store may drop.
- New events: `message_queued`, `user_message`, `assistant_message`, `assistant_tool_calls`, `tool_message`, `history_replaced`, `history_cleared`, `system_set`, `tools_changed`, `llm_request`, `llm_response`, `llm_error`, `retry`, `confirm_response`, `ask_response`, `spawn_start`, `spawn_done`, `hook_error`, `restored`. `tool_start` now includes `args` and the provider `callId`.
- `projectState(events, agent?)` / `reduce` — a pure reducer that rebuilds `history`, `system`, `memory`, `tools`, `inbox`, `turns`, pending confirm/ask requests, and a `committedHistory` at the last turn boundary. `agent.snapshot()` is the convenience form.
- `AgentLoop.resume({ store, ... })` and `agent.hydrate(events?, { requeue, history })` — rebuild an actor from a log. The host owns the system prompt and tools on resume; history and queued work come from the log. A turn cut off by a crash is rolled back to the last turn boundary, closed as `abandoned`, and re-queued together with anything still in the inbox. `sendSync` settles only after the turn's events are handed to the store; `stop()` flushes.
- `agent.attach(hook)` / `hooks` option — observe the log without ever breaking the loop (failures become `hook_error` events); `scope: "all"` sees every agent on a shared log. `bridgeAgents(from, to, { on, map })` routes one agent's events into another's inbox with `cause: { agent, eventId }` recorded for cross-agent causality.
- `eventLog` option to share one log between agents; the context-manager fork now logs into the parent's log as `${id}/context`.
- `retry` option (`{ llm?, tool? }`) with `withRetry` / `RetryPolicy` — exponential backoff, `retryIf`, abort-aware, every attempt logged as a `retry` event. An LLM call is never retried after it has streamed output; tools are retried only when they declare `retryable: true`.
- `agent.setHistory(messages, reason)` (logged), `agent.id`, `agent.log`, `agent.flush()`, `AIConversation.request()` / `append()` / `getSystem()`.
- **Cross-agent graph.** `send(message, { cause })` links a message to the event it reacts to (any `LogEvent`, or an `EventRef` with a `log` locator). `EventLog.ancestors` / `children` follow `message.cause` as well as `parent`, `descendants(eventId)` collects everything an event led to, and `causeOf(event)` exposes the single step. Fan-out from one event to several agents is several `message_queued` children. `projectGraph(events)` turns a (possibly multi-log) event list into `{ agents, nodes (turn attempts), edges (messages with their causing turn/event), roots }` — nodes come from `projectState` per agent, so re-runs after a restore appear as separate attempts (`agent:msg_1`, `agent:msg_1#2`); `graphToMermaid` renders it; `mergeEvents` joins several logs. Inbox events (`message_queued`, `queue_changed`) and `hook_error` are logged outside the running turn so a message typed mid-turn is never claimed as caused by it.
- `parseJsonlEvents` is the single definition of a valid persisted line (used by the JSONL store and the viewer). `createJsonlEventStore().load()` treats only a missing file as empty; other read errors surface. A failed `EventLog.load()` can be retried.
- `@hypen-space/gloop-loop/testing` — `ScriptedProvider` and small tool doubles for driving an agent without a model.
- `AgentLoop.resume` throws when the log belongs to a different agent id, and only emits `restored` when there was something to restore. `hydrate()` throws once the agent has started. `stop()` rejects `sendSync` promises whose message never got a turn. `awaitIdle()` no longer resolves early between dequeue and `turn_start`.
- Interceptor rewrites of the LLM input are logged (`history_replaced`, reason `interceptor_rewrite`) so replay stays exact.
- `@hypen-space/gloop-loop/replay` — a second package entry exporting only the pure, dependency-free parts (events, `EventLog` / `MemoryEventStore`, `projectState` / `reduce`, `projectGraph` / `linkedLogs` / `graphToMermaid`) for viewers and analysers; bundles for the browser as-is.
- **Spawned subagents link their logs.** The `spawn` option/effect now receives `(task, { cause })` where `cause` references the `spawn_start` event; `SpawnResult` may return `agent` / `log`, which `spawn_done` records as `child`. `EventRef.log` names the other log's locator. `linkedLogs(events)` lists referenced child/parent logs; concatenating their events lets `projectGraph` and `ancestors` cross the process boundary.

### Fixed
- `confirm_request` / `ask_request` are now emitted after the resolver is registered, so a handler that answers synchronously from inside the event no longer hangs the turn.

## [0.2.0]

### Breaking
- **Native tool-call conversation history.** Tool results are no longer fed back to the model as a synthetic `role: "user"` message wrapped in `<tool_result>` XML. When the provider supplies tool call ids, the assistant's tool calls are recorded on the assistant message (`Message.toolCalls`) and each result is recorded as a `role: "tool"` message keyed by `toolCallId` — the OpenAI-compatible wire format. This fixes two long-standing failure modes: the model "forgetting" it acted after a tools-only turn (and repeating the call), and tool output degrading the model's voice by appearing user-authored. Calls without provider ids still use the legacy user-message path.
- `Message` gains `toolCalls?: JsonToolCall[]` (assistant) and `toolCallId?: string` (tool role); `MessageRole` adds `"tool"`. Hosts that render or persist history should handle the new role.
- The `think` form's `input` is now `string | null` — `null` (built via the new `Continue()` constructor) streams a continuation from history without appending a user message.

### Added
- `ToolCall.id` / `ToolResult.id` — provider tool call ids are preserved through parsing and execution so results can be correlated natively.
- `AIConversation.streamContinue()` — stream from the current history without pushing a new user message.
- `LoopConfig.maxIterations` / `AgentLoopOptions.maxIterations` — opt-in cap on LLM calls per turn; exceeding it fails the turn with `MaxIterationsError` instead of spinning forever. Disabled by default.
- `LoopConfig.llmIdleTimeoutMs` / `AgentLoopOptions.llmIdleTimeoutMs` — idle timeout for a single LLM stream (default 120 s, 0 disables); a provider that stops producing chunks now fails the turn with `LlmIdleTimeoutError` instead of hanging the whole request.
- Context pruning is tool-call-group aware: deleting an assistant `toolCalls` message also deletes its `role: "tool"` responses (and vice versa) so pruning can never produce a history the provider rejects.

### Fixed
- Tool arguments are mapped **by key name** against the tool's declared argument list — never positionally. (The `Object.values()` positional mapping shipped in 0.1.2 scrambled arguments whenever the model emitted keys out of order or omitted one; 0.1.3+ sources already mapped by name, and 0.2.0 also preserves call ids.) Downstream workarounds that rebuilt argument JSON at the provider boundary are no longer needed.

## [0.1.4]

### Added
- `Patch_file` normalizes miscounted hunk headers before calling `parsePatch`. LLMs commonly conflate "lines 1..5 of the file" with "5 hunk body lines" and emit `@@ -1,5 +1,5 @@` for a 4-line body; the new `normalizeHunkCounts` helper recounts the body and rewrites the header so the diff library no longer rejects the patch.
- `StreamResult.finishReason: Promise<FinishReason>` and `LlmCallResult.finishReason`. The real `finish_reason` from streaming chunks and the non-streaming `complete()` path is now read from the API rather than inferred from tool-call presence. Logged as a span attribute on `ai.stream`, so `debug.log` can distinguish `stop` / `length` / `content_filter` / `tool_calls`.
- Skill helpers re-exported for downstream consumers: `parseSkillMarkdown`, `findSkill`, `mergeSkillsIntoSystem`, `formatSkillsListing`, `applySkillSubstitutions`, `splitSkillArguments`, `matchSkillSlash`, `createInvokeSkillTool`, plus the `Skill` type.

### Changed
- `OpenRouterProvider.complete()` reads `choice.finishReason` from the response when present; the previous synthesized value remains only as a fallback when the API omits it.
- `OpenRouterProvider.stream()` keeps the latest non-null `finishReason` seen across chunks and resolves it once the stream terminates.

## [0.1.3]

### Breaking
- Gloop loop has improved DX for looping agent runs. Check README.md for new DX updates.
- Default tool call pruning set to 0 tool calls
- Max tokens by default set to 256k
- Remove hard memory file dependency

## [0.1.2] — prior

See git history (`packages/gloop-loop` commits up to `2da381d`) for pre-changelog development.
