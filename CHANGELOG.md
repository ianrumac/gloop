# Changelog

All notable changes to `gloop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.3]

### Changed
- System prompt: added a `TASK COMPLETION` section pushing the model to call `CompleteTask` at end-of-task and to avoid bailing mid-investigation with prose-only replies like "Let me check…".
- Picks up new `@hypen-space/gloop-loop` defaults: auto-pruning off by default, `maxTokens` now 256k.
- Sets Opus 4.6 as default model

## Earlier

See git history (commits up to `2da381d`) for pre-changelog development.
