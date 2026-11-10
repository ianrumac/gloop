
# gloop and gloop-loop

Gloop is a self-modifying CLI agent with self-replication and OpenRouter support.
Gloop loop is the core engine behind gloop — [read the full gloop-loop docs here](packages/gloop-loop/README.md).

## Gloop loop quick start

```bash
npm install @hypen-space/gloop-loop
# or
pnpm add @hypen-space/gloop-loop
# or
bun add @hypen-space/gloop-loop
```

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

The loop is modelled as an actor: `sendSync` auto-starts the loop, enqueues the
message, and resolves when that message's turn finishes. It is also
event-sourced: everything the agent does lands in `agent.log`, state is a fold
over that log (`agent.snapshot()`), `AgentLoop.resume({ store })` rebuilds an
agent from a persisted log, and `agent.attach(hook)` / `bridgeAgents` let you
hook other agents onto it. For pipelines, interactive UIs, typed per-event
subscriptions, and the full API reference, see the
[gloop-loop README](packages/gloop-loop/README.md).


## Gloop

Now, about gloop

> Huh? What? Self-modifying?

Well yeah - the core idea is to make a minimal harness that is as usable as modifiable.
Something like LUCA but for agents. Why? Because I've been experimenting with agents for a long time, and wanted a solid
foundation to try new things and see how they play out, but would never get to test using popular harnesses such as Claude Code, Codex or OpenClaude - things like:

- Alternative formats for tool schemas - and what shape? What size? Use git patches? marked inserts? What is better for token spend x performance?
- Hot reload with self building tools - let it build tools and reload them into the context by itself!
- Self-modification with session resuming - agent being able to modify it's own harness and restart without losing context is
- Different types of memory - maybe just a markdown file is enough for the start, but what about later? Embeddings? Graphs? Sqlite?
- Self-replication - what if you had a harness customised per project? Would it help? Be worse?

So when I got into a discussion with a friend about CLI agents and harnesses (dont even remember what about), I decided to write my own for fun (and to prove him wrong, of course).
And this ended up being gloop. While it got bootstrapped with Claude, it got refactored by Gloop itself into the version you see today (and succesfully restared after implenting, bravo gloop!).

So yeah, Gloop is a fun experiment to see how far agents harnesses can go.
It's made mostly for entertainment as much as trying out new things. 
If you find a bug (and you will), just tell it to fix itself.
And don't take it too seriously, it's just gloop.

The rest of the readme is written by Gloop. 
=======================

A recursive, Lisp-style AI agent for the terminal.

## Quickstart

```bash
gloop # Launch gloop using Grok 4.1 fast
gloop --debug # Launch gloop with debug logs
gloop [model] # Launch the agent (via bin/launcher.ts)
gloop --task "task" # launch gloop in task mode
gloop --resume # continue the most recent session from its event log
gloop graph # print the last session's turn graph as Mermaid
gloop graph --html # write a self-contained interactive log viewer next to the log
```

