#!/usr/bin/env bun
/**
 * gloop headless — Non-interactive mode for benchmarks & CI
 *
 * Usage: bun headless.ts --model <provider/model> --output <path> "<instruction>"
 *
 * Auto-approves all tools, writes structured JSONL events to --output,
 * and exits when the agent calls CompleteTask (or hits the safety cap).
 */

import { OpenRouterProvider } from "@hypen-space/gloop-loop";
import { registerBuiltins } from "../tools/index.ts";
import { ensureGloopDir, appendMemory, removeMemory } from "./memory.ts";
import { buildSystemPrompt } from "./system.ts";
import { enableDebug, debugLog, debugLogRaw } from "./debug.ts";
import {
  loadRebootSession,
  rebootIsFatal,
  wireRebootHandler,
} from "./session.ts";
import { AgentLoop, type AgentEvent } from "./core.ts";
import { appendFileSync } from "fs";
import {
  appendTaskPromptSuffix,
  parseGloopTaskBashCommand,
  runTaskSubagent,
} from "./task-mode.ts";
import { installTool } from "../../bin/install-tool.ts";
import { DEFAULT_GLOOP_MODEL } from "./default-model.ts";

// ============================================================================
// CLI PARSING
// ============================================================================

function usage(): never {
  console.error(
    'Usage: bun headless.ts --model <provider/model> [--provider <name>] [--output <path>] [--debug] [--task "<task>"] "<instruction>"',
  );
  process.exit(1);
}

const args = process.argv.slice(2);

let model = DEFAULT_GLOOP_MODEL;
let outputPath = "gloop-output.jsonl";
let debug = false;
let providerName: string | undefined;
let clone = false;
let instruction = "";

for (let i = 0; i < args.length; i++) {
  const arg = args[i]!;
  if (arg === "--model" && i + 1 < args.length) {
    model = args[++i]!;
  } else if (arg === "--output" && i + 1 < args.length) {
    outputPath = args[++i]!;
  } else if (arg === "--provider" && i + 1 < args.length) {
    providerName = args[++i]!;
  } else if (arg === "--clone") {
    clone = true;
  } else if (arg === "--debug") {
    debug = true;
  } else if (arg === "--task" && i + 1 < args.length) {
    instruction = appendTaskPromptSuffix(args[++i]!);
  } else if (arg.startsWith("--task=")) {
    instruction = appendTaskPromptSuffix(arg.slice("--task=".length));
  } else if (!arg.startsWith("--")) {
    instruction = arg;
  }
}

if (!instruction) usage();

// ============================================================================
// JSONL LOGGER
// ============================================================================

function logEvent(event: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: Date.now(), ...event });
  appendFileSync(outputPath, line + "\n");
}

// ============================================================================
// SETUP
// ============================================================================

if (debug) enableDebug();

await ensureGloopDir();

let systemPrompt = await buildSystemPrompt({ clone });
debugLog("SYSTEM", systemPrompt);

const rebootSession = await loadRebootSession();

// ============================================================================
// BUILD THE ACTOR
// ============================================================================

const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
});

const agent: AgentLoop = new AgentLoop({
  provider,
  model,
  system: systemPrompt,
  // Start empty; we register builtins into the actor's registry below so
  // Reload/installTool see the same registry the loop uses.
  tools: [],
  log: debug ? (label, content) => debugLogRaw(label, content) : undefined,
  // A RebootError stops the loop and fires a `fatal` event — see
  // wireRebootHandler below.
  isFatal: rebootIsFatal,

  // Spawn classifier: detect `gloop --task "..."` in Bash calls.
  classifySpawn: (call) => {
    if (call.name !== "Bash") return null;
    const req = parseGloopTaskBashCommand(call.args.command ?? "");
    return req ? req.task : null;
  },

  // Non-interactive: auto-approve everything.  No UI dialogs.
  confirm: async () => true,
  ask: async () => "Please proceed with your best judgment.",

  remember: async (content) => {
    await appendMemory(content);
    debugLog("REMEMBER", content);
  },
  forget: async (content) => {
    await removeMemory(content);
    debugLog("FORGET", content);
  },

  refreshSystem: async () => {
    systemPrompt = await buildSystemPrompt({ clone });
    debugLog("SYSTEM", "System prompt refreshed");
    return systemPrompt;
  },

  installTool: (source) => installTool(source, agent.registry),

  spawn: (task) => runTaskSubagent({ task, model }, { cwd: process.cwd() }),
});

