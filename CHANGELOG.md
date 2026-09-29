# Changelog

All notable changes to `gloop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
