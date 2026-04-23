# @hypen-space/gloop-effect

Effect-TS native agent loop. Pairs with [`@hypen-space/gloop-loop`](../gloop-loop) — the Form ADT, slash-command parser, skill helpers, and builtin tool bodies are shared; the actor shell, provider interface, error model, and event bus are rebuilt on Effect primitives (`Stream`, `Fiber`, `PubSub`, `Ref`, `Queue`).

## Why use this over `gloop-loop`?

- **Typed errors** — every failure is a `Schema.TaggedError`, so `catchTag`/`catchTags` narrows precisely.
- **Stream events** — `agent.events: Stream<AgentEvent>` fans out via `PubSub`; subscribers get backpressure + filter/map/merge for free.
- **Fiber interrupts** — `agent.interrupt` uses structured concurrency, not an `AbortController`.
- **Layer-based DI** — providers, memory, and IO drop in as `Layer`s at the app root.
- **Spans everywhere** — public methods wrap themselves in `Effect.fn(...)` / `Effect.withSpan(...)` with useful attributes. Plug in `@effect/opentelemetry` and get a full trace per turn.
- **Schema-unified** — events, IDs, messages, tool calls are all `Schema.TaggedStruct` — JSON-codec-ready for RPC transport.

## Install

```bash
bun add @hypen-space/gloop-effect effect
# or: npm install / pnpm add
```

You need an `OPENROUTER_API_KEY` in the environment for the default provider.

## Quick start — a deploy bot with 3 tools

```ts
import { Effect, Option, Stream } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import {
  Agent,
  OpenRouterProviderLive,
  type Tool,
} from "@hypen-space/gloop-effect"

const listEnvs: Tool<never> = {
  name: "ListEnvironments",
  description: "List all deployment environments.",
  arguments: [],
  execute: () => Effect.succeed("staging, prod, canary"),
}

const getStatus: Tool<never> = {
  name: "GetStatus",
  description: "Get the current deployment status of an environment.",
  arguments: [{ name: "env", description: "Environment name" }],
  execute: (args) => Effect.succeed(`${args.env}: healthy, 3 instances`),
}

const deploy: Tool<never> = {
  name: "Deploy",
  description: "Deploy the current build to an environment.",
  arguments: [
    { name: "env", description: "Target environment" },
    { name: "version", description: "Version tag" },
  ],
  // Returning Some(reason) pauses the turn for ConfirmRequest.
  askPermission: (args) =>
    args.env === "prod"
      ? Option.some(`Deploy ${args.version} to prod?`)
      : Option.none(),
  execute: (args) => Effect.succeed(`Deployed ${args.version} to ${args.env}`),
}

const program = Effect.gen(function* () {
  const agent = yield* Agent.make({
    model: "anthropic/claude-sonnet-4.5",
    system: "You are a deploy bot. Use the tools to help the user.",
    tools: [listEnvs, getStatus, deploy],
    // Auto-approve every confirm. For a TUI, omit this and listen for
    // ConfirmRequest events instead.
    confirm: () => Effect.succeed(true),
  })

  // Render streaming chunks to stdout.
  yield* Effect.forkScoped(
    agent.events.pipe(
      Stream.runForEach((e) =>
        e._tag === "StreamChunk"
          ? Effect.sync(() => process.stdout.write(e.text))
          : Effect.void,
      ),
    ),
  )

  yield* agent.sendSync("deploy v2.1.0 to staging and report status")
})

NodeRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.provide(
      OpenRouterProviderLive({ apiKey: process.env.OPENROUTER_API_KEY! }),
    ),
  ),
)
```

## The shape of `Agent`

```ts
interface Agent {
  send:       (msg: AgentMessage | string) => Effect<MessageId>
  sendSync:   (msg: AgentMessage | string) => Effect<void, AgentError>
  events:     Stream<AgentEvent>
  eventsOf:   <T extends AgentEvent["_tag"]>(tag: T) => Stream<AgentEventOf<T>>
  interrupt:  Effect<void>
  stop:       Effect<void>
  awaitIdle:  Effect<void>
  pending:    Effect<number>

  addTool:    <E extends AgentError>(tool: Tool<E>) => Effect<void>
  removeTool: (name: string) => Effect<void>
  setTools:   (tools: ReadonlyArray<AnyTool>) => Effect<void>
  setSystem:  (prompt: string) => Effect<void>
  clear:      Effect<void>

  respondToConfirm: (id: RequestId, ok: boolean) => Effect<void>
  respondToAsk:     (id: RequestId, answer: string) => Effect<void>

  registry:     ToolRegistry
  conversation: ConversationHandle
}
```

