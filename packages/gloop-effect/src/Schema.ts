/**
 * gloop-effect/Schema — Data schemas for everything that crosses a boundary.
 *
 * This module is the single source of truth for:
 *   - Branded entity IDs (MessageId, ToolCallId, RequestId, ModelId)
 *   - Conversation value types (Message, AgentMessage)
 *   - Tool data types (ToolCall, ToolResult, ToolArgument)
 *   - The `AgentEvent` discriminated union emitted by the actor
 *   - The `AgentError` union (re-exported as a Schema so events can carry
 *     typed errors over the wire)
 *
 * Service interfaces (Agent, ConversationHandle, AIProviderImpl, …) stay as
 * TypeScript interfaces — they carry methods and can't be Schemas.
 */

import { Schema } from "effect"
import {
  AIProviderError,
  AgentInterruptedError,
  FatalAgentError,
  FileIOError,
  MemoryError,
  ShellExecError,
  ToolExecutionError,
  ToolNotFoundError,
  ToolPermissionDeniedError,
} from "./Errors.js"

// ============================================================================
// Branded IDs
// ============================================================================

export const MessageId = Schema.String.pipe(Schema.brand("@gloop/MessageId"))
export type MessageId = Schema.Schema.Type<typeof MessageId>

export const ToolCallId = Schema.String.pipe(Schema.brand("@gloop/ToolCallId"))
export type ToolCallId = Schema.Schema.Type<typeof ToolCallId>

export const RequestId = Schema.String.pipe(Schema.brand("@gloop/RequestId"))
export type RequestId = Schema.Schema.Type<typeof RequestId>

export const ModelId = Schema.String.pipe(Schema.brand("@gloop/ModelId"))
export type ModelId = Schema.Schema.Type<typeof ModelId>

// ============================================================================
// Message
// ============================================================================

export const MessageRole = Schema.Literal("system", "user", "assistant")
export type MessageRole = Schema.Schema.Type<typeof MessageRole>

export const Message = Schema.Struct({
  role: MessageRole,
  content: Schema.String,
})
export type Message = Schema.Schema.Type<typeof Message>

export const AgentMessageRole = Schema.Literal("user", "system")
export type AgentMessageRole = Schema.Schema.Type<typeof AgentMessageRole>

/** Inbound message (id may be absent — the actor assigns one on enqueue). */
export const AgentMessage = Schema.Struct({
  id: Schema.optional(MessageId),
  role: AgentMessageRole,
  content: Schema.String,
})
export type AgentMessage = Schema.Schema.Type<typeof AgentMessage>

/** An enqueued message: id is always populated. */
export const EnqueuedAgentMessage = Schema.Struct({
  id: MessageId,
  role: AgentMessageRole,
  content: Schema.String,
})
export type EnqueuedAgentMessage = Schema.Schema.Type<typeof EnqueuedAgentMessage>

// ============================================================================
// Tool value types
// ============================================================================

export const ToolArgument = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
export type ToolArgument = Schema.Schema.Type<typeof ToolArgument>

export const ToolCall = Schema.Struct({
  name: Schema.String,
  args: Schema.Record({ key: Schema.String, value: Schema.String }),
})
export type ToolCall = Schema.Schema.Type<typeof ToolCall>

export const ToolResult = Schema.Struct({
  name: Schema.String,
  output: Schema.String,
  success: Schema.Boolean,
})
export type ToolResult = Schema.Schema.Type<typeof ToolResult>

// ============================================================================
// SpawnResult
// ============================================================================

export const SpawnResult = Schema.Struct({
  success: Schema.Boolean,
  summary: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
})
export type SpawnResult = Schema.Schema.Type<typeof SpawnResult>

// ============================================================================
// AgentError — re-exported as a Schema so events can carry typed errors
// ============================================================================

export const AgentErrorSchema = Schema.Union(
  AIProviderError,
  ToolNotFoundError,
  ToolExecutionError,
  ToolPermissionDeniedError,
  AgentInterruptedError,
  FatalAgentError,
  FileIOError,
  ShellExecError,
  MemoryError,
)
export type AgentErrorSchema = Schema.Schema.Type<typeof AgentErrorSchema>

// ============================================================================
// Agent events — discriminated union with `_tag`
// ============================================================================

export const TurnStartEvent = Schema.TaggedStruct("TurnStart", {
  message: EnqueuedAgentMessage,
})
export type TurnStartEvent = Schema.Schema.Type<typeof TurnStartEvent>

