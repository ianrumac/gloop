# @hypen-space/gloop-loop

A recursive, actor-style, **event-sourced** agent loop for LLMs. Every input, output, tool call and memory write is an event in an append-only log; the agent's state is a fold over that log, so it can be persisted, replayed, resumed after a crash, inspected as a causal graph, and hooked by other agents. Typed events, chainable builder, batteries-included for Node/Bun, portable to the browser.

## Install

```bash
bun add @hypen-space/gloop-loop
# or: npm install / pnpm add
```

You also need an `OPENROUTER_API_KEY` in the environment.

## Quick start — a deploy bot with 3 tools

```ts
import { AgentLoop, OpenRouterProvider } from "@hypen-space/gloop-loop";

const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY! }),
  model: "anthropic/claude-sonnet-4.5",
  system: "You are a deploy bot. Use the tools to help the user.",

  tools: [
    {
      name: "ListEnvironments",
      description: "List all deployment environments.",
      arguments: [],
      execute: async () => "staging, prod, canary",
    },
    {
      name: "GetStatus",
      description: "Get the current deployment status of an environment.",
      arguments: [{ name: "env", description: "Environment name" }],
      execute: async (args) => `${args.env}: healthy, 3 instances`,
    },
    {
      name: "Deploy",
      description: "Deploy the current build to an environment.",
      arguments: [
        { name: "env", description: "Target environment" },
        { name: "version", description: "Version tag" },
      ],
      askPermission: (args) => `Deploy ${args.version} to ${args.env}?`,
      execute: async (args) => `Deployed ${args.version} to ${args.env}`,
    },
  ],

  confirm: async () => true, // auto-approve for a script; drop for TUIs
});

agent
  .on("stream_chunk",   (e) => process.stdout.write(e.text))
  .on("tool_start",     (e) => console.log(`  → ${e.name}(${e.preview})`))
  .on("tool_done",      (e) => console.log(`  ${e.ok ? "✓" : "✗"} ${e.name}`))
  .on("task_complete",  (e) => console.log(`\n[done] ${e.summary}`));

await agent.sendSync("deploy v2.1.0 to staging and tell me the status");
await agent.stop();
```

Everything you need to know:

- **`ToolDefinition`** is a plain object. No decorators, no Zod, no codegen.
- **`askPermission`** returns a string → agent pauses, UI confirms, then runs. Returns `null` → just runs.
- **`agent.on(type, handler)`** — handler is type-narrowed, no `switch`, no casts.
- **`sendSync(msg)`** auto-starts the loop, runs one turn, resolves/rejects when that turn finishes.

If you don't pass `tools`, you get the full built-in set — `ReadFile`, `WriteFile`, `Patch_file`, `Bash`, `AskUser`, `Remember`, `Forget`, `ManageContext`, `CompleteTask` — for free.

### Skills (Agent Skills / `SKILL.md`)

Skills are markdown playbooks discovered by **your app** (the library does not read the filesystem for them). You pass an array of **`Skill`** objects (`name`, `description`, `dir`, `body` — usually from parsing each `<dir>/SKILL.md`).

**Agent DX**

- Pass **`skills?: Skill[]`** on **`AgentLoop`**. Names and descriptions are merged into the system prompt so the model knows what exists; the full body is not inlined until invoked.
- Optionally register **`createInvokeSkillTool(skills)`** so the model can call **`InvokeSkill(name, arguments)`** and receive the same rendered text as a slash invocation.
- **`refreshSystem`** should return a base prompt string; the loop re-applies the skills block automatically when refreshing.

**REPL / `run()` DX** (when `LoopConfig.skills` is set — `AgentLoop` wires this for you)

| Input | Effect |
| --- | --- |
| `/skills` | Print a short list of skills (names + descriptions). |
| `/skill <name> [args]` | Load that skill’s body with `$ARGUMENTS` / `$0`… substitutions (same as `/<name> [args]`). |
| `/<name> [args]` | Same as above when `name` matches a skill (takes precedence over `/install` if a skill collides). |
| Plain text | Normal user turn. |

Helpers (all exportable from the package): **`parseSkillMarkdown`**, **`mergeSkillsIntoSystem`**, **`formatSkillsListing`**, **`findSkill`**, **`applySkillSubstitutions`**, **`thinkInputFromSkillSubcommand`**, **`matchSkillSlash`**, **`skillInvocationToThinkInput`**, **`createInvokeSkillTool`**.

