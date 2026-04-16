# @hypen-space/gloop-loop

A recursive, actor-style agent loop for LLMs. Typed events, chainable builder, batteries-included for Node/Bun, portable to the browser.

## Install

```bash
bun add @hypen-space/gloop-loop
# or: npm install / pnpm add
```

You also need an `OPENROUTER_API_KEY` in the environment.

## Quick start — a deploy bot with 5 tools

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
    {
      name: "Rollback",
      description: "Roll back an environment.",
      arguments: [{ name: "env", description: "Environment" }],
      askPermission: (args) => `Rollback ${args.env}?`,
      execute: async (args) => `Rolled ${args.env} back`,
    },
    {
      name: "CompleteTask",
      description: "Call when you're done.",
      arguments: [{ name: "summary", description: "What was done" }],
      execute: async (args) => args.summary ?? "Done",
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

16 per-variant aliases exported: `TurnStartEvent`, `TurnEndEvent`, `BusyEvent`, `IdleEvent`, `QueueChangedEvent`, `StreamChunkEvent`, `StreamDoneEvent`, `ToolStartEvent`, `ToolDoneEvent`, `MemoryEvent`, `SystemRefreshedEvent`, `TaskCompleteEvent`, `InterruptedEvent`, `ErrorEvent`, `FatalEvent`, `ConfirmRequestEvent`, `AskRequestEvent`.

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
| Restore conversation history | `agent.convo.setHistory([...])` |

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
| `.isRunning()` | `boolean` | — | — |
| `.pending()` | `number` | — | — |

Readable state: `agent.convo`, `agent.registry`, `agent.world`.

### AgentEvent

Discriminated union on `.type`:

| Type | Payload | When |
|---|---|---|
| `turn_start` | `{ message }` | About to process a message |
| `turn_end` | — | Turn finished (normally, errored, or interrupted) |
| `busy` / `idle` | — | Loop state |
| `queue_changed` | `{ pending }` | Inbox size changed |
| `stream_chunk` | `{ text }` | Assistant text chunk |
| `stream_done` | — | Stream finished (tools may follow) |
| `tool_start` | `{ id, name, preview }` | Tool invocation started |
| `tool_done` | `{ id, name, ok, output }` | Tool invocation finished |
| `memory` | `{ op, content }` | Agent called Remember / Forget |
| `system_refreshed` | — | System prompt was updated |
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
| `contextPruneInterval` | 50 | Tool-call count between auto-prunes |
| `classifySpawn` | — | Classify tool calls as spawn tasks |
| `log` | — | Debug logger |

### Other exports

- **Providers**: `OpenRouterProvider`, `AI`, `AIBuilder`, `AIConversation`
- **Tools**: `ToolDefinition`, `ToolCall`, `ToolResult`, `ToolRegistry`, `primitiveTools`, `registerBuiltins`
- **Memory**: `createFileMemory`, `FileMemory`, `FileMemoryOptions`, `appendMemory`, `removeMemory`, `readMemory`
- **Errors**: `AbortError`
- **Low-level interpreter** (advanced): `run`, `eval_`, `mkWorld`, Form constructors (`Think`, `Invoke`, `Done`, ...), `Effects`, `World`, `LoopConfig`

## Runtime compatibility

- **Bun** and **Node.js ≥ 18**
- Core loop and AI layer are portable (no Node APIs)
- Primitive tools use `node:fs` + `node:child_process` — override `io` for other runtimes

## License

MIT
