import type { ToolCall } from "./types.js";

/** Patterns that require user confirmation before execution */
const DANGEROUS_PATTERNS = [
  /\brm\b/,
  /\brmdir\b/,
  /\brm\s+-rf?\b/,
  /\brm\s+-fr?\b/,
];

/**
 * Check whether a tool call requires user confirmation.
 * Returns a description of the danger if confirmation is needed, or null if safe.
 */
export function requiresConfirmation(call: ToolCall): string | null {
  if (call.name !== "Bash") return null;

  const command = call.args.command ?? "";
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return command;
    }
  }
  return null;
}
