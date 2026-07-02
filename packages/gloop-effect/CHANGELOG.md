# Changelog

All notable changes to `@hypen-space/gloop-effect` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.2.0]

### Breaking
- **Native tool-call conversation history** (mirrors `@hypen-space/gloop-loop` 0.2.0). Tool results are no longer fed back to the model as a synthetic `role: "user"` message wrapped in `<tool_result>` XML. When the provider supplies tool call ids, the assistant's tool calls are recorded on the assistant message (`Message.toolCalls`) and each result is recorded as a `role: "tool"` message keyed by `toolCallId`. Calls without provider ids still use the legacy user-message path.
- `ConversationHandle` gains `streamContinue` — a streaming request from the current history without appending a new user message.

### Added
- `jsonToolCallsToToolCalls` preserves the provider call `id` on each `ToolCall`, and malformed (non-JSON) argument strings now bind to the tool's first declared argument, matching gloop-loop's fallback.
- `LoopConfig.maxIterations` / `AgentMakeOptions.maxIterations` — opt-in cap on LLM calls per turn; exceeding it fails the turn with a `FatalAgentError` (phase `"interpreter"`) instead of spinning forever. Disabled by default.
- `LoopConfig.llmIdleTimeoutMs` / `AgentMakeOptions.llmIdleTimeoutMs` — idle timeout for a single LLM stream (default 120 s, 0 disables); a provider that stops producing chunks now fails the turn with an `AIProviderError` instead of hanging the whole request.

### Fixed
- Removed the dead `Object.values()` single-arg fallback in the tool-call parser — arguments are mapped strictly by key name against the tool's declared argument list.

## [0.1.0]

Initial release.
