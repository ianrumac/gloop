/**
 * OpenRouterProvider against a local OpenAI-compatible SSE server — no API
 * key needed.  Exercises `baseUrl`, the streaming text path, tool-call delta
 * accumulation, finish_reason capture, and the non-streaming `complete()`.
 */

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { OpenRouterProvider } from "../src/ai/provider.js";
import { AgentLoop } from "../src/agent.js";
import { LlmIdleTimeoutError } from "../src/core/core.js";
import { echoTool } from "./mock-provider.js";

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
const seen: Array<{ path: string; stream: boolean; model: string; tools: number; auth: string | null; body: Record<string, unknown> }> = [];

const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
  `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = (await req.json()) as { stream?: boolean; model: string; tools?: unknown[]; messages: Array<{ content: string }> };
      seen.push({ path: url.pathname, stream: !!body.stream, model: body.model, tools: body.tools?.length ?? 0, auth: req.headers.get("authorization"), body });
      const prompt = body.messages.at(-1)!.content;
      // A server that accepts the request and never answers.
      if (prompt === "hang") return new Promise<Response>(() => {});
      // Only tool-call argument deltas, spaced out — an active stream with no text.
      if (prompt === "slow-tools") {
        const enc = new TextEncoder();
        return new Response(new ReadableStream({
          async start(c) {
            c.enqueue(enc.encode(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Echo", arguments: '{"text":"' } }] })));
            for (let i = 0; i < 8; i++) {
              await Bun.sleep(60);
              c.enqueue(enc.encode(chunk({ tool_calls: [{ index: 0, function: { arguments: "a" } }] })));
            }
            c.enqueue(enc.encode(chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }, "tool_calls") + "data: [DONE]\n\n"));
            c.close();
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
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
        : chunk({ content: "hel" }) + chunk({ content: "lo" }) + chunk({}, "stop") +
          // Final usage-only chunk, as OpenAI-compatible servers send with include_usage.
          `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 1, model: "m", choices: [], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13, prompt_tokens_details: { cached_tokens: 5 } } })}\n\n`;
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

  test("stream() resolves usage from the final chunk and asks for it", async () => {
    const p = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const s = p.stream({ model: "m", messages: [{ role: "user", content: "text" }] });
    for await (const _ of s.textStream) { /* drain */ }
    expect(await s.usage).toEqual({ promptTokens: 11, completionTokens: 2, totalTokens: 13, cachedTokens: 5 });
    expect(seen.at(-1)!.body.stream_options).toEqual({ include_usage: true });
  });

  test('stream() yields "" heartbeats for chunks without text (tool-call deltas)', async () => {
    const p = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const s = p.stream({ model: "m", messages: [{ role: "user", content: "tools" }] });
    const values: string[] = [];
    for await (const t of s.textStream) values.push(t);
    expect(values).toEqual(["Calling ", "", "", "", ""]);
  });

  test("stop and seed are forwarded; max_tokens only when set", async () => {
    const p = new OpenRouterProvider({ apiKey: "k", baseUrl });
    await p.complete({ model: "m", messages: [{ role: "user", content: "hi" }], stop: ["END"], seed: 42 });
    expect(seen.at(-1)!.body.stop).toEqual(["END"]);
    expect(seen.at(-1)!.body.seed).toBe(42);
    expect(seen.at(-1)!.body.max_tokens).toBeUndefined();
  });

  test("cancel() never blocks on a server that never answers, and settles the side promises", async () => {
    const p = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const s = p.stream({ model: "m", messages: [{ role: "user", content: "hang" }] });
    const next = s.textStream.next().then(() => "resolved", (e: Error) => `rejected:${e.name}`);
    await Bun.sleep(50);
    const t0 = Date.now();
    await s.cancel();
    expect(Date.now() - t0).toBeLessThan(100);
    expect(await next).toStartWith("rejected");
    expect(await s.toolCalls).toEqual([]);
    expect(await s.finishReason).toBeNull();
    expect(await s.usage).toBeUndefined();
  });

  test("complete() honours AIRequestConfig.signal", async () => {
    const p = new OpenRouterProvider({ apiKey: "k", baseUrl });
    const ac = new AbortController();
    const pending = p.complete({ model: "m", messages: [{ role: "user", content: "hang" }], signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    await expect(pending).rejects.toBeDefined();
  });
});

describe("AgentLoop over OpenRouterProvider — idle timeout and interrupt", () => {
  test("a long run of tool-call deltas does not trip the idle timeout", async () => {
    const agent = new AgentLoop({
      provider: new OpenRouterProvider({ apiKey: "k", baseUrl }),
      model: "m", tools: [echoTool], llmIdleTimeoutMs: 200, maxIterations: 1,
    });
    const echoed: string[] = [];
    agent.on("tool_done", (e) => echoed.push(e.name));
    // maxIterations: 1 stops the turn right after the tool ran.
    await agent.sendSync("slow-tools").catch(() => {});
    expect(echoed).toEqual(["Echo"]);
    await agent.stop();
  });

  test("the idle timeout fires against a server that never answers", async () => {
    const agent = new AgentLoop({
      provider: new OpenRouterProvider({ apiKey: "k", baseUrl }),
      model: "m", tools: [], llmIdleTimeoutMs: 150,
    });
    const t0 = Date.now();
    await expect(agent.sendSync("hang")).rejects.toBeInstanceOf(LlmIdleTimeoutError);
    expect(Date.now() - t0).toBeLessThan(1000);
    await agent.stop();
  });

  test("interrupt() unwinds a request the server never answers", async () => {
    const agent = new AgentLoop({
      provider: new OpenRouterProvider({ apiKey: "k", baseUrl }),
      model: "m", tools: [], llmIdleTimeoutMs: 0,
    });
    const p = agent.sendSync("hang").catch((e: Error) => e.name);
    await Bun.sleep(50);
    agent.interrupt();
    expect(await p).toBe("AbortError");
    await agent.stop();
  });
});
