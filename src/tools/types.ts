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
  rawArgs: string[];
}

export interface ToolResult {
  name: string;
  output: string;
  success: boolean;
}

export interface ParsedResponse {
  toolCalls: ToolCall[];
  remembers: string[];
  forgets: string[];
  cleanText: string;
}
