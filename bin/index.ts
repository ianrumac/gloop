#!/usr/bin/env bun
/**
 * gloop — A recursive Lisp-style AI agent
 *
 * "Any sufficiently advanced AI agent is indistinguishable from eval/apply."
 */

import React from "react";
import { render } from "ink";
import { OpenRouterProvider } from "@hypen-space/gloop-loop";
import { registerBuiltins } from "../src/tools/index.ts";
import { ensureGloopDir, appendMemory, removeMemory } from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/core/system.ts";
import { enableDebug, debugLog, debugLogRaw } from "../src/core/debug.ts";
import {
  loadRebootSession,
  rebootIsFatal,
  wireRebootHandler,
} from "../src/core/session.ts";
import { AgentLoop } from "../src/core/core.ts";
import { parseGloopTaskBashCommand, parseTaskCliArgs, runTaskSubagent } from "../src/core/task-mode.ts";
import { ensureSelfCopy } from "./self-copy.ts";
import App from "../components/App.tsx";
import { installTool } from "./install-tool.ts";

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
  const result = await runTaskSubagent(taskRequest, { cwd: process.cwd() });
  if (result.success) {
    console.log(result.summary);
    process.exit(0);
  }
  console.error(`Task mode failed: ${result.summary}`);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.error(result.stdout);
  process.exit(result.exitCode === 0 ? 1 : result.exitCode);
}

const debug = args.includes("--debug");
const providerIdx = args.indexOf("--provider");
const providerName = providerIdx !== -1 ? args[providerIdx + 1] : undefined;
const model = args.find((a, i) =>
  !a.startsWith("--") && i !== providerIdx + 1
) ?? "x-ai/grok-4.1-fast";

if (debug) enableDebug();

await ensureGloopDir();

// Build system prompt
let systemPrompt = await buildSystemPrompt({ clone });
debugLog("SYSTEM", systemPrompt);

// Check for reboot session (so we can restore history after the actor is built)
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
  // Start with no tools; we register builtins into the actor's own registry
  // below so Reload/installTool see the same registry the loop uses.
  tools: [],
  log: debug ? (label, content) => debugLogRaw(label, content) : undefined,
  contextPruneInterval: 50,
  // A RebootError from the Reboot tool stops the loop and fires a `fatal`
  // event — see wireRebootHandler below.
  isFatal: rebootIsFatal,

  // Spawn classifier: detect `gloop --task "..."` in Bash calls.
  classifySpawn: (call) => {
    if (call.name !== "Bash") return null;
    const req = parseGloopTaskBashCommand(call.args.command ?? "");
    return req ? req.task : null;
  },

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
    systemPrompt = await buildSystemPrompt({ clone });
    debugLog("SYSTEM", "System prompt refreshed");
    return systemPrompt;
  },

  installTool: (source) => installTool(source, agent.registry),

  spawn: (task) => runTaskSubagent({ task, model }, { cwd: process.cwd() }),
});

// Register builtins into the actor's registry so Reload/install see the same
// registry the loop uses.
registerBuiltins(agent.registry, { clone });

// Load custom tools via Reload so the actor sees them from turn 1.
const reloadTool = agent.registry.get("Reload");
if (reloadTool) await reloadTool.execute({});

// Wire provider routing (OpenRouter-specific).
if (providerName) {
  agent.convo.setProviderRouting({ only: [providerName] });
  debugLog("PROVIDER", `Routing to: ${providerName}`);
}

// Restore reboot session if present.
if (rebootSession) {
  agent.convo.setHistory(rebootSession.history);
  debugLog("REBOOT", `Restored session: ${rebootSession.reason}`);
}

// ============================================================================
// RENDER
// ============================================================================

const { unmount } = render(
  React.createElement(App, {
    model,
    rebootReason: rebootSession?.reason,
    agent,
  })
);

// ============================================================================
// REBOOT HANDLING
// ============================================================================
//
// The `isFatal: rebootIsFatal` option classifies RebootError as fatal, so
// the actor stops the loop and emits a `fatal` event.  wireRebootHandler
// saves the session + invokes our restart callback, which tears down Ink
// and exits with a special code that the launcher recognises as "restart".
wireRebootHandler(agent, async () => {
  unmount();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  await agent.stop();
  process.exit(REBOOT_EXIT_CODE);
});
