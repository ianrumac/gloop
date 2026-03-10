# @ianrumac/gloop-loop

A recursive Lisp-style agent loop for building LLM tool-calling agents. Works with any OpenAI-compatible provider. Runs on Node.js and Bun.

## Quick start

```bash
bun add @ianrumac/gloop-loop
# or
npm install @ianrumac/gloop-loop
```

```ts
import { AgentLoop, OpenRouterProvider } from "@ianrumac/gloop-loop";

const agent = new AgentLoop({
  provider: new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY! }),
  model: "anthropic/claude-sonnet-4",
  system: "You are a helpful coding assistant.",
});

await agent.run("What files are in the current directory?");
```

That's it. The agent can read/write files, run shell commands, ask you questions, and manage its own context window — all out of the box.

## Built-in tools

Every `AgentLoop` comes with these tools pre-registered:

| Tool | Description |
|------|-------------|
| `ReadFile` | Read a file from the filesystem |
| `WriteFile` | Write content to a file (with safety checks) |
| `Patch_file` | Apply a git-style unified diff patch |
| `Bash` | Execute shell commands (with confirmation for destructive ops) |
| `AskUser` | Ask the user a question and wait for input |
| `Remember` | Store a note in persistent memory (`.gloop/memory.md`) |
| `Forget` | Remove a note from persistent memory |
| `ManageContext` | Prune conversation history to stay within context limits |
| `CompleteTask` | Signal that the task is done |

## How it works

The core idea: **an agent is a recursive interpreter over Forms**.

A `Form` is a pure data description of what to do next — like an S-expression in Lisp. The interpreter (`eval_`) evaluates forms, performs side effects, and produces new forms, recursing until it hits a terminal state (`Done` or `Nil`).

```
User input → Think → LLM response → Tool calls → Invoke → Results → Think → ... → Done
```

### Forms

```ts
type Form =
  | { tag: "think"; input: string }           // Send input to LLM
  | { tag: "invoke"; calls: ToolCall[] }       // Execute tools
  | { tag: "confirm"; command: string }        // Ask user to confirm
  | { tag: "ask"; question: string }           // Ask user a question
  | { tag: "remember"; content: string }       // Persist to memory
  | { tag: "forget"; content: string }         // Remove from memory
  | { tag: "emit"; text: string }              // Output text
  | { tag: "refresh" }                         // Refresh system prompt
  | { tag: "done"; summary: string }           // Terminal — task complete
  | { tag: "nil" }                             // Terminal — no-op
  | { tag: "spawn"; task: string }             // Subagent
  | { tag: "install"; source: string }         // Install a tool
  | { tag: "list-tools" }                      // List available tools
```

Each form carries a continuation (`then`) — a function that takes the result and returns the next form. This makes the entire control flow a chain of pure transformations.

### Effects

All I/O is injected through the `Effects` interface. The interpreter never does I/O directly — it calls effect functions. This makes the loop testable, portable, and embeddable in any UI.

```ts
interface Effects {
  streamChunk: (text: string) => void;          // Stream text to user
  streamDone: () => void;                       // End of stream
  toolStart: (name: string, preview: string) => void;
  toolDone: (name: string, ok: boolean, output: string) => void;
  confirm: (command: string) => Promise<boolean>;
  ask: (question: string) => Promise<string>;
  remember: (content: string) => Promise<void>;
  forget: (content: string) => Promise<void>;
  refreshSystem: () => Promise<void>;
  manageContext: (instructions: string) => Promise<string>;
  complete: (summary: string) => void;
  spawn: (task: string) => Promise<SpawnResult>;
  // ...
}
```

The `AgentLoop` class uses `createEffects()` to wire up sensible defaults (stdout streaming, readline prompts, file-backed memory), but every effect is overridable.

## Customization

### Custom tools

```ts
const agent = new AgentLoop({
  provider, model, system,
  tools: [{
    name: "SearchDocs",
    description: "Search the documentation",
    arguments: [{ name: "query", description: "Search query" }],
    execute: async (args) => {
      const results = await mySearchIndex.search(args.query);
      return JSON.stringify(results);
    },
  }],
});

// Or add tools after construction
agent.addTool({
  name: "Deploy",
  description: "Deploy the app",
  arguments: [],
  askPermission: () => "Deploy to production?",  // requires confirmation
  execute: async () => { /* ... */ return "Deployed!"; },
});
```

