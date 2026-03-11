# @hypen-space/gloop-loop

A drop-in recursive agent loop with OpenRouter support + easily extendable for any other provider.
Comes with built in npm compatible defaults, but also usable in browsers.

## What is this?

gloop-loop models an LLM agent as a recursive interpreter over **Forms** -- pure data values that describe what to do next (think, invoke a tool, ask the user, emit text, etc.). The interpreter evaluates forms one at a time, threading immutable state (`World`) through each step and performing side effects through an injected `Effects` interface. The result is a small (~2K LOC), zero-framework agent kernel where every behavior is explicit and composable.

## Installation

```bash
npm install @hypen-space/gloop-loop
# or
pnpm add @hypen-space/gloop-loop
# or
bun add @hypen-space/gloop-loop
```

## Quick Start


```ts
import { AgentLoop, OpenRouterProvider } from "@hypen-space/gloop-loop";

const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY! }),
  model: "anthropic/claude-sonnet-4",
  system: "You are a helpful assistant.",
});

await agent.run("What files are in the current directory?");
```

With no `tools` passed, the agent gets all built-in tools (file I/O, shell, memory, context management) out of the box, streams to stdout, and prompts via stdin.


## Core Concepts

### Forms

A Form is a tagged union describing the next action. The interpreter pattern-matches on the tag and recurses until it hits a terminal form (`Done` or `Nil`). There are 14 form types:

| Form | Purpose |
|------|---------|
| `Think(input)` | Send input to the LLM and stream its response |
| `Invoke(calls, cont)` | Execute tool calls, pass results to continuation |
| `Confirm(cmd, cont)` | Ask user to approve a command |
| `Ask(question, cont)` | Prompt user for free-form input |
| `Remember(content, then)` | Persist a note to memory |
| `Forget(content, then)` | Remove a note from memory |
| `Emit(text, then)` | Output text to the user |
| `Refresh()` | Refresh the system prompt |
| `Done(summary)` | Terminal -- task complete |
| `Nil` | Terminal -- no-op |
| `Seq(...forms)` | Evaluate a sequence of forms |
| `Install(source)` | Install a tool from a URL or path |
| `ListTools()` | List registered tools |
| `Spawn(task, cont)` | Delegate a task to a subagent |

Each non-terminal form carries a continuation -- a function that takes the result and returns the next form. The entire control flow is a chain of pure data transformations.

### World

Immutable state threaded through evaluation:

```ts
interface World {
  convo: AIConversation;   // conversation history + LLM access
  registry: ToolRegistry;  // registered tools
  toolCalls: number;       // counter for auto context pruning
  signal?: AbortSignal;    // cancellation
}
```

### Effects

All I/O is injected through the `Effects` interface. The interpreter never does I/O directly -- it calls effect functions. This makes the loop testable, portable, and embeddable in any UI.

```ts
interface Effects {
  streamChunk: (text: string) => void;
  streamDone: () => void;
  toolStart: (name: string, preview: string) => void;
  toolDone: (name: string, ok: boolean, output: string) => void;
  confirm: (command: string) => Promise<boolean>;
  ask: (question: string) => Promise<string>;
  remember: (content: string) => Promise<void>;
  forget: (content: string) => Promise<void>;
  refreshSystem: () => Promise<void>;
  manageContext: (instructions: string) => Promise<string>;
  complete: (summary: string) => void;
  installTool: (source: string) => Promise<string>;
  listTools: () => string;
  spawn: (task: string) => Promise<SpawnResult>;
  log?: (label: string, content: string) => void;
}
```

### AgentLoop

The batteries-included wrapper. Constructs `World`, `Effects`, and a `ToolRegistry` from a single options object. Exposes `.run()`, `.addTool()`, `.setSystem()`, and `.clear()`.

## Custom Tools

Define a `ToolDefinition` and register it:

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

Tools can optionally define `askPermission` to require user confirmation before execution:

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

Passing `tools` to `AgentLoop` **replaces** the defaults entirely. Use `primitiveTools()` to keep the builtins alongside your custom tools:

```ts
import { AgentLoop, OpenRouterProvider, primitiveTools } from "@hypen-space/gloop-loop";

const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: "..." }),
  model: "anthropic/claude-sonnet-4",
  tools: [...primitiveTools(), myCustomTool],
});
```

## Low-Level API

For full control, use `run()` or `eval_()` directly with your own `World` and `Effects`:

```ts
import {
  run, eval_, mkWorld, Think, Done, Seq,
  AI, OpenRouterProvider, ToolRegistry,
  registerBuiltins, createNodeIO, createEffects,
  type Effects,
} from "@hypen-space/gloop-loop";

// 1. Set up tools
const registry = new ToolRegistry();
registerBuiltins(registry, createNodeIO());

// 2. Set up conversation
const provider = new OpenRouterProvider({ apiKey: "..." });
const ai = new AI(provider, "anthropic/claude-sonnet-4");
const convo = ai.conversation({ model: "anthropic/claude-sonnet-4", system: "You help." });

// 3. Set up effects and world
const effects = createEffects({ convo, registry });
const world = mkWorld(convo, registry);

// Option A: run from user input (parses slash commands, then evaluates)
await run("Hello!", world, effects);

// Option B: evaluate a form directly
await eval_(Think("What files are here?"), world, effects);

// Option C: compose forms by hand
await eval_(Seq(Think("List three colors"), Done("Listed colors")), world, effects);
```

## Built-in Tools

`primitiveTools()` returns the default tool set:

| Tool | Description |
|------|-------------|
| `ReadFile` | Read a file from the filesystem |
| `WriteFile` | Write literal content to a file (with safety checks against accidental overwrites) |
| `Patch_file` | Apply a git-style unified diff patch |
| `Bash` | Execute shell commands (with optional timeout, confirmation for destructive ops) |
| `CompleteTask` | Signal task completion and return a summary |
| `AskUser` | Prompt the user for input |
| `Remember` | Store a note in persistent memory (`.gloop/memory.md`) |
| `Forget` | Remove a note from persistent memory |
| `ManageContext` | Prune conversation history to manage context length |

## Custom Effects

Override specific behaviors via `AgentLoopOptions`:

```ts
const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: "..." }),
  model: "anthropic/claude-sonnet-4",
  onStream: (text) => ws.send(JSON.stringify({ type: "text", text })),
  onToolStatus: (name, status) => logger.info(`[${name}] ${status}`),
  ask: async (question) => waitForUserResponse(question),
  confirm: async (command) => showConfirmDialog(command),
  onComplete: (summary) => ui.finish(summary),
  remember: async (content) => db.insert("memories", { content }),
  forget: async (content) => db.delete("memories", { content }),
  log: (label, content) => console.debug(`[${label}]`, content),
});
```

Or use `createEffects()` directly when working with the low-level API:

```ts
const effects = createEffects({
  convo,
  registry,
  onStream: (text) => socket.send(text),
  confirm: async () => true, // auto-approve everything
});
```

## Abort / Cancellation

Thread an `AbortController` to cancel a running agent:

```ts
import { AgentLoop, OpenRouterProvider, AbortError } from "@hypen-space/gloop-loop";

const controller = new AbortController();

const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: "..." }),
  model: "anthropic/claude-sonnet-4",
  signal: controller.signal,
});

setTimeout(() => controller.abort(), 30_000);

try {
  await agent.run("Refactor the auth module");
} catch (err) {
  if (err instanceof AbortError) {
    console.log("Agent was cancelled");
  }
}
```

## API Reference

### AI Layer

| Export | Kind | Description |
|--------|------|-------------|
| `OpenRouterProvider` | class | `AIProvider` implementation backed by OpenRouter |
| `AI` | class | Entry point: `.model()`, `.chat()`, `.conversation()` |
| `AIConversation` | class | Stateful multi-turn conversation with streaming |
| `AIBuilder` | class | Fluent request builder with lazy parameter resolution |
| `AIProvider` | type | Provider interface: `complete()` + `stream()` |
| `AIProviderConfig` | type | `{ apiKey, baseUrl?, defaultModel? }` |
| `AIRequestConfig` | type | Full request configuration |
| `AIResponse` | type | Completion response |
| `StreamResult` | type | `{ textStream, toolCalls, cancel() }` |

### Tools

| Export | Kind | Description |
|--------|------|-------------|
| `ToolRegistry` | class | Register, lookup, and list tool definitions |
| `primitiveTools()` | function | Returns the default builtin tools array |
| `registerBuiltins()` | function | Register all builtins onto a registry |
| `ToolDefinition` | type | `{ name, description, arguments, execute, askPermission? }` |
| `ToolArgument` | type | `{ name, description }` |
| `ToolCall` | type | `{ name, rawArgs }` |
| `ToolResult` | type | `{ name, output, success }` |
| `BuiltinIO` | type | IO interface for builtin tools (fs + shell) |
| `formatShellResult()` | function | Format a `ShellResult` for display |

### Core Loop

| Export | Kind | Description |
|--------|------|-------------|
| `run()` | function | `(input, world, effects, config?) => Promise<void>` |
| `eval_()` | function | `(form, world, effects, config?) => Promise<void>` |
| `mkWorld()` | function | Create a `World` from conversation + registry |
| `parseInput()` | function | Parse user input into a Form (slash commands, etc.) |
| `toolCallsToForm()` | function | Convert tool calls to a Form with continuations |
| `formatResults()` | function | Format `ToolResult[]` for the LLM |
| `Think`, `Invoke`, `Confirm`, `Ask`, `Remember`, `Forget`, `Emit`, `Refresh`, `Done`, `Seq`, `Nil`, `Install`, `ListTools`, `Spawn` | functions | Form constructors |
| `AbortError` | class | Thrown on cancellation |
| `raceAbort()` | function | Race a promise against an `AbortSignal` |
| `Form` | type | Tagged union of all form types |
| `Effects` | type | Side-effect callback interface |
| `World` | type | Interpreter state |
| `LoopConfig` | type | Optional loop configuration (prune interval, spawn classifier) |

### Defaults

| Export | Kind | Description |
|--------|------|-------------|
| `AgentLoop` | class | High-level entry point wiring everything together |
| `AgentLoopOptions` | type | Configuration for `AgentLoop` |
| `createEffects()` | function | Build a complete `Effects` with sensible defaults |
| `createNodeIO()` | function | Node.js `BuiltinIO` implementation (fs + child_process) |
| `appendMemory()` | function | Append to `.gloop/memory.md` |
| `removeMemory()` | function | Remove from `.gloop/memory.md` |
| `readMemory()` | function | Read `.gloop/memory.md` |
| `manageContextFork()` | function | Context pruning via conversation fork |

## Runtime Compatibility

- **Node.js >= 18** and **Bun**: fully supported.
- The core loop (`core/`) and AI layer (`ai/`) are portable -- no Node.js-specific APIs.
- `defaults/` and `primitiveTools()` use Node.js APIs (`fs`, `child_process`, `readline`). Provide your own `BuiltinIO` and `Effects` implementations to run in other environments.

## License

MIT