export const TurnEndEvent = Schema.TaggedStruct("TurnEnd", {})
export type TurnEndEvent = Schema.Schema.Type<typeof TurnEndEvent>

export const BusyEvent = Schema.TaggedStruct("Busy", {})
export type BusyEvent = Schema.Schema.Type<typeof BusyEvent>

export const IdleEvent = Schema.TaggedStruct("Idle", {})
export type IdleEvent = Schema.Schema.Type<typeof IdleEvent>

export const QueueChangedEvent = Schema.TaggedStruct("QueueChanged", {
  pending: Schema.Number,
})
export type QueueChangedEvent = Schema.Schema.Type<typeof QueueChangedEvent>

export const StreamChunkEvent = Schema.TaggedStruct("StreamChunk", {
  text: Schema.String,
})
export type StreamChunkEvent = Schema.Schema.Type<typeof StreamChunkEvent>

export const StreamDoneEvent = Schema.TaggedStruct("StreamDone", {})
export type StreamDoneEvent = Schema.Schema.Type<typeof StreamDoneEvent>

export const ToolStartEvent = Schema.TaggedStruct("ToolStart", {
  id: ToolCallId,
  name: Schema.String,
  preview: Schema.String,
})
export type ToolStartEvent = Schema.Schema.Type<typeof ToolStartEvent>

export const ToolDoneEvent = Schema.TaggedStruct("ToolDone", {
  id: ToolCallId,
  name: Schema.String,
  ok: Schema.Boolean,
  output: Schema.String,
})
export type ToolDoneEvent = Schema.Schema.Type<typeof ToolDoneEvent>

export const MemoryEvent = Schema.TaggedStruct("Memory", {
  op: Schema.Literal("remember", "forget"),
  content: Schema.String,
})
export type MemoryEvent = Schema.Schema.Type<typeof MemoryEvent>

export const SystemRefreshedEvent = Schema.TaggedStruct("SystemRefreshed", {})
export type SystemRefreshedEvent = Schema.Schema.Type<typeof SystemRefreshedEvent>

export const TaskCompleteEvent = Schema.TaggedStruct("TaskComplete", {
  summary: Schema.String,
})
export type TaskCompleteEvent = Schema.Schema.Type<typeof TaskCompleteEvent>

export const InterruptedEvent = Schema.TaggedStruct("Interrupted", {})
export type InterruptedEvent = Schema.Schema.Type<typeof InterruptedEvent>

export const ErrorEvent = Schema.TaggedStruct("Error", {
  error: AgentErrorSchema,
})
export type ErrorEvent = Schema.Schema.Type<typeof ErrorEvent>

export const FatalEvent = Schema.TaggedStruct("Fatal", {
  error: AgentErrorSchema,
})
export type FatalEvent = Schema.Schema.Type<typeof FatalEvent>

export const ConfirmRequestEvent = Schema.TaggedStruct("ConfirmRequest", {
  id: RequestId,
  command: Schema.String,
})
export type ConfirmRequestEvent = Schema.Schema.Type<typeof ConfirmRequestEvent>

export const AskRequestEvent = Schema.TaggedStruct("AskRequest", {
  id: RequestId,
  question: Schema.String,
})
export type AskRequestEvent = Schema.Schema.Type<typeof AskRequestEvent>

export const AgentEvent = Schema.Union(
  TurnStartEvent,
  TurnEndEvent,
  BusyEvent,
  IdleEvent,
  QueueChangedEvent,
  StreamChunkEvent,
  StreamDoneEvent,
  ToolStartEvent,
  ToolDoneEvent,
  MemoryEvent,
  SystemRefreshedEvent,
  TaskCompleteEvent,
  InterruptedEvent,
  ErrorEvent,
  FatalEvent,
  ConfirmRequestEvent,
  AskRequestEvent,
)
export type AgentEvent = Schema.Schema.Type<typeof AgentEvent>

export type AgentEventOf<T extends AgentEvent["_tag"]> = Extract<
  AgentEvent,
  { _tag: T }
>

// ============================================================================
// Agent config
// ============================================================================

export const AgentConfig = Schema.Struct({
  model: ModelId,
  system: Schema.optional(Schema.String),
  maxTokens: Schema.optional(Schema.Number),
  contextPruneInterval: Schema.optional(Schema.Number),
})
export type AgentConfig = Schema.Schema.Type<typeof AgentConfig>
