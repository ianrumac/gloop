import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { AgentLoop, EventLog, createJsonlEventStore, type LogEvent } from "@hypen-space/gloop-loop";
import type { AIProvider, AIRequestConfig, AIResponse, StreamResult, JsonToolCall } from "../ai/types.ts";
import { buildViewerHtml, loadLogWithLinks, parseGraphArgs } from "./graph-command.ts";

// A parent that spawns one child "process" (a second AgentLoop with its own
// JSONL log), exactly as gloop --task does — then we read both files back.
function scripted(responses: Array<{ text?: string; toolCalls?: JsonToolCall[] }>): AIProvider {
  let i = 0;
  return {
    name: "s",
    async complete(): Promise<AIResponse> { return { id: "x", model: "m", content: null, finishReason: "stop" }; },
    stream(_c: AIRequestConfig): StreamResult {
      const r = responses[i++] ?? {};
      const textStream: AsyncIterableIterator<string> = (async function* () { if (r.text) yield r.text; })();
      return { textStream, toolCalls: Promise.resolve(r.toolCalls ?? []), finishReason: Promise.resolve(r.toolCalls?.length ? "tool_calls" : "stop"), cancel: async () => {} };
    },
  };
}
const tc = (id: string, name: string, args: Record<string, string>): JsonToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const complete = { name: "CompleteTask", description: "", arguments: [{ name: "summary", description: "" }], execute: async (a: Record<string, string>) => a.summary ?? "" };
const bash = { name: "Bash", description: "", arguments: [{ name: "command", description: "" }], execute: async () => "" };

async function writeLinkedLogs(dir: string): Promise<{ parent: string; child: string }> {
  const parent = join(dir, "parent.jsonl");
  const child = join(dir, "child.jsonl");
  const agent = new AgentLoop({
    id: "gloop", model: "m", store: createJsonlEventStore(parent), tools: [bash, complete],
    provider: scripted([{ toolCalls: [tc("c1", "Bash", { command: "spawn:write docs" })] }, { text: "all done" }]),
    classifySpawn: (c) => (c.name === "Bash" && c.args.command?.startsWith("spawn:") ? c.args.command.slice(6) : null),
    spawn: async (task, call) => {
      const kid = new AgentLoop({
        id: "gloop/task-1", model: "m", store: createJsonlEventStore(child), tools: [complete],
        provider: scripted([{ toolCalls: [tc("k1", "CompleteTask", { summary: "docs written" })] }]),
      });
      await kid.sendSync(task, { cause: { ...call.cause!, log: parent } });
      await kid.stop();
      return { success: true, summary: "docs written", exitCode: 0, stdout: "", stderr: "", agent: "gloop/task-1", log: child };
    },
  });
  await agent.sendSync("get the docs written");
  await agent.stop();
  return { parent, child };
}

describe("gloop graph", () => {
  test("parseGraphArgs", () => {
    expect(parseGraphArgs([])).toEqual({ format: "mermaid", follow: true, help: false });
    expect(parseGraphArgs(["a.jsonl", "--json", "--no-follow"])).toEqual({ log: "a.jsonl", format: "json", follow: false, help: false });
    expect(parseGraphArgs(["--html", "out.html", "a.jsonl"])).toEqual({ log: "a.jsonl", format: "html", out: "out.html", follow: true, help: false });
    expect(parseGraphArgs(["--html"]).out).toBeUndefined();
  });

  test("loadLogWithLinks follows child logs from the parent and the parent from a child", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gloop-graph-"));
    try {
      const { parent, child } = await writeLinkedLogs(dir);
      const fromParent = await loadLogWithLinks(parent);
      expect(fromParent.sources).toEqual([parent, child]);
      expect(fromParent.missing).toEqual([]);
      expect(new Set(fromParent.events.map((e) => e.agent))).toEqual(new Set(["gloop", "gloop/task-1"]));

      const fromChild = await loadLogWithLinks(child);
      expect(fromChild.sources).toEqual([child, parent]);
      expect(fromChild.events.length).toBe(fromParent.events.length);

      const alone = await loadLogWithLinks(parent, false);
      expect(alone.sources).toEqual([parent]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("mermaid and viewer HTML come out of the joined logs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gloop-graph-"));
    try {
      const { parent } = await writeLinkedLogs(dir);
      const { events, sources } = await loadLogWithLinks(parent);
      const { projectGraph, graphToMermaid } = await import("@hypen-space/gloop-loop");
      const mermaid = graphToMermaid(projectGraph(events));
      expect(mermaid).toContain("gloop_msg_1 -->|spawn_start| gloop_task_1_msg_1");

      const html = await buildViewerHtml(events, sources);
      expect(html).toContain("<title>gloop log viewer</title>");
      expect(html).toContain("window.__GLOOP_EVENTS__=");
      expect(html).toContain('<script type="module">');
      expect(html).not.toContain("<!--APP-->");
      // Embedded data survives a JSON round-trip with the same event count.
      const m = /window\.__GLOOP_EVENTS__=(\[.*?\]);window\.__GLOOP_SOURCES__/s.exec(html)!;
      const embedded = JSON.parse(m[1]!.replace(/<\\\//g, "</")) as LogEvent[];
      expect(embedded.length).toBe(events.length);
      // The bundle contains the projection code, not the provider or fs.
      expect(html).not.toContain("openrouter");
      expect(html).not.toContain("node:fs");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a log with no spawns loads alone with no missing links", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gloop-graph-"));
    try {
      const path = join(dir, "solo.jsonl");
      const a = new AgentLoop({ id: "solo", model: "m", tools: [], store: createJsonlEventStore(path), provider: scripted([{ text: "hi" }]) });
      await a.sendSync("hello");
      await a.stop();
      const { events, sources, missing } = await loadLogWithLinks(path);
      expect(sources).toEqual([path]);
      expect(missing).toEqual([]);
      expect(new EventLog().size).toBe(0);
      expect(events.some((e) => e.type === "assistant_message")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