**Gloop CLI** (downstream) discovers `SKILL.md` under `.claude/skills`, `.agent/skills`, and `.gloop/skills` by default and passes the result into the loop + builtins.

## Features

### Three shapes for driving the loop

**Script — one message, await it:**

```ts
await agent.sendSync("do the thing");
await agent.stop();
```

**Pipeline — stage messages then go:**

```ts
agent.send("read the spec").send("write the code").send("run the tests").start();
await agent.awaitIdle();   // all three turns done
await agent.stop();
```

`send()` deliberately does **not** auto-start so you can stage a batch.

**Interactive — event stream drives the UI:**

```ts
const agent = new AgentLoop({ provider, model, system, tools })
  .on("stream_chunk",    (e) => ui.appendStream(e.text))
  .on("tool_start",      (e) => ui.showTool(e.id, e.name, e.preview))
  .on("tool_done",       (e) => ui.finishTool(e.id, e.ok, e.output))
  .on("confirm_request", (e) => ui.openConfirm(e.id, e.command))
  .on("ask_request",     (e) => ui.openAsk(e.id, e.question))
  .start();

onUserSubmit = (text)       => agent.send(text);
onEscape     = ()           => agent.interrupt();
onConfirm    = (id, ok)     => agent.respondToConfirm(id, ok);
onAsk        = (id, answer) => agent.respondToAsk(id, answer);
```

### Typed events with no `switch` ladder

```ts
import { type StreamChunkEvent, type ToolDoneEvent } from "@hypen-space/gloop-loop";

const logChunk = (e: StreamChunkEvent) => process.stdout.write(e.text);
const logTool  = (e: ToolDoneEvent)    => log({ tool: e.name, ok: e.ok });

agent.on("stream_chunk", logChunk).on("tool_done", logTool);
```

A per-variant alias is exported for every event (`TurnStartEvent`, `ToolDoneEvent`, `LlmResponseEvent`, `RestoredEvent`, …), plus `LogEvent<"tool_done">` when you want the envelope included.

One-shot promise helper for "wait for next X":

```ts
const done = await agent.nextEvent("task_complete");
console.log(done.summary);   // typed as string

const bashOk = await agent.nextEvent((e) =>
  e.type === "tool_done" && e.name === "Bash" && e.ok,
);
```

### Four ways to set the system prompt

| When | Use |
|---|---|
| At startup | Constructor `system` option |
| Immediately, right now | `agent.setSystem(prompt)` — chainable |
| Between queued messages (inbox-ordered) | `agent.send({ role: "system", content: prompt })` |
| Rebuild from external state | `refreshSystem: async () => buildPrompt()` option |

Why four? Because "change the prompt between message A and message B" and "change the prompt immediately" are different operations. `setSystem` is immediate and races with the inbox; `send({role: "system", ...})` slots into the inbox at a precise position:

```ts
agent
  .send("list the files")                              // original prompt
  .send({ role: "system", content: "now be harsh" })   // swaps mid-pipeline
  .send("review the first one")                        // new prompt
  .start();
```

### Mutating the tool set between turns

All chainable, all take effect on the next turn:

```ts
agent.addTool(newTool);          // add one
agent.removeTool("OldTool");     // remove one
agent.setTools([...newTools]);   // replace everything atomically
```

The loop re-reads the registry before each LLM call, so changes land immediately on the next turn.

### File-backed memory (opt-in)

**The default is no-op** — the library never writes to disk unless you ask. To opt in:

```ts
import { createFileMemory } from "@hypen-space/gloop-loop";

const memory = createFileMemory();                   // .gloop/memory.md in cwd
const memory = createFileMemory({ dir: ".notes" });  // .notes/memory.md
const memory = createFileMemory({
  dir: ".notes",
  file: "agent.md",
  maxEntryLength: 1000,
});

const agent = new AgentLoop({
  provider, model,
  remember: memory.remember,
  forget:   memory.forget,
});

// Read the current contents anywhere:
const notes = await memory.read();
```

`createFileMemory` returns `{ remember, forget, read }` — closures captured over the config. **Two instances with different `dir`s are fully independent.** Entries longer than `maxEntryLength` are collapsed to a single line and truncated with `[truncated] ...` so the file stays tidy.

If you don't opt in, the `memory` event still fires so your UI can react — but nothing hits disk. Bring your own persistence:

```ts
remember: async (content) => db.insert("memories", { content }),
forget:   async (content) => db.delete("memories", { content }),
```

### Event sourcing — the log is the state

