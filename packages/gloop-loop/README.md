# @hypen-space/gloop-loop

A drop-in, **actor-style** LLM agent loop with OpenRouter support and a typed, chainable builder API. Ships with batteries-included defaults for Node/Bun and is portable enough to run in the browser.

## What is this?

`gloop-loop` models an LLM agent as a long-running **actor** with an inbox, a typed event stream, and a fluent builder surface:

- **Inbox + lifecycle.** You `start()` the loop once; it processes messages from its inbox until you `stop()` it. Turns can be interrupted without tearing the loop down.
- **Typed event stream.** Every observable thing the loop does — streamed tokens, tool starts/dones, memory writes, confirm prompts, errors — is emitted as a discriminated-union event. Subscribe per-event-type with narrowed handlers, or take the firehose.
- **Chainable builder.** Every mutator returns `this`, so configuration, subscription, tool registration, and message staging compose in a single fluent chain.

Under the actor sits a small (~2K LOC) recursive-interpreter kernel over **Forms** (pure data values describing the next action). You can drop down to it if you need to build custom loops, but the vast majority of users should never need to.

## Installation

```bash
bun add @hypen-space/gloop-loop
# or
npm install @hypen-space/gloop-loop
# or
pnpm add @hypen-space/gloop-loop
```

## Quick Start

Three shapes cover 90% of use cases.

### 1. Script — one message, wait for it to finish

```ts
import { AgentLoop, OpenRouterProvider } from "@hypen-space/gloop-loop";

const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY! }),
  model: "anthropic/claude-sonnet-4.5",
  system: "You are a helpful assistant.",
});

agent.on("stream_chunk", (e) => process.stdout.write(e.text));

await agent.sendSync("What files are in the current directory?");
await agent.stop();
```

`sendSync` auto-starts the loop, enqueues the message, and resolves when *that specific message*'s turn finishes. With no `tools` passed, the agent gets all built-in tools (file I/O, shell, memory, context management) out of the box.

### 2. Pipeline — prepare then run

```ts
const agent = new AgentLoop({ provider, model, system });

agent
  .on("tool_done", (e) => console.log(e.ok ? "✓" : "✗", e.name))
  .on("task_complete", (e) => console.log("done:", e.summary))
  .send("read the spec")
  .send("write the code")
  .send("run the tests")
  .start();          // now processing begins

await agent.awaitIdle();   // all three turns finished
await agent.stop();
```

`.send()` stages messages in the inbox without starting the loop — you can queue as many as you like, then call `.start()` to kick off processing. `awaitIdle()` resolves when the inbox is drained *and* no turn is in flight.

You can also slot a **system-prompt change** into the pipeline at a precise position. A message with `role: "system"` updates the conversation's system prompt when the loop picks it up — without calling the LLM — so user messages queued *before* it run under the original prompt and messages queued *after* it run under the new one:

```ts
agent
  .send("list the files")                           // runs under "be concise"
  .send({ role: "system", content: "now be harsh" })// updates the prompt
  .send("review the first one")                     // runs under "now be harsh"
  .start();
```

Unlike `agent.setSystem(prompt)` — which is immediate and races with whatever is already in the inbox — a system message is inbox-ordered.

### 3. Interactive — event stream drives the UI

```ts
const agent = new AgentLoop({ provider, model, system })
  .on("stream_chunk",    (e) => ui.appendStream(e.text))
  .on("tool_start",      (e) => ui.showTool(e.id, e.name, e.preview))
  .on("tool_done",       (e) => ui.finishTool(e.id, e.ok, e.output))
  .on("confirm_request", (e) => ui.openConfirm(e.id, e.command))
  .on("ask_request",     (e) => ui.openAsk(e.id, e.question))
  .on("error",           (e) => ui.showError(e.error.message))   // e.error is Error
  .start();

// ...later, from your input handler / dialog callbacks:
function onUserSubmit(text: string)        { agent.send(text); }
function onEscape()                        { agent.interrupt(); }
function onConfirmAnswered(id: string, ok: boolean)     { agent.respondToConfirm(id, ok); }
function onAskAnswered(id: string, answer: string)      { agent.respondToAsk(id, answer); }
```

