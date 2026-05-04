# Changelog

All notable changes to `gloop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