Everything the actor does goes through `agent.log`, an append-only `EventLog`. Each event is the payload you already know (`tool_done`, `stream_chunk`, …) plus an envelope:

```ts
{
  type: "tool_done", id: "tool_3", name: "Bash", ok: true, output: "ok",
  seq: 41,               // position in the log
  eventId: "k3f9a1-41",  // unique: `${run}-${seq}`
  ts: 1757062800123,
  run: "k3f9a1",         // this process / EventLog instance
  agent: "agent",        // which agent (logs can be shared)
  turn: "msg_2",         // the message whose turn produced it, or null
  parent: "k3f9a1-38",   // causal edge → the log is a graph
}
```

Besides the UI events, the log records every state change: `message_queued`, `user_message`, `assistant_message`, `tool_message`, `history_replaced`, `history_cleared`, `system_set`, `tools_changed`, `memory`, `llm_request` / `llm_response` / `llm_error`, `confirm_response` / `ask_response`, `spawn_start` / `spawn_done`, `retry`, `hook_error`, `restored`, and `turn_end` now carries a `status`.

**Rebuild state from the log:**

```ts
const state = agent.snapshot();     // projectState(agent.log.events(), agent.id)
state.history                        // === agent.convo.getHistory()
state.system, state.memory, state.tools
state.turns                          // [{ id, message, status, llmCalls, toolCalls, summary }]
state.inbox, state.currentTurn       // work queued / in flight
state.committedHistory               // history as of the last turn boundary
```

`projectState` is a pure reducer (`reduce(state, event)`), exported so you can fold any slice of events yourself.

**Persist and resume:**

```ts
import { AgentLoop, createJsonlEventStore, isEphemeralEvent } from "@hypen-space/gloop-loop";

const store = createJsonlEventStore(".gloop/session.jsonl", {
  filter: (e) => !isEphemeralEvent(e),   // skip stream_chunk / busy / idle / queue_changed
});

const agent = await AgentLoop.resume({ provider, model, system, tools, store });
agent.start();
```

`resume` loads the store, replays it into the conversation, and keeps appending to it. If the previous process died mid-turn, the half-finished turn's writes are rolled back to the last `turn_end` (a `committedHistory`), the turn is closed as `abandoned`, and its message — plus anything still in the inbox — is re-queued so it simply runs again. Pass `history: "latest"` to keep the partial writes instead, or `requeue: false` to only restore.

A `sendSync` promise settles only after that turn's events have been handed to the store, and `stop()` flushes before returning. Store failures never stop the agent (`onStoreError` on `EventLog` sees them).

Bring your own store — two methods:

```ts
const store: EventStore = {
  append: (e) => db.insert("events", e),      // called in order, awaited
  load:   () => db.select("events").orderBy("seq"),
};
```

`MemoryEventStore` is included for tests. Share one log between agents with `eventLog: sharedLog` so a parent and the sub-agents it forks (the context manager runs as `${id}/context`) end up in one graph; `projectState(events, agentId)` picks one agent back out.

**Walk the graph:**

```ts
agent.log.get(eventId)
agent.log.ancestors(eventId)   // follow `parent` back to the message that caused it
agent.log.children(eventId)    // e.g. every stream_chunk of an llm_request
```

Within a turn each event's `parent` is the previous event (a causal chain); pairs point at each other explicitly (`tool_done → tool_start`, `llm_response → llm_request`, `confirm_response → confirm_request`), `turn_start → message_queued`, and a message sent by `bridgeAgents` carries `cause: { agent, eventId }` pointing into the other agent's log.

### Hooks — attach behaviour (and other agents)

Interceptors sit *in* the call path and can rewrite, short-circuit or retry a boundary. Hooks sit *on the log*: they see every event after it happened, may be async, and can never break the loop — a throw or rejection becomes a `hook_error` event.

```ts
const detach = agent.attach({
  name: "audit",
  types: ["tool_done", "task_complete"],   // default: all
  scope: "self",                           // "all" = every agent on a shared log
  handle: async (event, agent) => { await audit.write(event); },
});
```

Wire two agents together through the log:

```ts
import { bridgeAgents } from "@hypen-space/gloop-loop";

// Whenever the coder completes a task, the reviewer gets a message
// whose `cause` points at the coder's task_complete event.
bridgeAgents(coder, reviewer, {
  on: "task_complete",
  map: (e) => `Review this work: ${e.summary}`,   // return null to skip
});
```