The UI is a pure subscriber. No refs, no abort controllers in component state, no `switch (event.type)` ladder — every handler's parameter is narrowed to its matching event variant automatically.

## Events

`AgentEvent` is a discriminated union on `.type`. Every variant carries exactly the fields it needs.

| `event.type` | Payload | Fired when |
|---|---|---|
| `turn_start` | `{ message: AgentMessage }` | A turn is about to begin |
| `turn_end` | `—` | A turn finished (normally, errored, or was interrupted) |
| `busy` | `—` | Loop picked up work |
| `idle` | `—` | Loop drained the inbox |
| `queue_changed` | `{ pending: number }` | Inbox size changed |
| `stream_chunk` | `{ text: string }` | A chunk of assistant text streamed |
| `stream_done` | `—` | The current stream finished (tool calls may follow) |
| `tool_start` | `{ id: string; name: string; preview: string }` | A tool invocation started |
| `tool_done` | `{ id: string; name: string; ok: boolean; output: string }` | A tool invocation finished |
| `memory` | `{ op: "remember"\|"forget"; content: string }` | The agent wrote to memory |
| `system_refreshed` | `—` | System prompt was rebuilt |
| `task_complete` | `{ summary: string }` | `CompleteTask` was called |
| `interrupted` | `—` | Current turn was aborted by `interrupt()` |
| `error` | `{ error: Error }` | Turn failed (non-Error throws are coerced to `Error`) |
| `confirm_request` | `{ id: string; command: string }` | Loop needs a yes/no; answer with `respondToConfirm(id, ok)` |
| `ask_request` | `{ id: string; question: string }` | Loop needs a free-form answer; answer with `respondToAsk(id, answer)` |

### Typed subscriptions — three flavours

**Inline, terse** — the `on(type, handler)` overload infers the handler from the literal type:

```ts
agent.on("tool_done", (e) => console.log(e.ok, e.name));  // e is ToolDoneEvent
```

**Named standalone handlers** — per-variant aliases are exported so you can type standalone functions, React props, log shippers, etc.:

```ts
import { type StreamChunkEvent, type ToolDoneEvent } from "@hypen-space/gloop-loop";

const logChunk = (e: StreamChunkEvent) => process.stdout.write(e.text);
const logTool  = (e: ToolDoneEvent)    => log({ tool: e.name, ok: e.ok });

agent.on("stream_chunk", logChunk).on("tool_done", logTool);
```

All 16 variants have named aliases: `TurnStartEvent`, `TurnEndEvent`, `BusyEvent`, `IdleEvent`, `QueueChangedEvent`, `StreamChunkEvent`, `StreamDoneEvent`, `ToolStartEvent`, `ToolDoneEvent`, `MemoryEvent`, `SystemRefreshedEvent`, `TaskCompleteEvent`, `InterruptedEvent`, `ErrorEvent`, `ConfirmRequestEvent`, `AskRequestEvent`.

**Firehose** — when you want everything in one place:

```ts
agent.onEvent((event) => {
  switch (event.type) {
    case "stream_chunk": /* narrowed */ break;
    case "error":        /* narrowed */ break;
    // ...
  }
});
```

### One-shot promise helpers

```ts
// Resolve once a specific event fires (type-narrowed):
const done = await agent.nextEvent("task_complete");
console.log(done.summary);  // typed as string

// Or with a predicate:
const firstBashDone = await agent.nextEvent(
  (e) => e.type === "tool_done" && e.name === "Bash",
);

// Wait for the inbox to drain and no turn to be in flight:
await agent.awaitIdle();
```

## Custom Tools

Define a `ToolDefinition` and register it. Tools added between turns take effect on the next turn — the loop re-reads the registry before each LLM call.

