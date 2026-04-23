/**
 * gloop-effect/Errors — Tagged errors for the agent runtime.
 *
 * Every failure reason gets its own tag so downstream handlers can branch
 * on `_tag` without parsing messages. HTTP annotations are omitted because
 * this package is transport-agnostic — add them at the RPC layer.
 */

import { Schema } from "effect"

// ============================================================================
// Provider
// ============================================================================

export class AIProviderError extends Schema.TaggedError<AIProviderError>()(
  "AIProviderError",
  {
    message: Schema.String,
    /** Which provider surface failed: "complete" or "stream". */
    op: Schema.optional(Schema.Literal("complete", "stream")),
    /** Model id at the time of failure, when available. */
    model: Schema.optional(Schema.String),
    /** Provider name (e.g. "openrouter"). */
    provider: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// ============================================================================
// Tools
// ============================================================================

export class ToolNotFoundError extends Schema.TaggedError<ToolNotFoundError>()(
  "ToolNotFoundError",
  {
    name: Schema.String,
    message: Schema.String,
  },
) {}

export class ToolExecutionError extends Schema.TaggedError<ToolExecutionError>()(
  "ToolExecutionError",
  {
    name: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class ToolPermissionDeniedError extends Schema.TaggedError<ToolPermissionDeniedError>()(
  "ToolPermissionDeniedError",
  {
    name: Schema.String,
    reason: Schema.String,
    message: Schema.String,
  },
) {}

// ============================================================================
// Agent lifecycle
// ============================================================================

export class AgentInterruptedError extends Schema.TaggedError<AgentInterruptedError>()(
  "AgentInterruptedError",
  {
    message: Schema.String,
  },
) {}

export class FatalAgentError extends Schema.TaggedError<FatalAgentError>()(
  "FatalAgentError",
  {
    message: Schema.String,
    /** Where the fatal error originated — informs the host's recovery path. */
    phase: Schema.optional(
      Schema.Literal("turn", "tool", "provider", "interpreter", "unknown"),
    ),
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// ============================================================================
// IO / Memory
// ============================================================================

export class FileIOError extends Schema.TaggedError<FileIOError>()(
  "FileIOError",
  {
    path: Schema.String,
    op: Schema.Literal("read", "write", "exists", "delete"),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class ShellExecError extends Schema.TaggedError<ShellExecError>()(
  "ShellExecError",
  {
    command: Schema.String,
    exitCode: Schema.Number,
    message: Schema.String,
    stderr: Schema.optional(Schema.String),
  },
) {}

export class MemoryError extends Schema.TaggedError<MemoryError>()(
  "MemoryError",
  {
    op: Schema.Literal("remember", "forget", "read"),
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

// ============================================================================
// Aggregate
// ============================================================================

/**
 * Union of every error the agent can raise. Useful as the error channel
 * bound for `Agent.sendSync` and downstream consumers that want a single
 * `catchTags` branch over all failure modes.
 */
export type AgentError =
  | AIProviderError
  | ToolNotFoundError
  | ToolExecutionError
  | ToolPermissionDeniedError
  | AgentInterruptedError
  | FatalAgentError
  | FileIOError
  | ShellExecError
  | MemoryError