`hooks: [...]` in the constructor attaches at build time.

### Retry — safe, opt-in, logged

```ts
const agent = new AgentLoop({
  provider, model,
  retry: {
    llm:  { attempts: 3, backoffMs: 500, maxBackoffMs: 10_000 },
    tool: { attempts: 2 },   // only tools that declare `retryable: true`
  },
});
```

Every retry is a `retry` event (`boundary`, `attempt`, `delayMs`, `error`). An LLM call is never retried once it has streamed output (that would duplicate text), and an `AbortError` is never retried. `retryIf(error, attempt)` narrows further. Retry is off unless you pass a policy.

### Fatal errors and process-level restart (reboot pattern)

Some errors mean the host should tear down and restart the whole process (e.g. a self-modifying agent that has updated its own code and needs to reload). Classify them:

```ts
class RebootError extends Error {
  constructor(public readonly reason: string) {
    super(`Reboot: ${reason}`);
    this.name = "RebootError";
  }
}

const agent = new AgentLoop({
  provider, model, system, tools,
  isFatal: (err) => err instanceof RebootError,
});

agent.on("fatal", async (e) => {
  await saveState();
  await agent.stop();
  process.exit(75);   // let your launcher respawn
});
```

When `isFatal` returns `true`, the actor:

1. Stops the loop (no more turns)
2. Clears the inbox
3. Emits `fatal` **instead of** `error`
4. `sendSync` rejects with the fatal error

Non-fatal errors keep the loop alive — the next queued message is processed normally. This is the difference between "the current turn failed" and "the whole agent needs to die".

### Cancellation

```ts
const pending = agent.sendSync("Refactor the whole codebase");

// Later — user hits escape:
agent.interrupt();

try {
  await pending;
} catch (err) {
  if (err.name === "AbortError") console.log("Interrupted");
}

// Loop is still alive — keep sending:
await agent.sendSync("Never mind, just a small refactor");
```

`interrupt()` aborts the current turn; the loop keeps running. To tear everything down: `await agent.stop()`.

### Custom tools with permission prompts

```ts
agent.addTool({
  name: "Deploy",
  description: "Deploy to a target environment.",
  arguments: [{ name: "env", description: "Target env" }],
  askPermission: (args) => `Deploy to ${args.env}?`,
  execute: async (args) => `Deployed to ${args.env}`,
});
```

`askPermission` returning a string makes the loop emit a `confirm_request` event (or call your `confirm` option if you passed one). The tool's `execute` only runs after the user answers yes via `agent.respondToConfirm(id, ok)`.

### Common one-liners

| I want to… | Code |
|---|---|
| Subscribe to everything | `agent.onEvent((e) => {...})` |
| Subscribe to one event type (narrowed) | `agent.on("tool_done", (e) => ...)` |
| Unsubscribe | `agent.off("tool_done", handler)` or `agent.offEvent(listener)` |
| Wait for a specific event | `await agent.nextEvent("task_complete")` |
| Wait for the inbox to drain | `await agent.awaitIdle()` |
| Send and wait for THIS turn to finish | `await agent.sendSync(msg)` |
| Send and forget | `agent.send(msg)` |
| Interrupt current turn | `agent.interrupt()` |
| Stop everything | `await agent.stop()` |
| Reset conversation | `agent.clear()` |
| Change system prompt now | `agent.setSystem(prompt)` |
| Change system prompt inbox-ordered | `agent.send({ role: "system", content: prompt })` |
| Pin to one OpenRouter provider | `agent.convo.setProviderRouting({ only: ["anthropic"] })` |
| Get conversation history | `agent.convo.getHistory()` |
| Restore conversation history | `agent.setHistory([...])` (logged) |
| Rebuild state from the log | `agent.snapshot()` |
| Persist / resume a session | `AgentLoop.resume({ ..., store })` |
| Wait until the log is durable | `await agent.flush()` |
| Attach a hook / another agent | `agent.attach(hook)`, `bridgeAgents(a, b, {...})` |
| Read the raw log | `agent.log.events()` |

### Built-in tools (when you don't pass `tools`)

| Tool | Does |
|---|---|
| `ReadFile` | Read a file |
| `WriteFile` | Write literal content to a file (with safety checks) |
| `Patch_file` | Apply a unified-diff patch |
| `Bash` | Run a shell command |
| `AskUser` | Prompt the user |
| `Remember` / `Forget` | Call your memory callbacks |
| `ManageContext` | Prune conversation history when it gets long |
| `CompleteTask` | Signal task completion with a summary |