`Agent.make` is **scoped** — run inside `Effect.scoped` (or provide a `Scope` layer) so resources tear down cleanly.

## Subscribing to events

```ts
// Full firehose
agent.events.pipe(Stream.runForEach(handleEvent))

// Single tag — type-narrowed
agent.eventsOf("ToolDone").pipe(
  Stream.runForEach((e) => Effect.log(`tool ${e.name} → ${e.ok}`)),
)

// Merged or filtered
Stream.merge(
  agent.eventsOf("StreamChunk"),
  agent.eventsOf("TaskComplete"),
).pipe(Stream.runForEach(...))
```

Every call creates a fresh subscription via `PubSub.subscribe` — late subscribers miss past events. Subscribe *before* sending if you need a specific event (or use `sendSync`, which subscribes internally and awaits the matching `TurnEnd`).

### Event variants

`AgentEvent` is a `Schema.Union` of 17 `TaggedStruct` variants, discriminated on `_tag`:

| Tag | Payload | When |
|---|---|---|
| `TurnStart` | `message` | A message is about to be processed |
| `TurnEnd` | — | The current turn finished |
| `Busy` / `Idle` | — | The loop picked up / drained work |
| `QueueChanged` | `pending` | Inbox size changed |
| `StreamChunk` | `text` | Streamed assistant text delta |
| `StreamDone` | — | Stream finished (tool calls may follow) |
| `ToolStart` / `ToolDone` | `id`, `name`, …​ | Tool invocation lifecycle |
| `Memory` | `op`, `content` | Agent called Remember / Forget |
| `SystemRefreshed` | — | System prompt was rebuilt |
| `TaskComplete` | `summary` | CompleteTask was called |
| `Interrupted` | — | Current turn was aborted |
| `Error` / `Fatal` | `error: AgentError` | Non-fatal / fatal turn error |
| `ConfirmRequest` / `AskRequest` | `id`, …​ | Blocking user prompt |

## Custom tools

Tools are plain objects whose `execute` returns an `Effect`. The error channel is constrained to `AgentError` so failures fit the interpreter's union:

```ts
import { Effect, Option } from "effect"
import { ToolExecutionError, type Tool } from "@hypen-space/gloop-effect"

const fetchUrl: Tool<ToolExecutionError> = {
  name: "FetchUrl",
  description: "HTTP GET a URL and return the body",
  arguments: [{ name: "url", description: "Full URL" }],
  askPermission: (args) => Option.none(),          // None → run immediately
  execute: (args) =>
    Effect.tryPromise({
      try: () => fetch(args.url!).then((r) => r.text()),
      catch: (e) =>
        new ToolExecutionError({
          name: "FetchUrl",
          message: e instanceof Error ? e.message : String(e),
          cause: e,
        }),
    }),
}
```

Tool failures fold into a `ToolResult { success: false }` — the model sees the error and decides whether to retry. If you want a tool error to be **turn-fatal**, return `Effect.die(...)` instead of `Effect.fail(...)`.

### Builtins

```ts
import { primitiveTools } from "@hypen-space/gloop-effect"

const agent = yield* Agent.make({
  model: "...",
  system: "...",
  tools: primitiveTools(),       // ReadFile, WriteFile, Patch_file, Bash, CompleteTask, AskUser, Remember, Forget, ManageContext
})
```

Wraps `gloop-loop`'s builtins as `Tool<ToolExecutionError>`. Pass a custom `BuiltinIO` to override filesystem / shell semantics.

## Skills (Agent Skills / `SKILL.md`)

Pass discovered skills via `AgentMakeOptions.skills` — the agent:

