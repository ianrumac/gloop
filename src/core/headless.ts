#!/usr/bin/env bun
/**
 * gloop headless — Non-interactive mode for benchmarks & CI
 *
 * Usage: bun headless.ts --model <provider/model> --output <path> "<instruction>"
 *
 * Auto-approves all tools, writes structured JSONL events to --output,
 * and exits when the agent calls CompleteTask (or hits the safety cap).
 */

import { createAI } from "../ai/index.ts";
import { ToolRegistry, registerBuiltins } from "../tools/index.ts";
import { ensureGloopDir, appendMemory, removeMemory } from "./memory.ts";
import { buildSystemPrompt } from "./system.ts";
import { enableDebug, debugLog } from "./debug.ts";
import { loadRebootSession, saveRebootSession } from "./session.ts";
import { run, mkWorld, type Effects } from "./core.ts";
import { appendFileSync } from "fs";
import { appendTaskPromptSuffix, runTaskSubagent } from "./task-mode.ts";
import { installTool } from "../../bin/install-tool.ts";

// ============================================================================
// CLI PARSING
// ============================================================================

function usage(): never {
  console.error(
    'Usage: bun headless.ts --model <provider/model> [--provider <name>] [--output <path>] [--debug] [--task "<task>"] "<instruction>"'
  );
  process.exit(1);
}

const args = process.argv.slice(2);

let model = "x-ai/grok-4.1-fast";
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
// SETUP (mirrors index.ts)
// ============================================================================

if (debug) enableDebug();

const ai = createAI({
  apiKey: process.env.OPENROUTER_API_KEY!,
  defaultModel: model,
});

const registry = new ToolRegistry();
registerBuiltins(registry, { clone });

await ensureGloopDir();

// Load custom tools
const reloadTool = registry.get("Reload");
if (reloadTool) await reloadTool.execute({});

let systemPrompt = await buildSystemPrompt(registry, { clone });
debugLog("SYSTEM", systemPrompt);

const convo = ai.conversation({ system: systemPrompt });
if (providerName) {
  convo.setProviderRouting({ only: [providerName] });
  debugLog("PROVIDER", `Routing to: ${providerName}`);
}

// Check for reboot session
const rebootSession = await loadRebootSession();
if (rebootSession) {
  convo.setHistory(rebootSession.history);
  debugLog("REBOOT", `Restored session: ${rebootSession.reason}`);
}

// ============================================================================
// HEADLESS EFFECTS
// ============================================================================

// Track tokens across the run
let totalPromptTokens = 0;
let totalCompletionTokens = 0;

// Monkey-patch the conversation's stream to capture usage from the final chunk
const origStream = convo.stream.bind(convo);
convo.stream = async function* (message: string) {
  const gen = origStream(message);
  let result;
  while (true) {
    result = await gen.next();
    if (result.done) break;
    const chunk = result.value;
    if (chunk.usage) {
      totalPromptTokens += chunk.usage.promptTokens;
      totalCompletionTokens += chunk.usage.completionTokens;
    }
    yield chunk;
  }
  return result.value;
};

let currentStreamText = "";

logEvent({ type: "start", model, instruction });

const world = mkWorld(convo, registry);

const fx: Effects = {
  streamChunk: (text) => {
    currentStreamText += text;
    process.stdout.write(text);
  },

  streamDone: () => {
    if (currentStreamText) {
      logEvent({ type: "assistant", content: currentStreamText });
      currentStreamText = "";
    }
    process.stdout.write("\n");
  },

  toolStart: (name, preview) => {
    console.log(`[tool] ${name}: ${preview}`);
    logEvent({ type: "tool_start", name, preview });
  },

  toolDone: (name, ok, output) => {
    const status = ok ? "ok" : "error";
    console.log(`[tool] ${name}: ${status}`);
    logEvent({ type: "tool_done", name, ok, output });
  },

  confirm: async (_command) => {
    // Auto-approve everything in headless mode
    return true;
  },

  ask: async (_question) => {
    return "Please proceed with your best judgment.";
  },

  remember: async (content) => {
    await appendMemory(content);
    logEvent({ type: "remember", content });
    debugLog("REMEMBER", content);
  },

  forget: async (content) => {
    await removeMemory(content);
    logEvent({ type: "forget", content });
    debugLog("FORGET", content);
  },

  refreshSystem: async () => {
    systemPrompt = await buildSystemPrompt(registry);
    convo.setSystem(systemPrompt);
    logEvent({ type: "refresh_system" });
    debugLog("SYSTEM", "System prompt refreshed");
  },

  reboot: async (reason, c): Promise<never> => {
    await saveRebootSession(c, reason);
    logEvent({ type: "reboot", reason });
    debugLog("REBOOT", `Restarting: ${reason}`);

    // Re-exec headless with same args
    const argv = process.argv;
    Bun.spawn([argv[0]!, ...argv.slice(1)], {
      stdio: ["inherit", "inherit", "inherit"],
      env: process.env,
      cwd: process.cwd(),
    });
    return process.exit(0) as never;
  },

  manageContext: async (instructions) => {
    const { manageContextFork } = await import("./context-manager.ts");
    return manageContextFork(convo, instructions);
  },

  complete: (summary) => {
    console.log(`\n[complete] ${summary}`);
    logEvent({
      type: "complete",
      summary,
      usage: {
        promptTokens: totalPromptTokens,
        completionTokens: totalCompletionTokens,
        totalTokens: totalPromptTokens + totalCompletionTokens,
      },
    });
  },

  installTool: (source) => installTool(source, registry),

  listTools: () => {
    const names = registry.names();
    return `${names.length} tools available: ${names.join(", ")}`;
  },

  spawn: async (task) => runTaskSubagent({ task, model }, { cwd: process.cwd() }),
};

// ============================================================================
// RUN
// ============================================================================

debugLog("USER", instruction);
console.log(`gloop headless | model=${model}`);
console.log(`instruction: ${instruction}\n`);

try {
  await run(instruction, world, fx);
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`\n[error] ${msg}`);
  logEvent({ type: "error", message: msg });
}

// Always write final usage event
logEvent({
  type: "usage",
  promptTokens: totalPromptTokens,
  completionTokens: totalCompletionTokens,
  totalTokens: totalPromptTokens + totalCompletionTokens,
});

console.log(
  `\ntokens: ${totalPromptTokens} prompt + ${totalCompletionTokens} completion = ${totalPromptTokens + totalCompletionTokens} total`
);

process.exit(0);