### Browser / custom IO

`primitiveTools()` uses `node:fs` and `node:child_process`. Pass your own:

```ts
const agent = new AgentLoop({
  provider, model, system,
  io: {
    readFile:   async (path) => fetch(`/api/read?p=${path}`).then((r) => r.text()),
    fileExists: async (path) => true,
    writeFile:  async (path, content) => { /* POST to server */ },
    exec:       async (command) => ({ stdout: "", stderr: "no shell here", exitCode: 1 }),
  },
});
```

A complete browser example lives in `examples/browser.html`.

## API Reference

### AgentLoop

| Method | Returns | Chainable | Auto-starts |
|---|---|---|---|
| `new AgentLoop(opts)` | `AgentLoop` | — | no |
| `.start()` | `this` | ✓ | (is the start) |
| `.stop()` | `Promise<void>` | — | — |
| `.send(msg)` | `this` | ✓ | **no** |
| `.sendSync(msg)` | `Promise<void>` | — | **yes** |
| `.interrupt()` | `this` | ✓ | — |
| `.awaitIdle()` | `Promise<void>` | — | — |
| `.nextEvent(type \| filter)` | `Promise<event>` | — | — |
| `.on(type, handler)` | `this` | ✓ | — |
| `.off(type, handler)` | `this` | ✓ | — |
| `.onEvent(listener)` | `this` | ✓ | — |
| `.offEvent(listener)` | `this` | ✓ | — |
| `.addTool(tool)` | `this` | ✓ | — |
| `.removeTool(name)` | `this` | ✓ | — |
| `.setTools(tools)` | `this` | ✓ | — |
| `.setSystem(prompt)` | `this` | ✓ | — |
| `.clear()` | `this` | ✓ | — |
| `.respondToConfirm(id, ok)` | `this` | ✓ | — |
| `.respondToAsk(id, answer)` | `this` | ✓ | — |
| `.setHistory(messages, reason?)` | `this` | ✓ | — |
| `.attach(hook)` | `() => void` (detach) | — | — |
| `.snapshot()` | `AgentState` | — | — |
| `.hydrate(events?, opts?)` | `AgentState` | — | — |
| `.flush()` | `Promise<void>` | — | — |
| `AgentLoop.resume(opts)` | `Promise<AgentLoop>` | — | no |
| `.isRunning()` | `boolean` | — | — |
| `.pending()` | `number` | — | — |

Readable state: `agent.id`, `agent.log`, `agent.convo`, `agent.registry`, `agent.world`.

### AgentEvent

Discriminated union on `.type`. Every delivered event also carries the envelope (`seq`, `eventId`, `ts`, `run`, `agent`, `turn`, `parent`) — the `LogEvent` type.

| Type | Payload | When |
|---|---|---|
| `message_queued` | `{ message }` | A message entered the inbox |
| `turn_start` | `{ message }` | About to process a message |
| `turn_end` | `{ status }` | Turn finished: `ok` / `error` / `interrupted` / `fatal` |
| `busy` / `idle` | — | Loop state |
| `queue_changed` | `{ pending }` | Inbox size changed |
| `stream_chunk` | `{ text }` | Assistant text chunk |
| `stream_done` | — | Stream finished (tools may follow) |
| `tool_start` | `{ id, name, preview }` | Tool invocation started |
| `tool_done` | `{ id, name, ok, output }` | Tool invocation finished |
| `user_message` | `{ content }` | A user message was appended to history |
| `assistant_message` | `{ content, toolCalls?, partial? }` | An assistant message was appended / completed |
| `tool_message` | `{ toolCallId, content }` | A native tool response was appended |
| `history_replaced` | `{ history, reason }` | History replaced (context prune, `setHistory`) |
| `history_cleared` | — | `clear()` |
| `system_set` | `{ system }` | System prompt changed |
| `tools_changed` | `{ names }` | Tool set changed |
| `llm_request` | `{ model, input, historyLength, toolCount }` | About to call the model |
| `llm_response` | `{ text, toolCalls, finishReason }` | Model responded |
| `llm_error` | `{ error, attempt }` | Model call failed |
| `retry` | `{ boundary, name?, attempt, maxAttempts, delayMs, error }` | A boundary will be retried |
| `memory` | `{ op, content }` | Agent called Remember / Forget |
| `system_refreshed` | — | System prompt was updated |
| `confirm_response` | `{ id, ok }` | A confirmation was answered |
| `ask_response` | `{ id, answer }` | A question was answered |
| `spawn_start` / `spawn_done` | `{ task }` / `{ ok, exitCode, summary }` | Subagent lifecycle |
| `hook_error` | `{ hook, eventType, error }` | An attached hook threw |
| `restored` | `{ fromSeq, turns, requeued, history, system? }` | State rebuilt from the log |
| `task_complete` | `{ summary }` | `CompleteTask` was called |
| `interrupted` | — | Current turn aborted |
| `error` | `{ error: Error }` | Turn failed (non-fatal) |
| `fatal` | `{ error: Error }` | Turn failed; loop has stopped itself |
| `confirm_request` | `{ id, command }` | Answer with `respondToConfirm` |
| `ask_request` | `{ id, question }` | Answer with `respondToAsk` |

