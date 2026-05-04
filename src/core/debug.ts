import { join } from "path";
import { appendFileSync, writeFileSync } from "fs";
import {
  ConsoleTracer,
  type Interceptor,
  type Tracer,
} from "@hypen-space/gloop-loop";

const LOG_PATH = join(process.cwd(), ".gloop", "debug.log");

let enabled = false;

export function enableDebug(): void {
  enabled = true;
  // Start fresh each session
  writeFileSync(LOG_PATH, `=== gloop debug log — ${new Date().toISOString()} ===\n\n`);
}

export function isDebug(): boolean {
  return enabled;
}

const HEAD_TAIL_LENGTH = 200;
const MAX_CONTENT_LENGTH = HEAD_TAIL_LENGTH * 2;

export function debugLog(label: string, content: string): void {
  if (!enabled) return;
  const timestamp = new Date().toISOString();
  const truncated = content.length > MAX_CONTENT_LENGTH
    ? content.substring(0, HEAD_TAIL_LENGTH) +
      `\n... (truncated, ${content.length} chars total) ...\n` +
      content.substring(content.length - HEAD_TAIL_LENGTH)
    : content;
  const entry = `--- [${timestamp}] ${label} ---\n${truncated}\n\n`;
  appendFileSync(LOG_PATH, entry);
}

export function debugLogRaw(label: string, content: string): void {
  if (!enabled) return;
  const timestamp = new Date().toISOString();
  const entry = `--- [${timestamp}] ${label} ---\n${content}\n\n`;
  appendFileSync(LOG_PATH, entry);
}

// ============================================================================
// Tracer + interceptor wired by `--debug`
// ============================================================================
//
// `bin/index.ts` constructs the AgentLoop with these so a single `--debug`
// flag produces:
//   - the full span tree per turn (durations, attributes), via FileTracer
//   - structured boundary payloads (LLM input/output, tool args/results,
//     confirm/ask round-trips, memory ops, spawns), via debugInterceptor()
// Both write to `.gloop/debug.log` alongside the existing `debugLog` /
// `debugLogRaw` entries.

const TREE_HEADER = "--- [SPAN TREE] ---\n";

/**
 * `Tracer` that appends an indented duration tree to the debug log.
 * Returns `undefined` when debug is off so callers can pass it directly.
 */
export function debugTracer(): Tracer | undefined {
  if (!enabled) return undefined;
  let pendingHeader = true;
  return new ConsoleTracer({
    sink: (line) => {
      // Group consecutive sink writes under a single TREE header so
      // turns are visually distinct in the file.
      if (pendingHeader) {
        appendFileSync(LOG_PATH, TREE_HEADER);
        pendingHeader = false;
      }
      appendFileSync(LOG_PATH, line + "\n");
      // Re-arm the header on the root span (no leading indent + agent.turn).
      if (line.startsWith("agent.turn")) {
        appendFileSync(LOG_PATH, "\n");
        pendingHeader = true;
      }
    },
    showEvents: true,
  });
}

const stamp = (start: number) => `${Date.now() - start}ms`;

const truncate = (s: string, max = MAX_CONTENT_LENGTH): string =>
  s.length > max
    ? s.substring(0, HEAD_TAIL_LENGTH) +
      `\n... (truncated, ${s.length} chars total) ...\n` +
      s.substring(s.length - HEAD_TAIL_LENGTH)
    : s;

/**
 * Interceptor that records every boundary (LLM, tool, confirm, ask, memory,
 * spawn) into the debug log with timings and full payloads.  Returns
 * `undefined` when debug is off.
 */
export function debugInterceptor(): Interceptor | undefined {
  if (!enabled) return undefined;
  return {
    name: "gloop-debug",
    llmCall: async (ctx, next) => {
      const start = Date.now();
      debugLog(
        "LLM_REQUEST",
        `model=${ctx.model} historyLength=${ctx.messages.length} toolCount=${ctx.tools.length}\n${truncate(ctx.input)}`,
      );
      try {
        const result = await next(ctx);
        debugLog(
          "LLM_RESPONSE",
          `duration=${stamp(start)} textLength=${result.text.length} toolCallsRequested=${result.toolCalls.length}\n${truncate(result.text)}`,
        );
        if (result.toolCalls.length > 0) {
          debugLog(
            "TOOL_CALLS",
            result.toolCalls
              .map((tc) => `${tc.function.name}(${tc.function.arguments})`)
              .join("\n"),
          );
        }
        return result;
      } catch (err) {
        debugLog(
          "LLM_ERROR",
          `${stamp(start)}: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
    },
    toolCall: async (ctx, next) => {
      const start = Date.now();
      debugLog("TOOL_REQUEST", `${ctx.name}\n${JSON.stringify(ctx.args, null, 2)}`);
      const result = await next(ctx);
      debugLog(
        "TOOL_RESPONSE",
        `${ctx.name} (${stamp(start)}) ok=${result.success}\n${truncate(result.output)}`,
      );
      return result;
    },
    confirm: async (ctx, next) => {
      const start = Date.now();
      debugLog("CONFIRM_REQUEST", ctx.command);
      const ok = await next(ctx);
      debugLog("CONFIRM_RESPONSE", `${stamp(start)} approved=${ok}`);
      return ok;
    },
    ask: async (ctx, next) => {
      const start = Date.now();
      debugLog("ASK_REQUEST", ctx.question);
      const answer = await next(ctx);
      debugLog("ASK_RESPONSE", `${stamp(start)}\n${truncate(answer)}`);
      return answer;
    },
    memory: async (ctx, next) => {
      debugLog(`MEMORY_${ctx.op.toUpperCase()}`, ctx.content);
      await next(ctx);
    },
    spawn: async (ctx, next) => {
      const start = Date.now();
      debugLog("SPAWN_REQUEST", ctx.task);
      const result = await next(ctx);
      debugLog(
        "SPAWN_RESPONSE",
        `${stamp(start)} exit=${result.exitCode} ok=${result.success}\n${truncate(result.summary)}`,
      );
      return result;
    },
  };
}