```ts
agent.addTool({
  name: "GetWeather",
  description: "Get current weather for a city",
  arguments: [{ name: "city", description: "City name" }],
  execute: async (args) => {
    const resp = await fetch(`https://wttr.in/${args.city}?format=3`);
    return resp.text();
  },
});
```

Dangerous tools can require user confirmation via `askPermission`. When it returns a string, the loop emits a `confirm_request` event with that string as the prompt, and waits for `respondToConfirm(id, ok)`:

```ts
agent.addTool({
  name: "Deploy",
  description: "Deploy the app to production",
  arguments: [{ name: "env", description: "Target environment" }],
  askPermission: (args) => `Deploy to ${args.env}?`,
  execute: async (args) => {
    await deployTo(args.env);
    return `Deployed to ${args.env}`;
  },
});
```

Passing `tools` to `AgentLoop` **replaces** the defaults. Use `primitiveTools()` to keep the builtins alongside your own:

```ts
import { AgentLoop, OpenRouterProvider, primitiveTools } from "@hypen-space/gloop-loop";

const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: "..." }),
  model: "anthropic/claude-sonnet-4.5",
  tools: [...primitiveTools(), myCustomTool],
});
```

### Mutating the tool set between turns

```ts
// After the agent has done its "reading" phase, swap in review tools:
await agent.sendSync("read the spec");

agent
  .removeTool("WriteFile")       // lock down writes
  .addTool(codeReviewTool)
  .setSystem("now you're a reviewer");

await agent.sendSync("review the code");
```

`addTool`, `removeTool`, `setTools` (atomic replacement), `setSystem`, and `clear` (reset conversation) are all chainable and take effect on the next turn.

## Injected Dependencies

Most behaviour is driven by the event stream, but a few side-effecting operations still take direct callbacks. All of them are optional — sensible defaults are provided.

> **Memory is no-op by default.** The lib never writes to disk unless you explicitly opt in. Use `createFileMemory()` (below) for simple file-backed persistence, or pass your own `remember` / `forget` callbacks for a database, KV store, etc. The `memory` event still fires so subscribers know the agent called `Remember` / `Forget`.

```ts
const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: "..." }),
  model: "anthropic/claude-sonnet-4.5",
  system: "...",

  // For non-interactive use (tests, headless).  Normal interactive apps
  // should omit these and handle `confirm_request` / `ask_request` events.
  confirm: async (cmd) => true,
  ask: async (q) => "proceed",

  // Memory persistence (default: no-op).  Plug in anything you like:
  remember: async (content) => db.insert("memories", { content }),
  forget:   async (content) => db.delete("memories", { content }),

  // Called when the agent triggers a system-prompt refresh.  May return a
  // new prompt string which the actor will install on the conversation.
  refreshSystem: async () => buildPromptFromLatestState(),

  // Delegate a sub-task to a spawned subagent process.
  spawn: async (task) => runSubprocess(task),

  // Runtime tool installation (e.g. for hot-reloadable custom tools).
  installTool: async (source) => loadAndRegister(source),

  // Debug logger — receives (label, content) for internal events.
  log: (label, content) => console.debug(`[${label}]`, content),
});
```

### File-backed memory (opt-in)

If you want the convenience of "just write notes to a file on disk", use `createFileMemory`:

```ts
import { AgentLoop, createFileMemory, OpenRouterProvider } from "@hypen-space/gloop-loop";

const memory = createFileMemory();                              // .gloop/memory.md in cwd
const memory = createFileMemory({ dir: ".notes" });             // .notes/memory.md
const memory = createFileMemory({ dir: ".notes", file: "a.md", maxEntryLength: 1000 });

const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: "..." }),
  model: "anthropic/claude-sonnet-4.5",
  remember: memory.remember,
  forget:   memory.forget,
});

// Read the memory contents anywhere:
const notes = await memory.read();
```

`createFileMemory` returns `{ remember, forget, read }` — a bundle of closures captured over the config. Two instances with different `dir` values are fully independent.

## Cancellation

Interrupt the current turn at any time. The loop keeps running — the next queued message will be processed normally.

```ts
import { AgentLoop, AbortError } from "@hypen-space/gloop-loop";

const pending = agent.sendSync("Refactor the entire codebase");

// Later — maybe the user hit escape:
agent.interrupt();

try {
  await pending;
} catch (err) {
  if (err instanceof AbortError) {
    console.log("User interrupted the turn");
  }
}

