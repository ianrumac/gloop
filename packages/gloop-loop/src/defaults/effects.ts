/**
 * Default Effects — working out-of-the-box effects for the agent loop.
 *
 * - Streams to stdout
 * - Tool status to stderr
 * - Ask/Confirm via stdin readline
 * - File-backed memory (.gloop/memory.md)
 * - Real context management via conversation fork
 * - Spawn returns a not-available stub (override if needed)
 */

import { createInterface } from "node:readline";
import type { AIConversation } from "../ai/builder.js";
import type { Effects } from "../core/core.js";
import { appendMemory, removeMemory } from "./memory.js";
import { manageContextFork } from "./context-manager.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface DefaultEffectsOptions {
  /** The conversation — needed for manageContext. */
  convo: AIConversation;
  /** The tool registry — needed for listTools. */
  registry: ToolRegistry;
  /** Override how text is streamed to the user. Default: process.stdout.write */
  onStream?: (text: string) => void;
  /** Override how tool status is reported. Default: stderr log */
  onToolStatus?: (name: string, status: string) => void;
  /** Override ask — prompt the user for input. Default: readline from stdin */
  ask?: (question: string) => Promise<string>;
  /** Override confirm — ask the user for yes/no. Default: readline from stdin */
  confirm?: (command: string) => Promise<boolean>;
  /** Override completion handler. Default: log to stderr */
  onComplete?: (summary: string) => void;
  /** Override remember. Default: append to .gloop/memory.md */
  remember?: (content: string) => Promise<void>;
  /** Override forget. Default: remove from .gloop/memory.md */
  forget?: (content: string) => Promise<void>;
  /** Override system prompt refresh. Default: no-op */
  refreshSystem?: () => Promise<void>;
  /** Override spawn. Default: returns error stub */
  spawn?: (task: string) => Promise<{
    success: boolean;
    summary: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
  /** Debug logger */
  log?: (label: string, content: string) => void;
}

function readlineAsk(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export function createEffects(opts: DefaultEffectsOptions): Effects {
  const stream = opts.onStream ?? ((text: string) => process.stdout.write(text));
  const toolStatus = opts.onToolStatus ?? ((name: string, status: string) => {
    process.stderr.write(`  [${name}] ${status}\n`);
  });

  return {
    streamChunk: stream,
    streamDone: () => stream("\n"),

    toolStart: (name, preview) => toolStatus(name, preview),
    toolDone: (name, ok, output) => {
      toolStatus(name, ok ? "done" : `error: ${output.slice(0, 100)}`);
    },

    confirm: opts.confirm ?? (async (command) => {
      const answer = await readlineAsk(`Allow: ${command}? [y/N] `);
      return answer.trim().toLowerCase().startsWith("y");
    }),

    ask: opts.ask ?? (async (question) => {
      return readlineAsk(`${question}\n> `);
    }),

    remember: opts.remember ?? appendMemory,
    forget: opts.forget ?? removeMemory,

    refreshSystem: opts.refreshSystem ?? (async () => {}),

    manageContext: async (instructions) => {
      return manageContextFork(opts.convo, instructions, opts.log);
    },

    complete: opts.onComplete ?? ((summary) => {
      process.stderr.write(`\n✓ ${summary}\n`);
    }),

    installTool: async () => "Tool installation not available in default effects",

    listTools: () => {
      const names = opts.registry.names();
      return `${names.length} tools available: ${names.join(", ")}`;
    },

    spawn: opts.spawn ?? (async () => ({
      success: false,
      summary: "Spawn not configured — provide a spawn handler in effects options",
      exitCode: 1,
      stdout: "",
      stderr: "",
    })),

    log: opts.log,
  };
}
