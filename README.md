
# gloop

Gloop is a self-modifying CLI agent with self-replication and OpenRouter support.

> Huh? What? Self-modifying?

Well yeah - the core idea is to make a minimal harness that is as usable as modifiable.
Something like LUCA but for agents. Why? Because I've been experimenting with agents for a long time, and wanted a solid
foundation to try new things and see how they play out, but would never get to test using popular harnesses such as Claude Code, Codex or OpenClaude - things like:

- XML instead of JSON Schema for tool calls - and what shape? What size? Use git patches? marked inserts? What is better for token spend x performance?
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
```

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
│   └── ...
├── src/ai/            LLM abstraction (OpenRouter, etc.)
├── src/tools/         Registry, parser, builtins/tests
├── components/        React/Ink UI
├── .gloop/            Memory (.gloop/memory.md), custom tools
├── docs/              SPECIFICATION.md
└── tests              agent.test.ts, etc.
```

## Tools

Builtins: `ReadFile`, `WriteFile`, `Bash`, `AskUser`, `CompleteTask`, `Reload`, etc.

**Custom**: `.gloop/tools/MyTool.ts` → `Reload()`.

## Memory

Persist via `<remember>note</remember>` / `<forget>note</forget>` tags → `.gloop/memory.md`.

## Features

- **Reboot**: Restart with fresh process/state.
- **Context Mgmt**: Prune history automatically.
- **Subagents**: `Bash("gloop --task \"explore\"")`.
- **TypeScript**: Full types, Zod validation.

## License

MIT