1. **Merges names + descriptions into the system prompt** so the model knows what exists.
2. **Auto-registers `InvokeSkill`** as a tool so the model can call `InvokeSkill(name, arguments)` and receive the fully-substituted skill body as the next turn's input. (If you pass your own tool named `InvokeSkill`, it takes precedence.)
3. **Resolves slash commands** in user messages: `/skills` lists, `/skill <name> [args]` runs, `/<name> [args]` runs if `<name>` matches a skill.

```ts
import {
  Agent,
  parseSkillMarkdown,
  type Skill,
} from "@hypen-space/gloop-effect"
import { readdir, readFile } from "node:fs/promises"

// Your host discovers SKILL.md files wherever — .claude/skills, .agent/skills, etc.
const skills: Skill[] = await Promise.all(
  (await readdir(".claude/skills")).map(async (dir) => {
    const body = await readFile(`.claude/skills/${dir}/SKILL.md`, "utf8")
    return parseSkillMarkdown(body, dir)
  }),
)

const agent = yield* Agent.make({
  model: "...",
  system: "You are a designer.",
  skills,
})

yield* agent.sendSync("/skill web-design-guidelines review the homepage")
```

Skill discovery lives in **your host code** — the library doesn't read the filesystem for them. Use `parseSkillMarkdown` / `findSkill` / `mergeSkillsIntoSystem` / `formatSkillsListing` / `applySkillSubstitutions` / `splitSkillArguments` / `matchSkillSlash` / `skillInvocationToThinkInput` / `thinkInputFromSkillSubcommand` — all re-exported from this package.

## Hosts, memory, and defaults

Three shipped defaults — each a single import away:

### `OpenRouterProviderLive`

```ts
import { OpenRouterProviderLive } from "@hypen-space/gloop-effect"

const ProviderLive = OpenRouterProviderLive({
  apiKey: process.env.OPENROUTER_API_KEY!,
  httpReferer: "https://myapp.example",   // optional
  xTitle: "my-app",                       // optional
})
```

Provides the `AIProvider` service. Spans on `OpenRouterProvider.complete` and `.stream.*` with `model` attributes.

### `fileMemory`

```ts
import { fileMemory } from "@hypen-space/gloop-effect"

const memory = fileMemory({
  path: "./.gloop/memory.md",            // default
  maxEntryLength: 500,                    // default
})

const agent = yield* Agent.make({
  model: "...",
  system: "...",
  remember: memory.remember,              // plug into hooks
  forget:   memory.forget,
})
```

### `createNodeIO`

```ts
import { createNodeIO, primitiveTools } from "@hypen-space/gloop-effect"

const io = createNodeIO()
const tools = primitiveTools(io)          // ReadFile/WriteFile/Bash use these
```

## Tracing

Every public method is a named span:

| Span | Attributes |
|---|---|
| `Agent.send` / `sendSync` / `interrupt` / `stop` / `awaitIdle` / `respondTo*` | `messageId`, `requestId` |
| `Agent.runTurn` | `messageId`, `role`, `contentLength` |
| `Conversation.send` / `.stream` | `model`, `historyLength`, `toolCount` |
| `OpenRouterProvider.complete` / `.stream.*` | `model` |
| `Interpreter.evalForm` | `form` (tag) |
| `Interpreter.evalThink` | — |
| `Interpreter.evalInvoke` | `toolCount` |
| `Interpreter.dispatchCall` | `tool`, `kind`, `success`, `denied` |
| `ToolRegistry.register` / `.unregister` | `toolName` |

Wire an exporter with `@effect/opentelemetry`:

```ts
import { NodeSdk } from "@effect/opentelemetry"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"

const TracingLive = NodeSdk.layer(() => ({
  resource: { serviceName: "my-agent" },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({ url: "http://localhost:4318/v1/traces" }),
  ),
}))

NodeRuntime.runMain(
  Effect.scoped(program).pipe(
    Effect.provide(Layer.mergeAll(ProviderLive, TracingLive)),
  ),
)
```

No code change in your app — the spans already exist.

## Logging

Two channels:

**Effect-native** — `Effect.log` / `Effect.logInfo` / `Effect.logDebug`. Provide any `Logger` layer at the root:

```ts
import { Logger, LogLevel } from "effect"

Effect.provide(Logger.pretty),                         // human-readable
Effect.provide(Logger.json),                           // one JSON line per log
Effect.provide(Logger.withMinimumLogLevel(LogLevel.Debug))
```

Internally, `LLM_INPUT` / `LLM_OUTPUT` / `TOOL_CALLS` are emitted at `Debug` level.

**Host debug hook** — `AgentMakeOptions.log: (label, content) => Effect<void>`. Fires alongside the Effect logger. Useful for piping transcripts to a file or a TUI panel:

```ts
const agent = yield* Agent.make({
  model: "...",
  system: "...",
  log: (label, content) =>
    Effect.sync(() => fs.appendFileSync("debug.log", `[${label}] ${content}\n`)),
})
```

## Errors

All failures are `Schema.TaggedError` with a `message` field:

| Error | When |
|---|---|
| `AIProviderError` | Provider call failed — carries `op`, `model`, `provider`, `cause` |
| `ToolNotFoundError` | Model called a tool that isn't registered |
| `ToolExecutionError` | A tool's `execute` failed |
| `ToolPermissionDeniedError` | A gated tool was denied by the host |
| `AgentInterruptedError` | The current turn was interrupted |
| `FatalAgentError` | Turn-level error classified as fatal via `isFatal` |
| `FileIOError` | `BuiltinIO` read/write/delete failed — carries `op`, `path` |
| `ShellExecError` | `BuiltinIO.exec` non-zero exit |
| `MemoryError` | `fileMemory` read/write failed |

`AgentError` is the union. Use `catchTag`/`catchTags` — never `catchAll`:

```ts
yield* agent.sendSync(userInput).pipe(
  Effect.catchTags({
    AIProviderError:         (e) => showBanner(`Provider down: ${e.provider ?? "?"}`),
    AgentInterruptedError:   () => showBanner("Interrupted"),
    ToolExecutionError:      (e) => showBanner(`Tool ${e.name} failed`),
  }),
)
```

## Testing

The bundled `test/helpers.ts` exposes a scriptable stub provider:

```ts
import { Effect, Layer, Stream } from "effect"
import { AIProvider, type AIProviderImpl } from "@hypen-space/gloop-effect"

const stub: AIProviderImpl = {
  name: "stub",
  complete: () => Effect.succeed({ id: "x", model: "stub", content: "ok", finishReason: "stop" }),
  stream:   () => ({
    chunks: Stream.fromIterable(["o", "k"]),
    result: Effect.succeed({ id: "x", model: "stub", content: "ok", finishReason: "stop" }),
    cancel: Effect.void,
  }),
}

Effect.runPromise(
  Effect.scoped(program).pipe(
    Effect.provide(Layer.succeed(AIProvider, stub)),
  ),
)
```

See `test/` for 21 tests covering: actor lifecycle (`interrupt`, `stop`, `awaitIdle`), error escalation (`Error` vs `Fatal`), tool execution + `ToolStart`/`ToolDone` pairing, confirm approve / deny, skill auto-registration, and conversation history.

## What's shared with `gloop-loop`

Pure / data / helpers are imported directly — no duplicate source of truth:

- `Form` ADT (`Think`, `Invoke`, `Confirm`, `Ask`, `Remember`, `Forget`, `Emit`, `Refresh`, `Done`, `Seq`, `Nil`, `Install`, `ListTools`, `Spawn`) and the interpreter dispatch (`toolCallsToForm`, `formatResults`, `parseInput`)
- Skill parsing/formatting (`parseSkillMarkdown`, `findSkill`, `mergeSkillsIntoSystem`, `formatSkillsListing`, `applySkillSubstitutions`, `splitSkillArguments`, `matchSkillSlash`, `skillInvocationToThinkInput`, `thinkInputFromSkillSubcommand`, `createInvokeSkillTool`)
- Builtin tool bodies (wrapped by `toEffectTool` into Effect tools)
- `createNodeIO`, `createFileMemory` (wrapped with Effect adapters)
- OpenRouter HTTP logic (wrapped into the `AIProvider` layer)

Rebuilt on Effect primitives: the actor shell, provider interface, conversation state, tool registry, error types, and every public method signature.

## License

MIT
