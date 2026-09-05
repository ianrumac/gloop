/**
 * Scripted mock provider shared by the event-sourcing test suites.
 *
 * Each entry in `responses` is consumed by one `stream()` call, in order.
 * An entry can stream text (in 10-char chunks, optionally delayed), return
 * tool calls, or fail — either before the first chunk (`failBefore`) or after
 * `failAfterChunks` chunks (to exercise "already streamed" paths).
 */

import type {
  AIProvider,
  AIRequestConfig,
  AIResponse,
  StreamResult,
  JsonToolCall,
} from "../src/ai/types.js";

export interface Scripted {
  text?: string;
  toolCalls?: JsonToolCall[];
  delayMs?: number;
  failBefore?: Error;
  failAfterChunks?: number;
}

export class ScriptedProvider implements AIProvider {
  readonly name = "scripted";
  readonly calls: AIRequestConfig[] = [];
  private index = 0;

  constructor(private readonly responses: Scripted[]) {}

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

export function tc(id: string, name: string, args: Record<string, string>): JsonToolCall {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** A tool call WITHOUT a provider id — exercises the legacy result path. */
export function tcNoId(name: string, args: Record<string, string>): JsonToolCall {
  return { id: "", type: "function", function: { name, arguments: JSON.stringify(args) } };
}

export const echoTool = {
  name: "Echo",
  description: "echo",
  arguments: [{ name: "text", description: "t" }],
  execute: async (a: Record<string, string>) => `echo:${a.text ?? ""}`,
};

export const completeTool = {
  name: "CompleteTask",
  description: "done",
  arguments: [{ name: "summary", description: "s" }],
  execute: async (a: Record<string, string>) => a.summary ?? "",
};

export const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
