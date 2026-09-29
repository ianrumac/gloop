/**
 * Context manager — the default `ContextStrategy`: forks a mini `AgentLoop`
 * actor to prune conversation history and replace pruned messages with a
 * condensed summary.
 */

import type { AIConversation } from "../ai/builder.js";
import type { Message } from "../ai/types.js";
import { AgentLoop } from "../agent.js";
import type { ToolDefinition } from "../tools/types.js";
import type { EventLog } from "../log.js";
import {
  contextFromHistory,
  contextGraph,
  contextNode,
  describeTrim,
  trimContext,
  type ContextGraph,
  type ContextStrategy,
  type ContextStrategyContext,
} from "../context.js";

export interface ManageContextOptions {
  /** Share the parent's log so the fork's events land in the same graph. */
  eventLog?: EventLog;
  /** Agent id for the fork's events.  Default: `"context-manager"`. */
  id?: string;
  /** Called with the new history when messages were actually pruned. */
  onReplaced?: (history: Message[], removed: number) => void;
}

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

export interface LlmContextStrategyOptions {
  /** Agent id for the fork's events.  Default: `${agent}/context`. */
  id?: string;
}

/**
 * The default strategy: a forked agent reviews a numbered index of the
 * context, marks stale messages for deletion and writes a summary of what
 * it removed.  The summary comes back as a new node right after the first.
 */
export function llmContextStrategy(options: LlmContextStrategyOptions = {}): ContextStrategy {
  return (graph, ctx) => pruneWithFork(graph, ctx, options);
}

async function pruneWithFork(
  graph: ContextGraph,
  ctx: ContextStrategyContext,
  options: LlmContextStrategyOptions,
): Promise<ContextGraph> {
  const history = graph.nodes.map((n) => n.message);
  const { instructions, log } = ctx;

  // Build summary index for the fork agent
  const index = history
    .map((msg, i) => {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      const first50 = content.slice(0, 50);
      const last50 = content.length > 100 ? content.slice(-50) : "";
      return `#${i} [${msg.role}] "${first50}${last50 ? "... ..." + last50 : ""}"`;
    })
    .join("\n");

  // Shared mutable state the tools write into.
  const toDelete: number[] = [];
  let condensedSummary = "";

  const tools: ToolDefinition[] = [
    {
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
    },
    {
      name: "DeleteMessages",
      description: "Mark messages for deletion by index (comma-separated)",
      arguments: [{ name: "indexes", description: "Comma-separated message indexes to delete" }],
      execute: async (args) => {
        const idxs = (args.indexes ?? "")
          .split(",")
          .map((s) => parseInt(s.trim()))
          .filter((n) => !isNaN(n));
        // Don't allow deleting the system message (#0).
        const safe = idxs.filter((i) => i > 0 && i < history.length);
        toDelete.push(...safe);
        return `Marked ${safe.length} messages for deletion: [${safe.join(", ")}]`;
      },
    },
    {
      name: "Summarize",
      description:
        "Write a condensed summary of the important information from deleted messages. This summary will be injected into the conversation so context is not lost.",
      arguments: [{ name: "summary", description: "Condensed summary of key information from pruned messages" }],
      execute: async (args) => {
        condensedSummary = args.summary ?? "";
        return condensedSummary
          ? `Summary recorded (${condensedSummary.length} chars). Call CompleteTask to finish.`
          : "Empty summary — nothing will be injected.";
      },
    },
    {
      name: "CompleteTask",
      description: "Finish context management",
      arguments: [{ name: "summary", description: "Brief summary of what was done" }],
      execute: async (args) => args.summary || "Context management complete",
    },
  ];

  // Spawn a nested actor with its own provider/model (copied from the parent
  // conversation), its own registry (only the context-management tools), and
  // no UI subscribers — it runs silently.
  const forkAgent = new AgentLoop({
    provider: ctx.provider,
    model: ctx.model,
    system: CONTEXT_MANAGER_SYSTEM_PROMPT,
    tools,
    confirm: async () => true,
    ask: async () => "",
    log,
    ...(ctx.eventLog && { eventLog: ctx.eventLog }),
    id: options.id ?? `${ctx.agent}/context`,
  });

  // Drive a single turn and wait for completion.
  await forkAgent.sendSync(
    `Instructions: ${instructions}\n\nMessage index:\n${index}`,
  );
  await forkAgent.stop();

  // Tool-call groups are closed by the caller (`closeToolGroups`), so a
  // partly deleted group goes as a unit.
  const deleteSet = new Set(toDelete);
  if (deleteSet.size === 0) return graph;

  const kept = graph.nodes.filter((_, i) => !deleteSet.has(i));

  // Inject condensed summary as a user message right after the system prompt.
  if (condensedSummary) {
    kept.splice(1, 0, contextNode({
      role: "user",
      content: `[This is a summary of conversation history up to this point]\n\n${condensedSummary}`,
    }));
  }
  return contextGraph(graph.agent, kept);
}

/**
 * Run the default strategy straight against a conversation (no actor, no
 * provenance).  `AgentLoop` does not use this — it runs its
 * `contextStrategy` over `projectContext` of its own log.
 */
export async function manageContextFork(
  convo: AIConversation,
  instructions: string,
  log?: (label: string, content: string) => void,
  options: ManageContextOptions = {},
): Promise<string> {
  const graph = contextFromHistory(convo.getHistory());
  log?.("MANAGE_CONTEXT", `Starting context management, ${graph.nodes.length} messages: ${instructions}`);

  const trim = await trimContext(llmContextStrategy({ id: options.id ?? "context-manager" }), graph, {
    agent: graph.agent,
    instructions,
    trigger: "tool",
    events: options.eventLog?.events() ?? [],
    ...(options.eventLog && { eventLog: options.eventLog }),
    provider: convo.provider,
    model: convo.model,
    ...(log && { log }),
  });

  if (trim.changed) {
    convo.setHistory(trim.history);
    options.onReplaced?.(trim.history, trim.removed);
  }
  const result = describeTrim(trim, graph.nodes.length);
  log?.("MANAGE_CONTEXT", result);
  return result;
}
