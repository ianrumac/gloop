/**
 * Context manager — Forks a mini agent loop to prune conversation history
 */

import type { AIConversation } from "../ai/index.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { run, mkWorld, type Effects } from "./core.ts";
import { debugLog } from "./debug.ts";

const CONTEXT_MANAGER_SYSTEM_PROMPT = `You are a context manager. Your job is to review the conversation history and delete messages that are no longer useful — old tool results, stale reads, resolved discussions, etc.

You are given a numbered index of all messages. Use ViewMessage to inspect any message fully, then DeleteMessages to mark stale ones for removal. When done, call CompleteTask with a short summary.

Guidelines:
- Keep the most recent messages — they have current context
- Delete old ReadFile/Bash tool results that have been superseded
- Delete back-and-forth that led to a conclusion (keep the conclusion)
- Keep memory operations (remember/forget) and their results
- Keep the system message (#0) always
- When in doubt, keep the message
- Be aggressive with large tool outputs that are no longer relevant

To use tools, wrap them in a <tools>...</tools> block:
<tools>
    <tool>ViewMessage("3")</tool>
</tools>

Available tools:
<tools>
<tool name = "ViewMessage" description = "View the full content of a message by index", arguments = {"index":"Message index to view"}>
<tool name = "DeleteMessages" description = "Mark messages for deletion by index (comma-separated)", arguments = {"indexes":"Comma-separated message indexes to delete"}>
<tool name = "CompleteTask" description = "Finish context management with a summary", arguments = {"summary":"Brief summary of what was pruned"}>
</tools>`;

export async function manageContextFork(convo: AIConversation, instructions: string): Promise<string> {
  const history = convo.getHistory();
  debugLog("MANAGE_CONTEXT", `Starting context management, ${history.length} messages: ${instructions}`);

  // Build summary index for the fork agent
  const summary = history.map((msg, i) => {
    const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    const first50 = content.slice(0, 50);
    const last50 = content.length > 100 ? content.slice(-50) : "";
    return `#${i} [${msg.role}] "${first50}${last50 ? "... ..." + last50 : ""}"`;
  }).join("\n");

  // Create fork conversation
  const forkConvo = convo.fork(CONTEXT_MANAGER_SYSTEM_PROMPT);

  // Build mini registry with context tools
  const forkRegistry = new ToolRegistry();
  const toDelete: number[] = [];

  forkRegistry.register({
    name: "ViewMessage",
    description: "View the full content of a message by index",
    arguments: [{ name: "index", description: "Message index to view" }],
    execute: async (args) => {
      const idx = parseInt(args.index ?? "");
      const msg = history[idx];
      if (!msg) return `No message at index ${idx}`;
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return `#${idx} [${msg.role}]\n${content}`;
    },
  });

  forkRegistry.register({
    name: "DeleteMessages",
    description: "Mark messages for deletion by index (comma-separated)",
    arguments: [{ name: "indexes", description: "Comma-separated message indexes to delete" }],
    execute: async (args) => {
      const idxs = (args.indexes ?? "").split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n));
      // Don't allow deleting system message
      const safe = idxs.filter(i => i > 0 && i < history.length);
      toDelete.push(...safe);
      return `Marked ${safe.length} messages for deletion: [${safe.join(", ")}]`;
    },
  });

  forkRegistry.register({
    name: "CompleteTask",
    description: "Finish context management with a summary",
    arguments: [{ name: "summary", description: "Brief summary of what was pruned" }],
    execute: async (args) => args.summary || "Context management complete",
  });

  // Run the fork with silent effects (no UI output)
  const forkWorld = mkWorld(forkConvo, forkRegistry);
  const silentFx: Effects = {
    streamChunk: () => {},
    streamDone: () => {},
    toolStart: (name, preview) => debugLog("CONTEXT_FORK", `tool: ${name} ${preview}`),
    toolDone: (name, ok, out) => debugLog("CONTEXT_FORK", `done: ${name} ok=${ok} ${out}`),
    confirm: async () => true,
    ask: async () => "",
    remember: async () => {},
    forget: async () => {},
    refreshSystem: async () => {},
    reboot: async () => { throw new Error("Cannot reboot from context fork"); },
    manageContext: async (_instructions) => "Cannot nest ManageContext",
    complete: (s) => debugLog("CONTEXT_FORK", `complete: ${s}`),
    installTool: async () => "Not available in context fork",
    listTools: () => "Not available in context fork",
    spawn: async () => ({ success: false, summary: "Not available in context fork", exitCode: 1, stdout: "", stderr: "" }),
  };

  const input = `Instructions: ${instructions}\n\nMessage index:\n${summary}`;
  await run(input, forkWorld, silentFx);

  // Apply deletions
  const deleteSet = new Set(toDelete);
  const pruned = history.filter((_, i) => !deleteSet.has(i));
  convo.setHistory(pruned);

  const result = `Context pruned: removed ${deleteSet.size} messages, ${pruned.length} remaining`;
  debugLog("MANAGE_CONTEXT", result);
  return result;
}
