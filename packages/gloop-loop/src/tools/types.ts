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
}

export interface ToolCall {
  name: string;
  /**
   * Named arguments for the tool, already coerced to strings and keyed by
   * the tool's declared argument names.  The parser validates against the
   * registered `ToolDefinition.arguments` so only declared keys appear here.
   */
  args: Record<string, string>;
}

export interface ToolResult {
  name: string;
  output: string;
  success: boolean;
}