### Override effects

Every effect callback is optional — provide only the ones you want to customize:

```ts
const agent = new AgentLoop({
  provider, model, system,

  // Custom streaming (e.g. send to a WebSocket)
  onStream: (text) => ws.send(JSON.stringify({ type: "text", text })),

  // Custom confirmation (e.g. UI dialog)
  confirm: async (command) => showConfirmDialog(command),

  // Custom memory backend (e.g. database)
  remember: async (content) => db.insert("memories", { content }),
  forget: async (content) => db.delete("memories", { content }),

  // Custom ask (e.g. queue a question to a web UI)
  ask: async (question) => waitForUserResponse(question),
});
```

### Custom I/O

The builtin tools (ReadFile, WriteFile, Bash) use a `BuiltinIO` interface. By default it uses Node.js `fs` and `child_process`, but you can swap it out:

```ts
const agent = new AgentLoop({
  provider, model, system,
  io: {
    readFile: async (path) => myFS.read(path),
    writeFile: async (path, content) => myFS.write(path, content),
    fileExists: async (path) => myFS.exists(path),
    exec: async (command, timeoutMs) => myShell.run(command, { timeout: timeoutMs }),
  },
});
```

### Cancellation

Pass an `AbortSignal` to cancel a running agent:

```ts
const controller = new AbortController();
const agent = new AgentLoop({ provider, model, system, signal: controller.signal });

// Cancel after 30 seconds
setTimeout(() => controller.abort(), 30_000);

try {
  await agent.run("Refactor the auth module");
} catch (err) {
  if (err instanceof AbortError) console.log("Cancelled");
}
```

### Multi-turn conversation

The agent maintains conversation history across `run()` calls:

```ts
await agent.run("Read the package.json");
await agent.run("Now add a test script");
await agent.run("What did we change?");

// Reset conversation
agent.clear();
```

## Custom providers

`AgentLoop` accepts any object implementing the `AIProvider` interface:

```ts
interface AIProvider {
  readonly name: string;
  complete(config: AIRequestConfig): Promise<AIResponse>;
  stream(config: AIRequestConfig): StreamResult;
}
```

The request/response format follows the OpenAI chat completions API. The included `OpenRouterProvider` works with any model available on [OpenRouter](https://openrouter.ai).

## Low-level API

If you need full control, you can use the primitives directly instead of `AgentLoop`:

```ts
import {
  ToolRegistry, registerBuiltins, createNodeIO,
  AI, mkWorld, createEffects, run,
  Think, Invoke, Done, eval_,
} from "@ianrumac/gloop-loop";

// 1. Set up tools
const registry = new ToolRegistry();
registerBuiltins(registry, createNodeIO());

// 2. Set up conversation
const ai = new AI(provider, "anthropic/claude-sonnet-4");
const convo = ai.conversation({ model: "anthropic/claude-sonnet-4", system: "..." });

// 3. Set up effects
const effects = createEffects({ convo, registry });

// 4. Set up world
const world = mkWorld(convo, registry);

// 5. Run
await run("Hello!", world, effects);

// Or evaluate forms directly
await eval_(Think("What files are here?"), world, effects);
await eval_(Done("All done"), world, effects);
```

## Architecture

```
                    ┌─────────────┐
  User input ──────▶   parseInput  │──── Form
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │    eval_     │◄─── recursive
                    │  interpreter │───── loop
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼────┐ ┌────▼─────┐ ┌───▼────┐
        │  Effects  │ │   World  │ │ Tools  │
        │ (all I/O) │ │ (state)  │ │(registry)│
        └──────────┘ └──────────┘ └────────┘
```

- **Forms** describe what to do (pure data)
- **eval_** interprets forms recursively
- **Effects** perform all side effects (streaming, I/O, confirmation)
- **World** carries conversation state and tool registry
- **ToolRegistry** maps tool names to implementations

## License

MIT
