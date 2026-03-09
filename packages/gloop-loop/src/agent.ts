/**
 * AgentLoop — the high-level entry point for gloop-loop.
 *
 * Wires together AI, tools, effects, and the core loop into a single
 * object that works out of the box.
 *
 * @example
 * ```ts
 * import { AgentLoop, OpenRouterProvider } from "@anthropic/gloop-loop";
 *
 * const agent = new AgentLoop({
 *   provider: new OpenRouterProvider({ apiKey: process.env.OPENROUTER_API_KEY! }),
 *   model: "anthropic/claude-sonnet-4",
 *   system: "You are a helpful coding assistant.",
 * });
 *
 * await agent.run("What files are in the current directory?");
 * ```
 */

import type { AIProvider } from "./ai/types.ts";
import { AI, type AIConversation } from "./ai/builder.ts";
import { ToolRegistry } from "./tools/registry.ts";
import { registerBuiltins, type BuiltinIO } from "./tools/builtins.ts";
import type { ToolDefinition } from "./tools/types.ts";
import { run, mkWorld, type Effects, type LoopConfig, type World, AbortError } from "./core/core.ts";
import { createNodeIO } from "./defaults/io.ts";
import { createEffects, type DefaultEffectsOptions } from "./defaults/effects.ts";

// ============================================================================
// Configuration
// ============================================================================

export interface AgentLoopOptions {
  /** AI provider (e.g. new OpenRouterProvider({ apiKey: "..." })) */
  provider: AIProvider;
  /** Model identifier (e.g. "anthropic/claude-sonnet-4") */
  model: string;
  /** System prompt */
  system?: string;
  /** Custom BuiltinIO implementation. Default: Node.js fs + child_process */
  io?: BuiltinIO;
  /** Additional tools to register beyond the builtins */
  tools?: ToolDefinition[];

  // --- Effect overrides (all optional) ---
  /** Override text streaming. Default: process.stdout.write */
  onStream?: (text: string) => void;
  /** Override tool status reporting. Default: stderr log */
  onToolStatus?: (name: string, status: string) => void;
  /** Override user question prompt. Default: readline stdin */
  ask?: (question: string) => Promise<string>;
  /** Override confirmation prompt. Default: readline stdin y/N */
  confirm?: (command: string) => Promise<boolean>;
  /** Override completion handler. Default: stderr log */
  onComplete?: (summary: string) => void;
  /** Override remember. Default: .gloop/memory.md */
  remember?: (content: string) => Promise<void>;
  /** Override forget. Default: .gloop/memory.md */
  forget?: (content: string) => Promise<void>;
  /** Override system prompt refresh */
  refreshSystem?: () => Promise<void>;
  /** Override spawn (subagent) */
  spawn?: DefaultEffectsOptions["spawn"];
  /** Debug logger */
  log?: (label: string, content: string) => void;

  // --- Loop config ---
  /** Number of tool calls between automatic context prune. Default: 50 */
  contextPruneInterval?: number;
  /** Classify tool calls as spawn tasks */
  classifySpawn?: LoopConfig["classifySpawn"];

  /** AbortSignal for cancellation */
  signal?: AbortSignal;
}

// ============================================================================
// AgentLoop
// ============================================================================

export class AgentLoop {
  readonly registry: ToolRegistry;
  readonly convo: AIConversation;
  readonly effects: Effects;
  readonly world: World;

  private loopConfig: LoopConfig;

  constructor(opts: AgentLoopOptions) {
    // 1. Build tool registry
    this.registry = new ToolRegistry();
    const io = opts.io ?? createNodeIO();
    registerBuiltins(this.registry, io);

    // Register any extra tools
    if (opts.tools) {
      for (const tool of opts.tools) {
        this.registry.register(tool);
      }
    }

    // 2. Build conversation
    const ai = new AI(opts.provider, opts.model);
    this.convo = ai.conversation({ model: opts.model, system: opts.system });

    // 3. Build effects
    this.effects = createEffects({
      convo: this.convo,
      registry: this.registry,
      onStream: opts.onStream,
      onToolStatus: opts.onToolStatus,
      ask: opts.ask,
      confirm: opts.confirm,
      onComplete: opts.onComplete,
      remember: opts.remember,
      forget: opts.forget,
      refreshSystem: opts.refreshSystem,
      spawn: opts.spawn,
      log: opts.log,
    });

    // 4. Build world
    this.world = mkWorld(this.convo, this.registry, opts.signal);

    // 5. Loop config
    this.loopConfig = {
      contextPruneInterval: opts.contextPruneInterval,
      classifySpawn: opts.classifySpawn,
    };
  }

  /**
   * Run a single turn of the agent loop.
   *
   * The agent will think, invoke tools, ask questions, manage context,
   * and recurse until it reaches a terminal state (Done/Nil) or is aborted.
   */
  async run(input: string): Promise<void> {
    return run(input, this.world, this.effects, this.loopConfig);
  }

  /** Clear conversation history */
  clear(): this {
    this.convo.clear();
    this.world.toolCalls = 0;
    return this;
  }

  /** Register an additional tool */
  addTool(tool: ToolDefinition): this {
    this.registry.register(tool);
    return this;
  }

  /** Update the system prompt */
  setSystem(prompt: string): this {
    this.convo.setSystem(prompt);
    return this;
  }
}
