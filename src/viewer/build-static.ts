#!/usr/bin/env bun
/**
 * Build the standalone log viewer page (no session embedded) for hosting —
 * e.g. next to the homepage on GitHub Pages.  A small demo log is embedded
 * as `window.__GLOOP_DEMO__` so visitors can click "Load demo" without a
 * session file of their own.
 *
 *   bun src/viewer/build-static.ts <out-dir>      # writes <out-dir>/index.html
 */

import { mkdir } from "fs/promises";
import { join } from "path";
import { AgentLoop, EventLog, MemoryEventStore, bridgeAgents, type LogEvent } from "@hypen-space/gloop-loop";
import { ScriptedProvider, tc, type ScriptedResponse } from "@hypen-space/gloop-loop/testing";
import { buildViewerHtml } from "../core/graph-command.ts";

// ---------------------------------------------------------------------------
// Demo log: a planner fans out to a coder and a writer; the coder spawns a
// test-runner "subprocess" with its own log; one tool call is denied.
// ---------------------------------------------------------------------------

/** Scripted provider that streams in small chunks so the demo has stream events. */
const scripted = (responses: ScriptedResponse[]) => new ScriptedProvider(responses);

const tools = {
  complete: { name: "CompleteTask", description: "", arguments: [{ name: "summary", description: "" }], execute: async (a: Record<string, string>) => a.summary ?? "" },
  read: { name: "ReadFile", description: "", arguments: [{ name: "path", description: "" }], execute: async (a: Record<string, string>) => `// contents of ${a.path}\nexport const parse = (s: string) => s.split(",");` },
  write: { name: "WriteFile", description: "", arguments: [{ name: "path", description: "" }, { name: "content", description: "" }], execute: async (a: Record<string, string>) => `wrote ${a.path}` },
  bash: { name: "Bash", description: "", arguments: [{ name: "command", description: "" }], askPermission: (a: Record<string, string>) => (a.command?.startsWith("rm") ? `Run "${a.command}"?` : null), execute: async (a: Record<string, string>) => `$ ${a.command}\nok` },
  remember: { name: "Remember", description: "", arguments: [{ name: "content", description: "" }], execute: async () => "" },
};

export async function buildDemoEvents(): Promise<LogEvent[]> {
  const shared = new EventLog({ store: new MemoryEventStore(), run: "demo" });
  const childStore = new MemoryEventStore();

  const planner = new AgentLoop({
    id: "planner", eventLog: shared, model: "demo", tools: [tools.read, tools.remember, tools.complete],
    provider: scripted([
      { text: "Let me look at the parser first.", toolCalls: [tc("p1", "ReadFile", { path: "src/parser.ts" })] },
      { text: "The parser splits on commas only. Plan: coder hardens it, writer documents it.", toolCalls: [tc("p2", "Remember", { content: "parser.ts is the CSV entry point" }), tc("p3", "CompleteTask", { summary: "Harden the CSV parser (quotes, escapes) and document the new behaviour." })] },
    ]),
  });
  const coder = new AgentLoop({
    id: "coder", eventLog: shared, model: "demo", tools: [tools.read, tools.write, tools.bash, tools.complete],
    confirm: async () => false,
    classifySpawn: (c) => (c.name === "Bash" && c.args.command?.startsWith("gloop --task") ? c.args.command.replace(/^gloop --task\s*/, "").replace(/^"|"$/g, "") : null),
    spawn: async (task, call) => {
      const childLog = new EventLog({ store: childStore, run: "demo-child" });
      const runner = new AgentLoop({
        id: "coder/task-9f2c", eventLog: childLog, model: "demo", tools: [tools.bash, tools.complete],
        provider: scripted([
          { text: "Running the suite.", toolCalls: [tc("r1", "Bash", { command: "bun test src/parser.test.ts" })] },
          { text: "", toolCalls: [tc("r2", "CompleteTask", { summary: "12 tests pass, 0 fail." })] },
        ]),
      });
      await runner.sendSync(task, { cause: { ...call.cause!, log: "sessions/2026-09-05-planner.jsonl" } });
      await runner.stop();
      return { success: true, summary: "12 tests pass, 0 fail.", exitCode: 0, stdout: "", stderr: "", agent: "coder/task-9f2c", log: "sessions/2026-09-05-planner-task-9f2c.jsonl" };
    },
    provider: scripted([
      { text: "Reading the current implementation.", toolCalls: [tc("c1", "ReadFile", { path: "src/parser.ts" })] },
      { text: "Rewriting with a small state machine for quotes and escapes.", toolCalls: [tc("c2", "WriteFile", { path: "src/parser.ts", content: "export function parse(input: string): string[][] { /* … */ }" }), tc("c3", "Bash", { command: "rm -rf dist" })] },
      { text: "Skipping the cleanup. Delegating the test run.", toolCalls: [tc("c4", "Bash", { command: 'gloop --task "run the parser test suite and report"' })] },
      { text: "Tests are green.", toolCalls: [tc("c5", "CompleteTask", { summary: "parser.ts rewritten: quoted fields, escaped quotes, CRLF. Suite passes." })] },
    ]),
  });
  const writer = new AgentLoop({
    id: "writer", eventLog: shared, model: "demo", tools: [tools.write, tools.complete],
    provider: scripted([
      { text: "Documenting the new parser behaviour.", toolCalls: [tc("w1", "WriteFile", { path: "docs/parser.md", content: "# CSV parser\n…" })] },
      { text: "", toolCalls: [tc("w2", "CompleteTask", { summary: "docs/parser.md written." })] },
    ]),
  });

  bridgeAgents(planner, coder, { on: "task_complete", map: (e) => `Implement this: ${e.summary}` });
  bridgeAgents(planner, writer, { on: "task_complete", map: (e) => `Document this: ${e.summary}` });
  coder.start();
  writer.start();
  await planner.sendSync("Our CSV parser breaks on quoted fields. Fix it and document the behaviour.");
  await Promise.all([coder.awaitIdle(), writer.awaitIdle()]);
  await Promise.all([planner.stop(), coder.stop(), writer.stop()]);

  return [...shared.events(), ...childStore.load()];
}

export async function buildStaticViewer(outDir: string): Promise<string> {
  const demo = await buildDemoEvents();
  const html = (await buildViewerHtml([], []))
    .replace("<!--DEMO-->", `<script>window.__GLOOP_DEMO__=${JSON.stringify(demo).replace(/<\//g, "<\\/")};</script>`);
  await mkdir(outDir, { recursive: true });
  const out = join(outDir, "index.html");
  await Bun.write(out, html);
  return out;
}

if (import.meta.main) {
  const outDir = process.argv[2] ?? join(process.cwd(), "lander", "dist", "viewer");
  console.log(await buildStaticViewer(outDir));
}