`OPENROUTER_API_KEY` must be set (gloop exits with a one-line hint if it isn't), unless `OPENROUTER_BASE_URL` points at another OpenAI-compatible endpoint. `gloop --help` lists everything.

### Options

| Flag | Default | |
|---|---|---|
| `--task "<task>"` | | Run one task headless, print its summary, exit. |
| `--provider <name>` | | Pin OpenRouter to one upstream provider. |
| `--clone` | | Copy gloop's source into `.gloop/src/` and run from there; enables `Reboot`. |
| `--resume [path]` | | Continue a session from its log (default: the newest). |
| `--debug` | | Debug logs to `.gloop/debug.log`. |
| `--max-iterations <n>` | 200 (100 for `--task`) | Model calls per turn before it is stopped. `0` = unlimited. |
| `--retries <n>` | 3 | Attempts per model call, with exponential backoff. `1` = no retry. |
| `--max-tool-output <n>` | 50000 | Characters of each tool result the model sees (head + tail kept). `0` = unlimited. |
| `--compact-at <x>` | `0.85` | When to compact the context automatically: a fraction of the model's context window (`0 < x <= 1`, e.g. `0.85`), an absolute token count (an integer `> 1`, e.g. `150000`), or a range `target-trigger` (`0.6-0.85`, `90000-150000`; `..` works too) — compaction fires at the trigger and brings the context down toward the target, so it settles in the range. Both ends must be the same kind. An absolute trigger above the window is clamped to 95% of it (with a notice). `0` = never. |
| `--context-window <n>` | looked up | The model's context window in tokens. By default it is looked up in the OpenRouter models list (`${OPENROUTER_BASE_URL}/models` when a base URL is set), cached per model for a day in `.gloop/models-cache.json`; if that fails (2 s timeout, never fatal) gloop assumes 128000. Subagents on the same model get the parent's figure. |
| `--compaction fold\|llm` | `fold` | How automatic compaction trims: `fold` folds old turns into short notes without a model call; `llm` has a model summarise. The model's own `ManageContext` call always uses the model. |
| `--task-timeout <ms>` | 1800000 | Kill a `--task` subagent after this long. `0` = no limit. |

Subagents started with `gloop --task` from a Bash call inherit the parent's explicitly set options (their own flags win). Only a Bash call that is *just* the `gloop --task …` invocation runs as a linked subagent; `gloop --task x && echo done` or `… > out.txt` runs as an ordinary shell command.

### `.gloop/config.json`

The same settings, per project, as JSON. Flags override the file; the file overrides the defaults. Unknown keys are ignored (noted in the debug log); an invalid value stops gloop at startup with a message naming the key.

```json
{
  "maxIterations": 300,
  "retries": 3,
  "maxToolOutput": 50000,
  "compactAt": [0.6, 0.85],
  "contextWindow": 200000,
  "compaction": "fold",
  "keepTurns": 3,
  "taskTimeoutMs": 1800000,
  "maxTokens": 16000,
  "llmIdleTimeoutMs": 120000
}
```

In the file, a `compactAt` range is a `[target, trigger]` array. `contextWindow` is usually best left unset (looked up per model). `keepTurns` (recent turns `fold` keeps whole, default 3; with a range, `fold` keeps fewer when it must to reach the target), `maxTokens` (completion cap per request, default unset — the provider's limit) and `llmIdleTimeoutMs` (fail a silent model stream, engine default 2 min, `0` disables) are file-only.

### Interactive session

The dim line above the prompt shows token usage: `ctx 42.1k/200k (21%) · in 310k · out 12k` — the size of the last request's context against the model's context window, then session totals. Retries and automatic compaction are noted inline; `--resume` starts with `resumed session <file>, N turns`.

`Esc` interrupts the current turn: a running Bash command or subagent is killed (its process group), and the loop stays alive. `Ctrl+C` (or SIGINT / SIGTERM / SIGHUP) quits: it stops the turn, kills processes tied to it, flushes the session log and exits; press it again to quit immediately. A Bash command still running after 60 s is left running in the background on purpose — the model gets its PID and log file — and survives gloop exiting.

Headless runs (`--task`, `src/core/headless.ts`) write real token totals in their `complete` and final `usage` JSONL events, and on a signal write a `shutdown` event and exit with 128 + the signal number.

Every session is an append-only event log in `.gloop/sessions/` — inputs, outputs, tool calls, memory ops, confirmations. `--resume` (or a `Reboot`) rebuilds the agent from it; a turn that was cut off is rolled back and re-run. `gloop graph` shows a log as a graph of turns across agents (including `--task` subagents, whose logs are linked and followed), and `gloop graph --html` writes an interactive viewer: turn graph, per-event causality, and a scrubber that replays the agent's state at any point. The same viewer is hosted next to the homepage at `/viewer/` — drop any session file on it.

## Forms — S-expressions as Data

Agent steps are pure **Forms** — declarative descriptions evaluated recursively:

```ts
type Form =
  | { tag: "think"; input: string }
  | { tag: "invoke"; calls: ToolCall[]; then: Form }
  | { tag: "confirm"; command: string; then: Form }
  | { tag: "ask"; question: string; then: Form }
  | { tag: "remember"; content: string; then: Form }
  | { tag: "forget"; content: string; then: Form }
  | { tag: "emit"; text: string; then: Form }
  | { tag: "reboot"; reason: string }
  | { tag: "done"; summary: string }
  | { tag: "seq"; forms: Form[] }
  | { tag: "pure"; value: any };
```

## Interpreter

Single recursive evaluator in `src/core/core.ts` (trampolined):

```ts
async function eval_(form: Form, world: World, fx: Effects): Promise<void> {
  // Pattern match → simpler Forms → terminal
}
```

Pure data → injected effects. Serializable, testable, composable.

## Architecture

```
.
├── bin/               CLI entrypoints
│   ├── launcher.ts    `gloop` binary
│   ├── shell.ts       Process execution
│   ├── index.ts       Agent entrypoint
│   └── ...
├── src/core/          Forms, eval_, memory, UI, headless, tasks
│   ├── core.ts        Interpreter
│   ├── memory.ts      Persistent notes
│   ├── ui.ts          Ink renderer
│   ├── config.ts      Safety settings: defaults, .gloop/config.json, flags
│   ├── shutdown.ts    Clean exit on Ctrl+C / signals
│   └── ...
├── src/ai/            Re-exports of gloop-loop's LLM layer
├── src/tools/         Registry, parser, builtins/tests
├── components/        React/Ink UI
├── .gloop/            Memory (.gloop/memory.md), custom tools, config.json
├── docs/              SPECIFICATION.md
└── tests              agent.test.ts, etc.
```

## Tools

Builtins: `ReadFile`, `WriteFile`, `Bash`, `AskUser`, `CompleteTask`, `Reload`, etc.

**Custom**: `.gloop/tools/MyTool.ts` → `Reload()`.

**Skills**: put `SKILL.md` in `.claude/skills/<name>/`, `.agent/skills/<name>/`, or `.gloop/skills/<name>/`. The agent gets a catalog in-system; you can run `/skills`, `/skill <name> [args]`, `/<name> [args]`, or the model can call **`InvokeSkill`**. See the **Skills** subsection in the [gloop-loop README](packages/gloop-loop/README.md).

## Memory

Persist via `<remember>note</remember>` / `<forget>note</forget>` tags → `.gloop/memory.md`.

## Features

- **Reboot**: Restart with fresh process/state.
- **Context Mgmt**: Prune history automatically.
- **Subagents**: `Bash("gloop --task \"explore\"")`.
- **TypeScript**: Full types, Zod validation.

## License

MIT
