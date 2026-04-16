# Changelog

All notable changes to `@hypen-space/gloop-loop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [Unreleased]

### Added
- `AgentLoopOptions.maxTokens` — caps completion tokens per request. Defaults to `262_144` (256k) to prevent mid-turn truncation when the model is about to emit trailing tool calls.
- `AIConversation.setMaxTokens(n)` — apply a per-request completion cap to all `send()` / `stream()` calls on that conversation.

### Changed
- **Breaking**: `LoopConfig.contextPruneInterval` default is now `0` (auto-pruning disabled). Previously `50`. Opt in explicitly if you want periodic `ManageContext` runs.

## [0.1.2] — prior

See git history (`packages/gloop-loop` commits up to `2da381d`) for pre-changelog development.
