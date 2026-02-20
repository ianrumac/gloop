#!/usr/bin/env bun
/**
 * gloop — A recursive Lisp-style AI agent
 *
 * "Any sufficiently advanced AI agent is indistinguishable from eval/apply."
 */

import React from "react";
import { render } from "ink";
import { createAI } from "../src/ai/index.ts";
import { ToolRegistry, registerBuiltins } from "../src/tools/index.ts";
import { ensureGloopDir, appendMemory, removeMemory } from "../src/core/memory.ts";
import { buildSystemPrompt } from "../src/core/system.ts";
import { enableDebug, debugLog } from "../src/core/debug.ts";
import { loadRebootSession, saveRebootSession } from "../src/core/session.ts";
import { run, mkWorld, type Effects } from "../src/core/core.ts";
import { parseTaskCliArgs, runTaskSubagent } from "../src/core/task-mode.ts";
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

// ============================================================================
// SELF-COPY CHECK (only with --clone)
// ============================================================================
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
const model = args.find((a, i) => !a.startsWith("--") && i !== providerIdx + 1) ?? "x-ai/grok-4.1-fast";

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

// Build system prompt
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
// RENDER
// ============================================================================

const { unmount } = render(
  React.createElement(App, {
    model,
    rebootReason: rebootSession?.reason,
    runAgent: async (input, ui, signal) => {
      const world = mkWorld(convo, registry, signal);

      const fx: Effects = {
        streamChunk: ui.onStreamChunk,
        streamDone: ui.onStreamDone,
        toolStart: ui.onToolStart,
        toolDone: ui.onToolDone,
        confirm: ui.onConfirmNeeded,
        ask: ui.onAskUser,

        remember: async (content) => {
          await appendMemory(content);
          ui.onRemember(content);
          debugLog("REMEMBER", content);
        },

        forget: async (content) => {
          await removeMemory(content);
          ui.onForget(content);
          debugLog("FORGET", content);
        },

        refreshSystem: async () => {
          systemPrompt = await buildSystemPrompt(registry);
          convo.setSystem(systemPrompt);
          ui.onSystemPromptRefreshed();
          debugLog("SYSTEM", "System prompt refreshed");
        },

        reboot: async (reason, c) => {
          await saveRebootSession(c, reason);
          debugLog("REBOOT", `Restarting: ${reason}`);

          // Clean up ink and terminal
          unmount();
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }

          // Exit with special code - launcher.ts will respawn us
          process.exit(REBOOT_EXIT_CODE);
        },

        manageContext: async (instructions) => {
          const { manageContextFork } = await import("../src/core/context-manager.ts");
          return manageContextFork(convo, instructions);
        },

        complete: ui.onTaskComplete,

        installTool: (source) => installTool(source, registry),

        listTools: () => {
          const names = registry.names();
          return `${names.length} tools available: ${names.join(", ")}`;
        },

        spawn: async (task) => runTaskSubagent({ task, model }, { cwd: process.cwd() }),
      };

      debugLog("USER", input);
      await run(input, world, fx);
    },
  })
);
