#!/usr/bin/env bun
/**
 * gloop headless — Non-interactive mode for benchmarks & CI
 *
 * Usage: bun headless.ts --model <provider/model> --output <path> "<instruction>"
 *
 * Auto-approves all tools, writes structured JSONL events to --output,
 * and exits when the agent calls CompleteTask (or hits the safety cap:
 * `maxIterations` LLM calls per turn, 100 by default — see config.ts).
 * SIGINT / SIGTERM / SIGHUP stop the agent, kill its children, write a
 * final `shutdown` + `usage` event and exit non-zero.
 */

import { OpenRouterProvider } from "@hypen-space/gloop-loop";
import { registerBuiltins } from "../tools/index.ts";
import { ensureGloopDir, appendMemory, removeMemory } from "./memory.ts";
import { buildSystemPrompt } from "./system.ts";
import { discoverSkills } from "./skills.ts";
import { enableDebug, debugLog, debugLogRaw } from "./debug.ts";
import {
  loadRebootSession,
  openSessionStore,
  rebootIsFatal,
  resolveSessionLog,
  wireRebootHandler,
} from "./session.ts";
import { AgentLoop, type AgentEvent } from "./core.ts";
import { appendFileSync } from "fs";
import { taskSpawnOptions } from "./task-mode.ts";
import { parseHeadlessArgs } from "./cli-args.ts";
import { installTool } from "../../bin/install-tool.ts";
import {
  agentOptionsFor,
  inheritedFlags,
  loadSettings,
  missingApiKeyMessage,
  resolveCompactAt,
  ConfigError,
  type ResolvedSettings,
} from "./config.ts";
import { resolveContextWindow } from "./context-window.ts";
import { createShutdown, installSignalHandlers } from "./shutdown.ts";

// ============================================================================
// CLI PARSING
// ============================================================================

function usage(): never {
  console.error(
    'Usage: bun headless.ts --model <provider/model> [--provider <name>] [--output <path>] [--debug] [--task "<task>"] [--session <log>] [--agent-id <id>] [--cause <json>] [--max-iterations <n>] [--retries <n>] [--max-tool-output <n>] [--compact-at <n|range>] [--context-window <tokens>] [--compaction fold|llm] [--task-timeout <ms>] "<instruction>"',
  );
  process.exit(1);
}

const {
  model, outputPath, debug, providerName, clone, instruction, session: sessionArg, agentId, cause, settings: settingFlags,
} = parseHeadlessArgs(process.argv.slice(2));

if (!instruction) usage();

const missingKey = missingApiKeyMessage();
if (missingKey) {
  console.error(missingKey);
  process.exit(1);
}

let resolved: ResolvedSettings;
try {
  resolved = await loadSettings("headless", settingFlags);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`gloop: ${err.message}`);
  process.exit(1);
}
const { settings } = resolved;

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
for (const note of resolved.notes) debugLog("CONFIG", note);
debugLog("CONFIG", JSON.stringify(settings));

await ensureGloopDir();

// The model's context window: the setting (a parent passes its own as
// --context-window), else the (cached) models list, else 128k.
const contextWindow = await resolveContextWindow({
  model,
  explicit: settings.contextWindow,
  baseUrl: process.env.OPENROUTER_BASE_URL,
  ...(process.env.OPENROUTER_BASE_URL && { apiKey: process.env.OPENROUTER_API_KEY }),
});
for (const note of contextWindow.notes) debugLog("CONTEXT_WINDOW", note);
const compactAt = resolveCompactAt(settings.compactAt, contextWindow.tokens);
debugLog("CONFIG", `compactAtTokens ${JSON.stringify(compactAt.tokens)}`);
if (compactAt.notice) console.error(`gloop: ${compactAt.notice}`);

const skills = await discoverSkills(process.cwd());

let systemPrompt = await buildSystemPrompt({ clone, maxToolOutput: settings.maxToolOutput });
debugLog("SYSTEM", systemPrompt);

const rebootSession = await loadRebootSession();
const sessionLogPath = resolveSessionLog({ reboot: rebootSession, session: sessionArg })!;
debugLog("SESSION", sessionLogPath);
if (cause) debugLog("CAUSE", `${cause.agent} ${cause.eventId} ${cause.log ?? ""}`);

// ============================================================================
// BUILD THE ACTOR
// ============================================================================

