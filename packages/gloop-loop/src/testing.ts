/**
 * @hypen-space/gloop-loop/testing — a scripted provider and small tool
 * doubles for driving an `AgentLoop` without a model.  Used by this
 * package's own tests, the gloop CLI's tests, and the viewer demo.
 *
 * Each entry in `responses` is consumed by one `stream()` / `complete()`
 * call, in order.  An entry can stream text (in 10-char chunks, optionally
 * delayed), return tool calls, or fail — before the first chunk
 * (`failBefore`) or after `failAfterChunks` chunks.
 */

import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  JsonToolCall,
} from "./ai/types.js";
import type { ToolDefinition } from "./tools/types.js";

export interface ScriptedResponse {
  text?: string;
  toolCalls?: JsonToolCall[];
  delayMs?: number;
  failBefore?: Error;
  failAfterChunks?: number;
}

export class ScriptedProvider implements AIProvider {
  readonly name = "scripted";
  /** Every request received, in order. */
  readonly calls: AIRequestConfig[] = [];
  private index = 0;

  constructor(private readonly responses: ScriptedResponse[]) {}

  async complete(config: AIRequestConfig): Promise<AIResponse> {
    this.calls.push(config);
    const resp = this.responses[this.index++] ?? {};
    if (resp.failBefore) throw resp.failBefore;
    return {
      id: "scripted",
      model: config.model,
      content: resp.text ?? null,
      finishReason: resp.toolCalls?.length ? "tool_calls" : "stop",
      ...(resp.toolCalls && { toolCalls: resp.toolCalls }),
    };
  }

  stream(config: AIRequestConfig): StreamResult {
    this.calls.push(config);
    const resp = this.responses[this.index++] ?? {};
    const text = resp.text ?? "";
    const delayMs = resp.delayMs ?? 0;
    const failAfter = resp.failAfterChunks;
    const failBefore = resp.failBefore;

    const textStream: AsyncIterableIterator<string> = (async function* () {
      if (failBefore) throw failBefore;
      let chunks = 0;
      for (let i = 0; i < text.length; i += 10) {
        if (failAfter !== undefined && chunks >= failAfter) {
          throw new Error(`stream failed after ${chunks} chunks`);
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        chunks += 1;
        yield text.slice(i, i + 10);
      }
    })();

    return {
      textStream,
      toolCalls: Promise.resolve(resp.toolCalls ?? []),
      finishReason: Promise.resolve(resp.toolCalls?.length ? "tool_calls" : "stop"),
      cancel: async () => {},
    };
  }
}

/** A native (id-bearing) tool call as a model would return it. */
export function tc(id: string, name: string, args: Record<string, string>): JsonToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** A tool call WITHOUT a provider id — exercises the legacy result path. */
export function tcNoId(name: string, args: Record<string, string>): JsonToolCall {
  return { id: "", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** `Echo(text)` → `echo:<text>` */
export const echoTool: ToolDefinition = {
  name: "Echo",
  description: "echo",
  arguments: [{ name: "text", description: "t" }],
  execute: async (a) => `echo:${a.text ?? ""}`,
};

/** `CompleteTask(summary)` — the terminal tool the interpreter recognises. */
export const completeTool: ToolDefinition = {
  name: "CompleteTask",
  description: "done",
  arguments: [{ name: "summary", description: "s" }],
  execute: async (a) => a.summary ?? "",
};

/** `Bash(command)` that returns its command — pair with `classifySpawn` to exercise spawns. */
export const bashTool: ToolDefinition = {
  name: "Bash",
  description: "bash",
  arguments: [{ name: "command", description: "c" }],
  execute: async (a) => `$ ${a.command ?? ""}`,
};

/** `classifySpawn` that treats `Bash("spawn:<task>")` as a subagent task. */
export function spawnPrefixClassifier(call: { name: string; args: Record<string, string> }): string | null {
  const cmd = call.args.command ?? "";
  return call.name === "Bash" && cmd.startsWith("spawn:") ? cmd.slice(6) : null;
}

/** Yield to the event loop once. */
export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