// Register builtins into the actor's registry.
registerBuiltins(agent.registry, { clone });

// Load custom tools via Reload.
const reloadTool = agent.registry.get("Reload");
if (reloadTool) await reloadTool.execute({});

// Wire provider routing.
if (providerName) {
  agent.convo.setProviderRouting({ only: [providerName] });
  debugLog("PROVIDER", `Routing to: ${providerName}`);
}

// Restore reboot session if present.
if (rebootSession) {
  agent.convo.setHistory(rebootSession.history);
  debugLog("REBOOT", `Restored session: ${rebootSession.reason}`);
}

// Usage tracking is not currently surfaced through the text stream API.
// Kept as zero for the final summary — switch to a provider-side hook if
// per-turn cost tracking becomes a priority.
const totalPromptTokens = 0;
const totalCompletionTokens = 0;

// ============================================================================
// WIRE EVENTS → STDOUT + JSONL
// ============================================================================

let currentStreamText = "";

agent.onEvent((event: AgentEvent) => {
  switch (event.type) {
    case "stream_chunk":
      currentStreamText += event.text;
      process.stdout.write(event.text);
      break;

    case "stream_done":
      if (currentStreamText) {
        logEvent({ type: "assistant", content: currentStreamText });
        currentStreamText = "";
      }
      process.stdout.write("\n");
      break;

    case "tool_start":
      console.log(`[tool] ${event.name}: ${event.preview}`);
      logEvent({ type: "tool_start", name: event.name, preview: event.preview });
      break;

    case "tool_done":
      console.log(`[tool] ${event.name}: ${event.ok ? "ok" : "error"}`);
      logEvent({ type: "tool_done", name: event.name, ok: event.ok, output: event.output });
      break;

    case "memory":
      logEvent({ type: event.op, content: event.content });
      break;

    case "system_refreshed":
      logEvent({ type: "refresh_system" });
      break;

    case "task_complete":
      console.log(`\n[complete] ${event.summary}`);
      logEvent({
        type: "complete",
        summary: event.summary,
        usage: {
          promptTokens: totalPromptTokens,
          completionTokens: totalCompletionTokens,
          totalTokens: totalPromptTokens + totalCompletionTokens,
        },
      });
      break;

    case "error":
      console.error(`\n[error] ${event.error.message}`);
      logEvent({ type: "error", message: event.error.message });
      break;

    case "interrupted":
      console.error("\n[interrupted]");
      logEvent({ type: "interrupted" });
      break;

    // `fatal` (RebootError) is handled by wireRebootHandler below.
  }
});

// Reboot handler: save session + respawn this very process, exit 0.
wireRebootHandler(agent, async (reason) => {
  logEvent({ type: "reboot", reason });
  await agent.stop();
  const argv = process.argv;
  Bun.spawn([argv[0]!, ...argv.slice(1)], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
    cwd: process.cwd(),
  });
  process.exit(0);
});

// ============================================================================
// RUN ONE TURN, THEN EXIT
// ============================================================================

debugLog("USER", instruction);
console.log(`gloop headless | model=${model}`);
console.log(`instruction: ${instruction}\n`);
logEvent({ type: "start", model, instruction });

// Send the instruction and wait for its turn to finish.  RebootError is
// routed through `wireRebootHandler` above (it emits `fatal`, saves the
// session, respawns, and calls process.exit — this script never resumes
// past that point in the reboot case).  Regular errors are logged by the
// event sink, so we just swallow the sendSync rejection here.
try {
  await agent.sendSync(instruction);
} catch {
  // Event sink already logged the error.
}

await agent.stop();

// Always write final usage event.
logEvent({
  type: "usage",
  promptTokens: totalPromptTokens,
  completionTokens: totalCompletionTokens,
  totalTokens: totalPromptTokens + totalCompletionTokens,
});

console.log(
  `\ntokens: ${totalPromptTokens} prompt + ${totalCompletionTokens} completion = ${totalPromptTokens + totalCompletionTokens} total`,
);

process.exit(0);
