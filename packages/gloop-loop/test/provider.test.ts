/**
 * OpenRouterProvider against a local OpenAI-compatible SSE server — no API
 * key needed.  Exercises `baseUrl`, the streaming text path, tool-call delta
 * accumulation, finish_reason capture, and the non-streaming `complete()`.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { OpenRouterProvider } from "../src/ai/provider.js";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const seen: Array<{ path: string; stream: boolean; model: string; tools: number; auth: string | null }> = [];

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json()) as { stream?: boolean; model: string; tools?: unknown[]; messages: Array<{ content: string }> };
      seen.push({ path: url.pathname, stream: !!body.stream, model: body.model, tools: body.tools?.length ?? 0, auth: req.headers.get("authorization") });
      const prompt = body.messages.at(-1)!.content;
      if (!body.stream) {
        return Response.json({
          id: "c1", object: "chat.completion", created: 1, model: "m",
          choices: [{ index: 0, message: { role: "assistant", content: `echo:${prompt}`, refusal: null }, finish_reason: "stop", logprobs: null }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      }
      const sse = prompt === "tools"
        ? chunk({ content: "Calling " }) +
          chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Read", arguments: '{"pa' } }] }) +
          chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }) +
          chunk({ tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "Echo", arguments: "{}" } }] }) +
          chunk({}, "tool_calls")
        : chunk({ content: "hel" }) + chunk({ content: "lo" }) + chunk({}, "stop");
      return new Response(sse + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}/api/v1`;
});
afterAll(() => server.stop(true));

describe("OpenRouterProvider (local server)", () => {
  test("baseUrl routes requests to <baseUrl>/chat/completions with the key as bearer", async () => {
    const p = new OpenRouterProvider({ apiKey: "test-key", baseUrl });
    const r = await p.complete({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(r.content).toBe("echo:hi");
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    const req = seen.at(-1)!;
    expect(req.path).toBe("/api/v1/chat/completions");
    expect(req.stream).toBe(false);
    expect(req.auth).toBe("Bearer test-key");
  });

  test("stream() yields text chunks and resolves finishReason", async () => {
    const p = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const s = p.stream({ model: "m", messages: [{ role: "user", content: "text" }] });
    let out = "";
    for await (const t of s.textStream) out += t;
    expect(out).toBe("hello");
    expect(await s.toolCalls).toEqual([]);
    expect(await s.finishReason).toBe("stop");
    expect(seen.at(-1)!.stream).toBe(true);
  });

  test("stream() accumulates tool-call deltas across chunks and indexes", async () => {
    const p = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const s = p.stream({
      model: "m",
      messages: [{ role: "user", content: "tools" }],
      tools: [{ type: "function", function: { name: "Read", description: "", parameters: { type: "object", properties: {} } } }],
    });
    let out = "";
    for await (const t of s.textStream) out += t;
    expect(out).toBe("Calling ");
    expect(await s.toolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "Read", arguments: '{"path":"a.txt"}' } },
      { id: "call_2", type: "function", function: { name: "Echo", arguments: "{}" } },
    ]);
    expect(await s.finishReason).toBe("tool_calls");
    expect(seen.at(-1)!.tools).toBe(1);
  });
});