const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  // OPENROUTER_BASE_URL points gloop at any OpenAI-compatible endpoint.
  ...(process.env.OPENROUTER_BASE_URL && { baseUrl: process.env.OPENROUTER_BASE_URL }),
});

const agent: AgentLoop = await AgentLoop.resume({
  provider,
  model,
  system: systemPrompt,
  skills,
  id: agentId,
  store: openSessionStore(sessionLogPath),
  // Start empty; we register builtins into the actor's registry below so
  // Reload/installTool see the same registry the loop uses.
  tools: [],
  log: debug ? (label, content) => debugLogRaw(label, content) : undefined,
  // A RebootError stops the loop and fires a `fatal` event — see
  // wireRebootHandler below.
  isFatal: rebootIsFatal,
  // Safety settings: iteration cap, LLM retry, output cap, compaction.
  ...agentOptionsFor(settings, contextWindow.tokens),

  // `gloop --task "..."` in a Bash call runs as a linked subagent that
  // inherits these settings.
  ...taskSpawnOptions({
    model,
    provider: providerName,
    cwd: process.cwd(),
    parentLog: sessionLogPath,
    inheritFlags: inheritedFlags(resolved),
    timeoutMs: settings.taskTimeoutMs,
    contextWindow: contextWindow.tokens,
  }),

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
    systemPrompt = await buildSystemPrompt({ clone, maxToolOutput: settings.maxToolOutput });
    debugLog("SYSTEM", "System prompt refreshed");
    return systemPrompt;
  },

  installTool: (source) => installTool(source, agent.registry),
});

// Register builtins into the actor's registry.
registerBuiltins(agent.registry, { clone, skills });

// Load custom tools via Reload.
const reloadTool = agent.registry.get("Reload");
if (reloadTool) await reloadTool.execute({});

// Wire provider routing.
if (providerName) {
  agent.convo.setProviderRouting({ only: [providerName] });
  debugLog("PROVIDER", `Routing to: ${providerName}`);
}

if (rebootSession) {
  debugLog("REBOOT", `Restored session: ${rebootSession.reason}`);
}

/** Running token totals (the engine folds them from `llm_response` usage). */
function usageTotals() {
  const u = agent.usage();
  return { promptTokens: u.promptTokens, completionTokens: u.completionTokens, totalTokens: u.totalTokens };
}

function logFinalUsage(): void {
  const u = usageTotals();
  logEvent({ type: "usage", ...u });
  console.log(`\ntokens: ${u.promptTokens} prompt + ${u.completionTokens} completion = ${u.totalTokens} total`);
}

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
        usage: usageTotals(),
      });
      break;

    case "retry":
      console.error(`[retry] ${event.boundary} attempt ${event.attempt + 1}/${event.maxAttempts} in ${event.delayMs}ms: ${event.error.message}`);
      logEvent({ type: "retry", boundary: event.boundary, attempt: event.attempt, maxAttempts: event.maxAttempts, message: event.error.message });
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

// SIGINT / SIGTERM / SIGHUP: stop the agent (interrupts the turn and kills
// the running Bash command or subagent through its abort signal), kill any
// tracked child left, write a final event, exit 128+n.
const shutdown = createShutdown({
  stopAgent: () => agent.stop(),
  afterStop: (reason, code) => {
    console.error(`\n[shutdown] ${reason}`);
    logEvent({ type: "shutdown", signal: reason, exitCode: code });
    logFinalUsage();
  },
  log: (m) => debugLog("SHUTDOWN", m),
});
installSignalHandlers(shutdown);

// Reboot handler: save session + respawn this very process, exit 0.
wireRebootHandler(agent, sessionLogPath, async (reason) => {
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
logEvent({ type: "start", model, instruction, contextWindow: contextWindow.tokens, compactAtTokens: compactAt.tokens });

// Send the instruction and wait for its turn to finish.  RebootError is
// routed through `wireRebootHandler` above (it emits `fatal`, saves the
// session, respawns, and calls process.exit — this script never resumes
// past that point in the reboot case).  Regular errors are logged by the
// event sink, so we just swallow the sendSync rejection here.
try {
  // `cause` links this run's first turn to the parent's spawn_start event.
  await agent.sendSync(instruction, cause ? { cause } : undefined);
} catch {
  // Event sink already logged the error.
}

// A signal arrived mid-turn: the shutdown sequence owns the exit.
if (shutdown.inProgress) await new Promise(() => {});

await agent.stop();

// Always write final usage event.
logFinalUsage();

process.exit(0);
