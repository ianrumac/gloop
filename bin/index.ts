#!/usr/bin/env bun
/**
 * gloop — A recursive Lisp-style AI agent
 *
 * "Any sufficiently advanced AI agent is indistinguishable from eval/apply."
 */

import React from "react";
import { relative } from "path";
import { render } from "ink";
import { OpenRouterProvider } from "@hypen-space/gloop-loop";
import { registerBuiltins } from "../src/tools/index.ts";
import { ensureGloopDir, appendMemory, removeMemory } from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/core/system.ts";
import { discoverSkills } from "../src/core/skills.ts";
import {
  enableDebug,
  debugLog,
  debugLogRaw,
  debugTracer,
  debugInterceptor,
} from "../src/core/debug.ts";
import {
  loadRebootSession,
  openSessionStore,
  rebootIsFatal,
  resolveSessionLog,
  wireRebootHandler,
} from "../src/core/session.ts";
import { AgentLoop } from "../src/core/core.ts";
import { parseTaskCliArgs, runTaskCli, taskSpawnOptions } from "../src/core/task-mode.ts";
import { ensureSelfCopy } from "./self-copy.ts";
import App from "../components/App.tsx";
import { installTool } from "./install-tool.ts";
import { parseGloopArgs } from "../src/core/cli-args.ts";
import {
  agentOptionsFor,
  ConfigError,
  inheritedFlags,
  loadSettings,
  missingApiKeyMessage,
  resolveCompactAt,
  type ResolvedSettings,
} from "../src/core/config.ts";
import { resolveContextWindow } from "../src/core/context-window.ts";
import { createShutdown, installSignalHandlers } from "../src/core/shutdown.ts";
import { killTrackedChildren } from "../src/core/children.ts";

// Special exit code that signals "please restart me"
const REBOOT_EXIT_CODE = 75;

// ============================================================================
// SETUP
// ============================================================================

const args = process.argv.slice(2);
const clone = args.includes("--clone");

// ---- Self-copy check (only with --clone) ----
if (clone) {
  await ensureSelfCopy();
}

const taskRequest = parseTaskCliArgs(args);
if (taskRequest) {
  process.exit(await runTaskCli(taskRequest));
}

const { debug, providerName, resume, model, settings: settingFlags } = parseGloopArgs(args);

// Fail fast on a missing key or bad settings — before the TUI starts.
const missingKey = missingApiKeyMessage();
if (missingKey) {
  console.error(missingKey);
  process.exit(1);
}
let resolved: ResolvedSettings;
try {
  resolved = await loadSettings("interactive", settingFlags);
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  console.error(`gloop: ${err.message}`);
  process.exit(1);
}
const { settings } = resolved;

if (debug) enableDebug();
for (const note of resolved.notes) debugLog("CONFIG", note);
debugLog("CONFIG", JSON.stringify(settings));

await ensureGloopDir();

// The model's context window: the setting, else the (cached) models list,
// else 128k.  `compactAt` fractions are taken of it.
const contextWindow = await resolveContextWindow({
  model,
  explicit: settings.contextWindow,
  baseUrl: process.env.OPENROUTER_BASE_URL,
  ...(process.env.OPENROUTER_BASE_URL && { apiKey: process.env.OPENROUTER_API_KEY }),
});
for (const note of contextWindow.notes) debugLog("CONTEXT_WINDOW", note);
const compactAt = resolveCompactAt(settings.compactAt, contextWindow.tokens);
debugLog("CONFIG", `compactAtTokens ${JSON.stringify(compactAt.tokens)}`);

const skills = await discoverSkills(process.cwd());

// Build system prompt
let systemPrompt = await buildSystemPrompt({ clone, maxToolOutput: settings.maxToolOutput });
debugLog("SYSTEM", systemPrompt);

// Which event log is this session?  A reboot pointer wins, then --resume,
// otherwise a fresh file under .gloop/sessions/.  The log is the session:
// AgentLoop.resume replays it (rolling back any cut-off turn) and keeps
// appending to it.
const rebootSession = await loadRebootSession();
const sessionLogPath = resolveSessionLog({ reboot: rebootSession, resume });
if (!sessionLogPath) {
  console.error("No session to resume: .gloop/sessions/ has no top-level session logs.");
  process.exit(1);
}
debugLog("SESSION", sessionLogPath);

// ============================================================================
// BUILD THE ACTOR
// ============================================================================

const provider = new OpenRouterProvider({
  apiKey: process.env.OPENROUTER_API_KEY!,
  // OPENROUTER_BASE_URL points gloop at any OpenAI-compatible endpoint.
  ...(process.env.OPENROUTER_BASE_URL && { baseUrl: process.env.OPENROUTER_BASE_URL }),
});

