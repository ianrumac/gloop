# Changelog

All notable changes to `gloop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Safety settings**, from flags, an optional per-project `.gloop/config.json`, or defaults (flag > file > default; unknown keys ignored with a debug-log note; invalid values stop startup with a message naming the flag or key). One module, `src/core/config.ts`, used by the interactive CLI, headless mode and `--task`:
  - `--max-iterations <n>` / `maxIterations` — model calls per turn; default 200 interactive, 100 headless / `--task`; `0` = unlimited. (The "safety cap" headless.ts already promised now exists.)
  - `--retries <n>` / `retries` — attempts per model call with exponential backoff; default 3; `1` = no retry.
  - `--max-tool-output <n>` / `maxToolOutput` — characters of each tool result the model sees; default 50,000; `0` = unlimited. The system prompt tells the model about the cap.
  - `--compact-at <n>` / `compactAt` — automatic compaction at this many prompt tokens; default 120,000; `0` = off. `--compaction fold|llm` / `compaction` — `fold` (default: gloop-loop's model-free `foldTurns`) or `llm`; `keepTurns` (file only). The model's own `ManageContext` call keeps using the LLM fork.
  - `--task-timeout <ms>` / `taskTimeoutMs` — kill a `--task` subagent after this long (default 30 min, `0` = none); the parent gets a failed result saying it timed out.
  - `maxTokens`, `llmIdleTimeoutMs` — file only, unset by default.
  - Subagents inherit the parent's explicitly set settings as flags (the `gloop --task …` call's own flags win), plus its provider routing and model.
- **Token usage.** The TUI shows a dim `ctx 42.1k · in 310k · out 12k` line (last request's context, session totals; restored on `--resume`). Headless `complete` / `usage` JSONL events and the final console line carry real totals instead of zeros. `runTaskSubagent` returns the child's `usage`.
- TUI notices for LLM retries and automatic compaction; `--resume` starts with `resumed session <file>, N turns`.
- Root `test`, `test:cli` and `typecheck` scripts. CI also typechecks and tests the CLI and runs gloop-effect's typecheck and tests; Bun is pinned to 1.4.4 in all workflows.

### Fixed
- **Long-running Bash is no longer reported as a failure.** A command still running after 60 s was shown to the model as `(exit code 1)`; it now sees that it is still running in the background, its PID, where its output keeps going, how to stop it, and the last lines of output.
- **Interrupt kills running work.** `Esc` / `interrupt()` kills the running Bash command's whole process group (partial output is returned) and a running `--task` subagent (SIGTERM, then SIGKILL after 3 s).
- **Clean exit.** `Ctrl+C`, SIGINT, SIGTERM and SIGHUP unmount the TUI, restore the terminal, stop the agent (interrupting the turn and flushing the session log), kill child processes tied to in-flight tool calls (commands deliberately left in the background are kept) and exit (0 for Ctrl+C in the TUI, 128 + signal otherwise); a second Ctrl+C exits at once. The launcher forwards signals to the agent, waits for it, and never mistakes a signal exit for a reboot. Headless mode does the same and writes a final `shutdown` + `usage` event.
- **Bounded shell output.** Bash output goes to temp files instead of unbounded in-memory buffers; at most 2 MiB per stream is read back (head + tail). A backgrounded command keeps writing to its log file and no longer keeps gloop's event loop alive. Subagent stdout/stderr are capped likewise. `killProcessTree` now falls back to the single process when it is not a group leader (the fallback never ran) and never throws from its escalation timer.
- **Missing API key** fails fast at startup (interactive, headless, `--task`) with a one-line hint, unless `OPENROUTER_BASE_URL` is set.
- **`gloop --task "x" && echo done`** (or `> out.txt`, `| tee`, `$(…)`) is no longer turned into a subagent spawn that silently drops the rest; only a Bash call that is solely the `gloop --task` invocation is. Model / provider / flags given in that call are now honoured.
- Denied and unknown tool calls show in the TUI as `denied by user` / errors (gloop-loop now emits their `tool_start`).
- System prompt: no more "Reload or Restart" (the tool is `Reboot`, and only with `--clone`); the custom-tool example imports `ToolDefinition` from where gloop is actually installed and mentions `execute(args, ctx)` / `ctx.signal`; "Your source code is at" names the package root.
- Root `tsc --noEmit` passes: scoped to `bin/`, `src/`, `components/`, workspace packages resolved to source via `customConditions: ["bun"]`, type errors fixed. The unused, uncompilable `src/ai/provider.ts` (superseded by gloop-loop's provider) is removed.

## [0.3.0]

### Added
- **Sessions are event logs.** Every run appends its events to `.gloop/sessions/<timestamp>.jsonl` (progress-only events filtered out) through `@hypen-space/gloop-loop` 0.3.0's event sourcing. `gloop --resume [path]` rebuilds the agent from a log (default: the newest session); a turn that was cut off mid-way is rolled back to the last turn boundary and re-run.
- `--resume` documented in `gloop --help`.
- **`gloop graph [log] [--json | --html [out]] [--no-follow]`** — show a session log as a graph. Mermaid by default, the raw turn graph as JSON, or a self-contained interactive viewer (turn graph, event causality with cross-agent hops, state scrubber). Linked subagent/parent logs are followed. The viewer is also built statically (`src/viewer/build-static.ts`, with a demo log) and deployed with the homepage to GitHub Pages at `/viewer/` by the new `Pages` workflow.
- **Task subagents are part of the graph.** `gloop --task` children spawned from a Bash call get their own session log next to the parent's (`<timestamp>-task-<id>.jsonl`), an agent id `gloop/task-<id>`, and a `--cause` pointing at the parent's `spawn_start` event (with the parent's log path). The parent's `spawn_done` records the child's agent id and log path, so both logs can be loaded and joined into one graph. Headless accepts `--session`, `--agent-id`, `--cause`.

### Changed
- Reboot (`Reboot` tool → exit 75 → relaunch) no longer snapshots the conversation into `reboot_session.json`; it flushes the session log and writes a pointer `{ reason, log }` to it. The relaunched process resumes from the same log, so nothing that happened before the reboot is lost — including tool calls, confirmations and memory ops. Pre-0.3.0 pointer files are ignored.
- `wireRebootHandler(agent, logPath, onRestart)` and `saveRebootSession(logPath, reason)` take the log path instead of a conversation.
- `OPENROUTER_BASE_URL` points gloop at any OpenAI-compatible endpoint (`OpenRouterProvider` now honours the documented `baseUrl` option). Used to run the CLI end to end against a local mock.
- `gloop --resume` never picks a spawned subagent's log (`…-task-<id>.jsonl`) as "the latest session". Subagent `--cause` is passed as JSON. Headless argument parsing lives in `src/core/cli-args.ts` (tested).
- `.gloop/sessions/` and `.gloop/reboot_session.json` are git-ignored.

## [0.2.0]

### Changed
- Picks up `@hypen-space/gloop-loop` 0.2.0 and `@hypen-space/gloop-effect` 0.2.0 — **native tool-call conversation history**. Tool results now go back to the model as `role: "tool"` messages tied to the assistant's recorded `toolCalls` instead of a synthetic user message wrapped in `<tool_result>` XML. The model no longer forgets it acted after a tools-only turn (which caused repeated tool calls), and tool output no longer reads as user-authored.
- New opt-in loop guards available on `AgentLoop` construction: `maxIterations` (cap LLM calls per turn, off by default) and `llmIdleTimeoutMs` (fail a hung provider stream, default 120 s).

## [0.1.4]

### Added
- Skills support: `.gloop/skills/*.md` and user-level skill directories are discovered at startup, surfaced in the system prompt, and invocable via `/skill-name` or the `InvokeSkill` tool.

### Fixed
- `Patch_file` no longer fails on miscounted hunk headers. Models routinely emit `@@ -1,5 +1,5 @@` for a 4-line body; a normalizer recounts the body before parsing so the underlying diff library no longer rejects the patch with the opaque "Hunk at line N contained invalid line".

### Changed
- Picks up `@hypen-space/gloop-loop` 0.1.4: the real `finish_reason` from the model is now captured end-to-end (previously synthesized from tool-call presence) and exposed on the `ai.stream` debug span.

## [0.1.3]

### Changed
- System prompt: added a `TASK COMPLETION` section pushing the model to call `CompleteTask` at end-of-task and to avoid bailing mid-investigation with prose-only replies like "Let me check…".
- Picks up new `@hypen-space/gloop-loop` defaults: auto-pruning off by default, `maxTokens` now 256k.
- Sets Opus 4.6 as default model

## Earlier

See git history (commits up to `2da381d`) for pre-changelog development.
