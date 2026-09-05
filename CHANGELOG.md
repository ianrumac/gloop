# Changelog

All notable changes to `gloop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `bench/`: a ClawBench / HarnessBench harness for gloop. Twelve `Browser*` tools (Playwright over CDP) let gloop drive the benchmark's Chrome; `bench/install.sh` registers the harness with an installed `clawbench-eval` and can lay the adapter into a HarnessBench checkout. See `bench/README.md`.
- `OPENROUTER_BASE_URL` env var: routes gloop's OpenRouter client at an OpenAI-compatible proxy (used by the harness for non-OpenRouter models). Picks up `@hypen-space/gloop-loop` 0.2.1.

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
