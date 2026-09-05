# Changelog

All notable changes to `@hypen-space/gloop-loop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

## [0.2.2]

### Added
- `toolOutputRetention` / `trimmedToolOutputChars` (`AgentLoopOptions` and `LoopConfig`): deterministic, LLM-free context control. After every tool batch, all but the last N tool outputs are collapsed to their first few hundred characters plus a marker telling the model the rest was dropped. Idempotent; tool-call ids and roles are preserved so native tool-call history stays valid. Off by default. Exported helper: `trimOldToolOutputs`.

## [0.2.1]

### Added
- `OpenRouterProvider` honours `AIProviderConfig.baseUrl` (passed to the SDK as `serverURL`), so a host can point it at any OpenAI-compatible endpoint such as a local LiteLLM proxy. The field existed on the config type but was ignored.

## [0.2.0]

### Breaking
- **Native tool-call conversation history.** Tool results are no longer fed back to the model as a synthetic `role: "user"` message wrapped in `<tool_result>` XML. When the provider supplies tool call ids, the assistant's tool calls are recorded on the assistant message (`Message.toolCalls`) and each result is recorded as a `role: "tool"` message keyed by `toolCallId` — the OpenAI-compatible wire format. This fixes two long-standing failure modes: the model "forgetting" it acted after a tools-only turn (and repeating the call), and tool output degrading the model's voice by appearing user-authored. Calls without provider ids still use the legacy user-message path.
- `Message` gains `toolCalls?: JsonToolCall[]` (assistant) and `toolCallId?: string` (tool role); `MessageRole` adds `"tool"`. Hosts that render or persist history should handle the new role.
- The `think` form's `input` is now `string | null` — `null` (built via the new `Continue()` constructor) streams a continuation from history without appending a user message.

### Added
- `ToolCall.id` / `ToolResult.id` — provider tool call ids are preserved through parsing and execution so results can be correlated natively.
- `AIConversation.streamContinue()` — stream from the current history without pushing a new user message.
- `LoopConfig.maxIterations` / `AgentLoopOptions.maxIterations` — opt-in cap on LLM calls per turn; exceeding it fails the turn with `MaxIterationsError` instead of spinning forever. Disabled by default.
- `LoopConfig.llmIdleTimeoutMs` / `AgentLoopOptions.llmIdleTimeoutMs` — idle timeout for a single LLM stream (default 120 s, 0 disables); a provider that stops producing chunks now fails the turn with `LlmIdleTimeoutError` instead of hanging the whole request.
- Context pruning is tool-call-group aware: deleting an assistant `toolCalls` message also deletes its `role: "tool"` responses (and vice versa) so pruning can never produce a history the provider rejects.

### Fixed
- Tool arguments are mapped **by key name** against the tool's declared argument list — never positionally. (The `Object.values()` positional mapping shipped in 0.1.2 scrambled arguments whenever the model emitted keys out of order or omitted one; 0.1.3+ sources already mapped by name, and 0.2.0 also preserves call ids.) Downstream workarounds that rebuilt argument JSON at the provider boundary are no longer needed.

## [0.1.4]

### Added
- `Patch_file` normalizes miscounted hunk headers before calling `parsePatch`. LLMs commonly conflate "lines 1..5 of the file" with "5 hunk body lines" and emit `@@ -1,5 +1,5 @@` for a 4-line body; the new `normalizeHunkCounts` helper recounts the body and rewrites the header so the diff library no longer rejects the patch.
- `StreamResult.finishReason: Promise<FinishReason>` and `LlmCallResult.finishReason`. The real `finish_reason` from streaming chunks and the non-streaming `complete()` path is now read from the API rather than inferred from tool-call presence. Logged as a span attribute on `ai.stream`, so `debug.log` can distinguish `stop` / `length` / `content_filter` / `tool_calls`.
- Skill helpers re-exported for downstream consumers: `parseSkillMarkdown`, `findSkill`, `mergeSkillsIntoSystem`, `formatSkillsListing`, `applySkillSubstitutions`, `splitSkillArguments`, `matchSkillSlash`, `createInvokeSkillTool`, plus the `Skill` type.

### Changed
- `OpenRouterProvider.complete()` reads `choice.finishReason` from the response when present; the previous synthesized value remains only as a fallback when the API omits it.
- `OpenRouterProvider.stream()` keeps the latest non-null `finishReason` seen across chunks and resolves it once the stream terminates.

## [0.1.3]

### Breaking
- Gloop loop has improved DX for looping agent runs. Check README.md for new DX updates.
- Default tool call pruning set to 0 tool calls
- Max tokens by default set to 256k
- Remove hard memory file dependency

## [0.1.2] — prior

See git history (`packages/gloop-loop` commits up to `2da381d`) for pre-changelog development.
