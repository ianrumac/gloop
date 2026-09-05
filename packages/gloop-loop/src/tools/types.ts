export interface ToolArgument {
  name: string;
  description: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  arguments: ToolArgument[];
  execute: (args: Record<string, string>) => Promise<string>;
  /** If provided, called before execution. Return a string to require confirmation (shown to user), or null to allow. */
  askPermission?: (args: Record<string, string>) => string | null;
  /**
   * Mark the tool as safe to run again after a failure (idempotent / read-only).
   * Only retryable tools are retried under `LoopConfig.retry.tool`.
   */
  retryable?: boolean;
}

export interface ToolCall {
  name: string;
  /**
   * Named arguments for the tool, already coerced to strings and keyed by
   * the tool's declared argument names.  The parser validates against the
   * registered `ToolDefinition.arguments` so only declared keys appear here.
   */
  args: Record<string, string>;
  /**
   * Provider-assigned tool call id (from `JsonToolCall.id`).  When present,
   * the interpreter records the call and its result natively in conversation
   * history (assistant `toolCalls` + a `role: "tool"` response message).
   */
  id?: string;
}

export interface ToolResult {
  name: string;
  output: string;
  success: boolean;
  /** Tool call id this result answers (copied from `ToolCall.id`). */
  id?: string;
}