const debugInt = debugInterceptor();

const agent: AgentLoop = await AgentLoop.resume({
  provider,
  model,
  system: systemPrompt,
  skills,
  id: "gloop",
  store: openSessionStore(sessionLogPath),
  // Start with no tools; we register builtins into the actor's own registry
  // below so Reload/installTool see the same registry the loop uses.
  tools: [],
  log: debug ? (label, content) => debugLogRaw(label, content) : undefined,
  // --debug also enables a tracer (span tree per turn) and an interceptor
  // (boundary payloads + timings).  Both write to `.gloop/debug.log`.
  tracer: debugTracer(),
  interceptors: debugInt ? [debugInt] : undefined,
  // A RebootError from the Reboot tool stops the loop and fires a `fatal`
  // event — see wireRebootHandler below.
  isFatal: rebootIsFatal,
  // Safety settings: iteration cap, LLM retry, output cap, compaction.
  ...agentOptionsFor(settings, contextWindow.tokens),

  // `gloop --task "..."` in a Bash call runs as a linked subagent that
  // inherits these settings and is killed when the turn is interrupted.
  ...taskSpawnOptions({
    model,
    provider: providerName,
    cwd: process.cwd(),
    parentLog: sessionLogPath,
    inheritFlags: inheritedFlags(resolved),
    timeoutMs: settings.taskTimeoutMs,
    contextWindow: contextWindow.tokens,
  }),

  // confirm / ask are NOT set — the actor will emit confirm_request /
  // ask_request events and the UI will respond via
  // agent.respondToConfirm / agent.respondToAsk.

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

// Register builtins into the actor's registry so Reload/install see the same
// registry the loop uses.
registerBuiltins(agent.registry, { clone, skills });

// Load custom tools via Reload so the actor sees them from turn 1.
const reloadTool = agent.registry.get("Reload");
if (reloadTool) await reloadTool.execute({});

// Wire provider routing (OpenRouter-specific).
if (providerName) {
  agent.convo.setProviderRouting({ only: [providerName] });
  debugLog("PROVIDER", `Routing to: ${providerName}`);
}

if (rebootSession) {
  debugLog("REBOOT", `Restored session: ${rebootSession.reason}`);
}

// What a resumed session restored — shown as the first line of the TUI.
const restored = agent.snapshot();
const resumed = (resume.requested || rebootSession) && restored.eventCount > 0
  ? { file: relative(process.cwd(), sessionLogPath), turns: restored.turns.length }
  : undefined;

// ============================================================================
// RENDER
// ============================================================================

const instance = render(
  React.createElement(App, {
    model,
    rebootReason: rebootSession?.reason,
    resumed,
    agent,
    contextWindow: contextWindow.tokens,
    ...(compactAt.notice && { notices: [compactAt.notice] }),
  }),
);

/** Tear down Ink and give the terminal back. */
function releaseTerminal(): void {
  instance.unmount();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

// ============================================================================
// SHUTDOWN
// ============================================================================
//
// Ctrl+C in the TUI unmounts Ink (raw mode: no SIGINT); SIGINT / SIGTERM /
// SIGHUP arrive as signals.  Either way: unmount, stop the agent (interrupts
// the turn — a running Bash command or subagent is killed through its abort
// signal — and flushes the session log), kill tracked children that are
// left (never commands deliberately moved to the background), exit.  A
// second Ctrl+C while that runs exits at once.

let rebooting = false;
const shutdown = createShutdown({
  beforeStop: () => {
    releaseTerminal();
    setTimeout(() => process.stderr.write("Stopping gloop… (Ctrl+C again to force quit)\n"), 500).unref();
  },
  stopAgent: () => agent.stop(),
  log: (m) => debugLog("SHUTDOWN", m),
});
installSignalHandlers(shutdown);
void instance.waitUntilExit().then(() => {
  if (!rebooting && !shutdown.inProgress) void shutdown.request("quit");
});

// ============================================================================
// REBOOT HANDLING
// ============================================================================
//
// The `isFatal: rebootIsFatal` option classifies RebootError as fatal, so
// the actor stops the loop and emits a `fatal` event.  wireRebootHandler
// saves the session + invokes our restart callback, which tears down Ink
// and exits with a special code that the launcher recognises as "restart".
wireRebootHandler(agent, sessionLogPath, async () => {
  rebooting = true;
  releaseTerminal();
  await agent.stop();
  killTrackedChildren();
  process.exit(REBOOT_EXIT_CODE);
});