// Loop is still alive — keep sending:
await agent.sendSync("Just do a small refactor instead");
```

To tear the whole loop down: `await agent.stop()`.

## Built-in Tools

When you don't pass `tools`, the agent gets `primitiveTools()`:

| Tool | Description |
|------|-------------|
| `ReadFile` | Read a file from the filesystem |
| `WriteFile` | Write literal content to a file (with safety checks) |
| `Patch_file` | Apply a git-style unified diff |
| `Bash` | Execute shell commands (timeout + confirmation for destructive ops) |
| `CompleteTask` | Signal task completion with a summary |
| `AskUser` | Prompt the user for free-form input |
| `Remember` | Persist a note to memory |
| `Forget` | Remove a note from memory |
| `ManageContext` | Prune conversation history to control context length |

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
| `.nextEvent(type)` | `Promise<narrowed>` | — | — |
| `.nextEvent(filter)` | `Promise<AgentEvent>` | — | — |
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
| `.isRunning()` | `boolean` | — | — |
| `.pending()` | `number` | — | — |

Readable state:
- `agent.convo` — the `AIConversation` (has `getHistory()`, `setHistory()`, `setProviderRouting()`)
- `agent.registry` — the `ToolRegistry`
- `agent.world` — the interpreter state (advanced)

### AI Layer

| Export | Kind | Description |
|---|---|---|
| `OpenRouterProvider` | class | `AIProvider` implementation backed by OpenRouter |
| `AI` | class | Entry point: `.model()`, `.chat()`, `.conversation()` |
| `AIConversation` | class | Stateful multi-turn conversation with streaming |
| `AIProvider` | type | Provider interface: `complete()` + `stream()` |
| `AIProviderConfig` | type | `{ apiKey, baseUrl?, defaultModel? }` |
| `AIRequestConfig` | type | Full request configuration |
| `StreamResult` | type | `{ textStream, toolCalls, cancel() }` |

### Tools

| Export | Kind | Description |
|---|---|---|
| `ToolRegistry` | class | Register, lookup, and list tool definitions |
| `primitiveTools()` | function | Returns the default builtin tools array |
| `registerBuiltins()` | function | Register all builtins onto a registry |
| `ToolDefinition` | type | `{ name, description, arguments, execute, askPermission? }` |
| `ToolCall` | type | `{ name, args: Record<string, string> }` |
| `ToolResult` | type | `{ name, output, success }` |
| `BuiltinIO` | type | IO interface for builtin tools (fs + shell) |

### Events & Messages

| Export | Kind | Description |
|---|---|---|
| `AgentEvent` | type | Discriminated union of every event variant |
| `AgentEventListener` | type | `(event: AgentEvent) => void` |
| `AgentMessage` | type | `{ id?, role: "user" \| "system", content }` |
| `AgentLoopOptions` | type | Constructor options |
| `TurnStartEvent` ... `AskRequestEvent` | type | Per-variant aliases (16 total) |

### Low-Level Interpreter (advanced)

For callers who want to build their own loop on top of the Form interpreter:

| Export | Kind | Description |
|---|---|---|
| `run()` | function | `(input, world, effects, config?) => Promise<void>` |
| `eval_()` | function | `(form, world, effects, config?) => Promise<void>` |
| `mkWorld()` | function | Build a `World` from a conversation and registry |
| `Think`, `Invoke`, `Confirm`, `Ask`, `Remember`, `Forget`, `Emit`, `Refresh`, `Done`, `Seq`, `Nil`, `Install`, `ListTools`, `Spawn` | functions | Form constructors |
| `Form`, `Effects`, `World`, `LoopConfig` | types | Interpreter types |
| `AbortError` | class | Thrown on cancellation |

Most users don't need these — `AgentLoop` is implemented in terms of them.

## Runtime Compatibility

- **Bun** and **Node.js ≥ 18**: fully supported out of the box.
- The core loop (`core/`) and AI layer (`ai/`) are portable — no Node.js-specific APIs.
- `primitiveTools()` and the default memory implementation use Node.js APIs (`fs`, `child_process`). Provide your own `BuiltinIO` and injected `remember`/`forget`/`spawn` callbacks to run in other environments (e.g. the browser — see `examples/browser.html`).

## License

MIT
