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
 * a misordered / mis-coerced call.  Arguments that are not valid JSON
 * yield `args = {}` and `parseError` (the call must not be executed).
 */
export function jsonToolCallsToToolCalls(
  jsonCalls: JsonToolCall[],
  registry: ToolLookup,
): ToolCall[] {
  return jsonCalls.map((jc) => {
    const args: Record<string, string> = {};
    const tool = registry.get(jc.function.name);
    const raw = jc.function.arguments ?? "";
    let parseError: string | undefined;

    // An empty string is how many providers spell "no arguments".
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        if (tool && typeof parsed === "object" && parsed !== null) {
          const obj = parsed as Record<string, unknown>;
          for (const arg of tool.arguments) {
            const v = obj[arg.name];
            if (v !== undefined && v !== null) args[arg.name] = String(v);
          }
        }
      } catch (err) {
        // Never guess: a response truncated mid-arguments could otherwise
        // run half a JSON object as a shell command.  The interpreter
        // answers a malformed call with an error instead of executing it.
        parseError = err instanceof Error ? err.message : String(err);
      }
    }

    return {
      name: jc.function.name,
      args,
      ...(jc.id && { id: jc.id }),
      ...(parseError !== undefined && { parseError }),
    };
  });
}
