export interface ToolArgument {
  name: string;
  description: string;
  /** Leave the argument out of the JSON schema's `required` list.  Default: false. */
  optional?: boolean;
}

/** What the interpreter hands a tool alongside its arguments. */
export interface ToolContext {
  /**
   * Aborts when the turn is interrupted.  Long-running tools should stop
   * work when it fires; the interpreter stops waiting either way.
   */
  signal?: AbortSignal;
}

export interface ToolDefinition {
  name: string;
  description: string;
  arguments: ToolArgument[];
  execute: (args: Record<string, string>, ctx?: ToolContext) => Promise<string>;
  /** If provided, called before execution. Return a string to require confirmation (shown to user), or null to allow. */
  askPermission?: (args: Record<string, string>) => string | null;
  /**
   * Mark the tool as safe to run again after a failure (idempotent / read-only).
   * Only retryable tools are retried under `LoopConfig.retry.tool`.
   */
  retryable?: boolean;
  /**
   * Cap on this tool's output as the model sees it, in characters —
   * overrides `maxToolOutputChars` for this tool.  `0` disables the cap.
   */
  maxOutputChars?: number;
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
  /**
   * Set when the model's arguments were not valid JSON (e.g. a response cut
   * off by `max_tokens`).  The interpreter does not run such a call; it
   * answers it with a failed result explaining the problem.
   */
  parseError?: string;
}

export interface ToolResult {
  name: string;
  output: string;
  success: boolean;
  /** Tool call id this result answers (copied from `ToolCall.id`). */
  id?: string;
}