### Options

| Option | Default | Purpose |
|---|---|---|
| `provider` | **required** | `AIProvider` (e.g. `new OpenRouterProvider({apiKey})`) |
| `model` | **required** | Model id (e.g. `"anthropic/claude-sonnet-4.5"`) |
| `system` | — | Initial system prompt |
| `skills` | — | `Skill[]` — merged into system prompt; powers `/…` parsing and should pair with `createInvokeSkillTool` if you want **`InvokeSkill`** |
| `tools` | `primitiveTools()` | Tool set |
| `io` | `createNodeIO()` | Custom fs/shell adapter for `primitiveTools()` |
| `confirm` | emit `confirm_request` event | Direct answer to a permission prompt |
| `ask` | emit `ask_request` event | Direct answer to a free-form question |
| `remember` | no-op | Persistence for the Remember tool |
| `forget` | no-op | Persistence for the Forget tool |
| `refreshSystem` | no-op | Rebuild the system prompt on request |
| `installTool` | not available stub | Runtime tool install |
| `listTools` | registry names | Human-readable tool list |
| `spawn` | not configured stub | Delegate to a subagent process |
| `isFatal` | — | Classify an error as fatal (stops the loop) |
| `id` | `"agent"` | Agent id stamped on every event |
| `store` | — | `EventStore` to persist the log (see `createJsonlEventStore`) |
| `eventLog` | fresh `EventLog` | Share a log with other agents |
| `hooks` | — | `AgentHook[]` attached at construction |
| `retry` | off | `{ llm?, tool? }` retry policies |
| `contextPruneInterval` | 50 | Tool-call count between auto-prunes |
| `classifySpawn` | — | Classify tool calls as spawn tasks |
| `log` | — | Debug logger |

### Other exports

- **Providers**: `OpenRouterProvider`, `AI`, `AIBuilder`, `AIConversation`
- **Tools**: `ToolDefinition`, `ToolCall`, `ToolResult`, `ToolRegistry`, `primitiveTools`, `registerBuiltins`
- **Memory**: `createFileMemory`, `FileMemory`, `FileMemoryOptions`, `appendMemory`, `removeMemory`, `readMemory`
- **Event sourcing**: `EventLog`, `MemoryEventStore`, `createJsonlEventStore`, `EventStore`, `LogEvent`, `EventEnvelope`, `isEphemeralEvent`, `serializeEvent`, `toErrorInfo`
- **State**: `projectState`, `reduce`, `initialState`, `messagesToRequeue`, `AgentState`, `TurnRecord`
- **Hooks**: `AgentHook`, `bridgeAgents`, `HookTarget`
- **Retry**: `withRetry`, `RetryPolicy`, `RetryConfig`, `backoffDelay`, `defaultRetryIf`
- **Errors**: `AbortError`
- **Skills**: `Skill`, `parseSkillMarkdown`, `mergeSkillsIntoSystem`, `formatSkillsListing`, `findSkill`, `applySkillSubstitutions`, `thinkInputFromSkillSubcommand`, `matchSkillSlash`, `skillInvocationToThinkInput`, `createInvokeSkillTool`, `ParsedSkillMarkdown`, `SkillSlashMatch`
- **Low-level interpreter** (advanced): `run`, `eval_`, `mkWorld`, Form constructors (`Think`, `Invoke`, `Done`, ...), `Effects`, `World`, `LoopConfig` (includes optional `skills` for `parseInput`)

## Runtime compatibility

- **Bun** and **Node.js ≥ 18**
- Core loop and AI layer are portable (no Node APIs)
- Primitive tools use `node:fs` + `node:child_process` — override `io` for other runtimes

## License

MIT
