/**
 * Context manager — Forks a mini agent loop to prune conversation history
 * and replace pruned messages with a condensed summary.
 */

import type { AIConversation } from "../ai/builder.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { run, mkWorld, type Effects } from "../core/core.ts";

const CONTEXT_MANAGER_SYSTEM_PROMPT = `You are a context manager. Your job is to review the conversation history, delete messages that are no longer useful, and produce a condensed summary of the deleted content.

You are given a numbered index of all messages. Use ViewMessage to inspect any message fully, then DeleteMessages to mark stale ones for removal. Finally, call Summarize to write a condensed summary of the important information from the deleted messages. When done, call CompleteTask.

Guidelines:
- Keep the most recent messages — they have current context
- Delete old ReadFile/Bash tool results that have been superseded
- Delete back-and-forth that led to a conclusion (keep the conclusion)
- Keep memory operations (remember/forget) and their results
- Keep the system message (#0) always
- When in doubt, keep the message
- Be aggressive with large tool outputs that are no longer relevant
- ALWAYS call Summarize before CompleteTask — the summary preserves important context from deleted messages
- The summary should capture: key decisions, important facts learned, user preferences/requests, file paths discovered, errors resolved, and the overall task trajectory
- Write the summary in a neutral, factual tone as a context briefing

Tools are available as function calls. Use them to manage context.`;

export async function manageContextFork(
  convo: AIConversation,
  instructions: string,
  log?: (label: string, content: string) => void,
): Promise<string> {
  const history = convo.getHistory();
  log?.("MANAGE_CONTEXT", `Starting context management, ${history.length} messages: ${instructions}`);

  // Build summary index for the fork agent
  const index = history.map((msg, i) => {
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
  let condensedSummary = "";

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
      const safe = idxs.filter(i => i > 0 && i < history.length);
      toDelete.push(...safe);
      return `Marked ${safe.length} messages for deletion: [${safe.join(", ")}]`;
    },
  });

  forkRegistry.register({
    name: "Summarize",
    description: "Write a condensed summary of the important information from deleted messages.",
    arguments: [{ name: "summary", description: "Condensed summary of key information from pruned messages" }],
    execute: async (args) => {
      condensedSummary = args.summary ?? "";
      return condensedSummary
        ? `Summary recorded (${condensedSummary.length} chars). Call CompleteTask to finish.`
        : "Empty summary — nothing will be injected.";
    },
  });

  forkRegistry.register({
    name: "CompleteTask",
    description: "Finish context management",
    arguments: [{ name: "summary", description: "Brief summary of what was done" }],
    execute: async (args) => args.summary || "Context management complete",
  });

  // Run the fork with silent effects
  const forkWorld = mkWorld(forkConvo, forkRegistry);
  const silentFx: Effects = {
    streamChunk: () => {},
    streamDone: () => {},
    toolStart: (name, preview) => log?.("CONTEXT_FORK", `tool: ${name} ${preview}`),
    toolDone: (name, ok, out) => log?.("CONTEXT_FORK", `done: ${name} ok=${ok} ${out}`),
    confirm: async () => true,
    ask: async () => "",
    remember: async () => {},
    forget: async () => {},
    refreshSystem: async () => {},
    manageContext: async () => "Cannot nest ManageContext",
    complete: (s) => log?.("CONTEXT_FORK", `complete: ${s}`),
    installTool: async () => "Not available in context fork",
    listTools: () => "Not available in context fork",
    spawn: async () => ({ success: false, summary: "Not available in context fork", exitCode: 1, stdout: "", stderr: "" }),
  };

  const input = `Instructions: ${instructions}\n\nMessage index:\n${index}`;
  await run(input, forkWorld, silentFx);

  // Apply deletions
  const deleteSet = new Set(toDelete);

  if (deleteSet.size === 0) {
    const result = `Context reviewed: no messages pruned, ${history.length} remaining`;
    log?.("MANAGE_CONTEXT", result);
    return result;
  }

  const kept = history.filter((_, i) => !deleteSet.has(i));

  // Inject condensed summary as a user message right after system prompt
  if (condensedSummary) {
    const summaryMsg = {
      role: "user" as const,
      content: `[This is a summary of conversation history up to this point]\n\n${condensedSummary}`,
    };
    kept.splice(1, 0, summaryMsg);
  }

  convo.setHistory(kept);

  const result = `Context pruned: removed ${deleteSet.size} messages, injected summary, ${kept.length} remaining`;
  log?.("MANAGE_CONTEXT", result);
  return result;
}
