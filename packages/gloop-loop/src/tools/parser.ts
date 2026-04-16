import type { ToolCall, ToolDefinition } from "./types.js";
import type { JsonToolCall } from "../ai/types.js";

/** Minimal tool lookup interface — any object with `.get(name)` will do. */
export interface ToolLookup {
  get(name: string): ToolDefinition | undefined;
}

/**
 * Convert JSON tool calls (from native tool calling) into `ToolCall` format.
 *
 * The `registry` is required because we validate the incoming JSON against
 * each tool's declared argument list.  Only declared argument names make it
 * into the resulting `ToolCall.args` record, and values are coerced to
 * strings.  Unknown tools and tools missing from the registry yield
 * `args = {}` so callers see a clean "unknown tool" result rather than
 * a misordered / mis-coerced call.
 */
export function jsonToolCallsToToolCalls(
  jsonCalls: JsonToolCall[],
  registry: ToolLookup,
): ToolCall[] {
  return jsonCalls.map((jc) => {
    const args: Record<string, string> = {};
    const tool = registry.get(jc.function.name);

    try {
      const parsed = JSON.parse(jc.function.arguments);
      if (tool && typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        for (const arg of tool.arguments) {
          const v = obj[arg.name];
          if (v !== undefined && v !== null) args[arg.name] = String(v);
        }
      }
    } catch {
      // Arguments aren't valid JSON — treat the whole string as a single
      // value bound to the tool's first declared argument, if any.  This
      // preserves the "Bash with malformed json" fallback where the raw
      // string becomes the command.
      if (jc.function.arguments && tool && tool.arguments.length > 0) {
        args[tool.arguments[0]!.name] = jc.function.arguments;
      }
    }

    return { name: jc.function.name, args };
  });
}
