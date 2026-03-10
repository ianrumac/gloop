import type { ToolCall } from "./types.js";
import type { JsonToolCall } from "../ai/types.js";

/**
 * Convert JSON tool calls (from native tool calling) into ToolCall format.
 * Maps JSON arguments (key-value pairs) to positional rawArgs (values in key order).
 */
export function jsonToolCallsToToolCalls(jsonCalls: JsonToolCall[]): ToolCall[] {
  return jsonCalls.map((jc) => {
    const rawArgs: string[] = [];
    try {
      const parsed = JSON.parse(jc.function.arguments);
      if (typeof parsed === "object" && parsed !== null) {
        for (const value of Object.values(parsed)) {
          rawArgs.push(String(value));
        }
      }
    } catch {
      // If arguments aren't valid JSON, treat whole string as single arg
      if (jc.function.arguments) {
        rawArgs.push(jc.function.arguments);
      }
    }

    return {
      name: jc.function.name,
      rawArgs,
    };
  });
}
