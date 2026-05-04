# Changelog

All notable changes to `@hypen-space/gloop-loop` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [SemVer](https://semver.org/).

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
