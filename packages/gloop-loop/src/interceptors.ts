/**
 * gloop-loop/interceptors — Onion-middleware around every interpreter boundary.
 *
 * Each interceptor is a record of optional async functions, one per boundary
 * (`llmCall`, `toolCall`, `confirm`, `ask`, `memory`, `spawn`). The shape is
 * Koa/Express-style: each function receives a typed context plus `next` and
 * can:
 *
 *   - **Observe** — call `next(ctx)` and inspect the result
 *   - **Mutate input** — call `next({ ...ctx, input: rewritten })`
 *   - **Mutate output** — transform the value returned by `next`
 *   - **Short-circuit** — return a synthetic result without calling `next`
 *   - **Retry** — call `next` more than once
 *   - **Time / log** — wrap the call with timing or telemetry
 *
 * Interceptors compose left-to-right: `interceptors[0]` is the outermost
 * wrapper; the final handler (the real LLM call / tool execute / etc.) is
 * the innermost.  When no interceptor is configured for a boundary, the
 * boundary runs unwrapped — zero overhead.
 *
 * @example  Redact + retry
 * ```ts
 * const interceptors: Interceptor[] = [
 *   { name: "redact",   llmCall: async (ctx, next) => next({ ...ctx, input: redact(ctx.input) }) },
 *   { name: "retry",    llmCall: async (ctx, next) => {
 *       try { return await next(ctx) }
 *       catch { return await next(ctx) }
 *     } },
 *   { name: "log-tool", toolCall: async (ctx, next) => {
 *       const t = Date.now()
 *       const r = await next(ctx)
 *       console.log(`[${ctx.name}] ${Date.now() - t}ms ok=${r.success}`)
 *       return r
 *     } },
 * ]
 *
 * new AgentLoop({ provider, model, interceptors })
 * ```
 */

import type { FinishReason, JsonTool, JsonToolCall, Message } from "./ai/types.js";
import type { SpawnResult } from "./core/core.js";

// ============================================================================
// Per-boundary contexts and outputs
// ============================================================================

/** Context passed into the LLM-call interceptor chain. */
export interface LlmCallContext {
  /** The user prompt for this turn (mutable via `next({ ...ctx, input })`). */
  readonly input: string;
  /** Model identifier. Observable only — not used for routing inside the chain. */
  readonly model: string;
  /** Snapshot of the conversation history at request time. Observable. */
  readonly messages: ReadonlyArray<Message>;
  /** Tools advertised to the model for this request. Observable. */
  readonly tools: ReadonlyArray<JsonTool>;
}

/** Output of the LLM-call boundary: full assembled text + any tool calls. */
export interface LlmCallResult {
  readonly text: string;
  readonly toolCalls: ReadonlyArray<JsonToolCall>;
  readonly finishReason: FinishReason;
}

/** Context passed into the tool-call interceptor chain. */
export interface ToolCallContext {
  /** Tool name as routed by the registry. Mutable via `next({ ...ctx, name })`. */
  readonly name: string;
  /** Argument record (string-coerced). Mutable. */
  readonly args: Record<string, string>;
}

/** Output of the tool-call boundary. Mirrors `ToolResult`'s success-vs-error shape. */
export type ToolCallResult =
  | { readonly success: true; readonly output: string }
  | { readonly success: false; readonly output: string; readonly error?: unknown };

/** Context for memory writes. */
export interface MemoryContext {
  readonly op: "remember" | "forget";
  readonly content: string;
}

/** Context for `Confirm` forms (and for tool permission gating). */
export interface ConfirmContext {
  readonly command: string;
}

/** Context for `Ask` forms (and the `AskUser` builtin). */
export interface AskContext {
  readonly question: string;
}

/** Context for `Spawn` forms. */
export interface SpawnContext {
  readonly task: string;
}

// ============================================================================
// Function shape and Interceptor record
// ============================================================================

/**
 * The Koa-shaped middleware function type. The handler receives a context,
 * an optional pre-existing accumulator, and a `next` callable that returns
 * a Promise of the boundary's output. The handler returns its own Promise
 * of the output (typically derived from `next`).
 */
export type InterceptorFn<Ctx, Out> = (
  ctx: Ctx,
  next: (ctx: Ctx) => Promise<Out>,
) => Promise<Out>;

export interface Interceptor {
  /** Optional name for debugging / span attributes. */
  readonly name?: string;
  readonly llmCall?: InterceptorFn<LlmCallContext, LlmCallResult>;
  readonly toolCall?: InterceptorFn<ToolCallContext, ToolCallResult>;
  readonly confirm?: InterceptorFn<ConfirmContext, boolean>;
  readonly ask?: InterceptorFn<AskContext, string>;
  readonly memory?: InterceptorFn<MemoryContext, void>;
  readonly spawn?: InterceptorFn<SpawnContext, SpawnResult>;
}

// ============================================================================
// Chain builder
// ============================================================================

/**
 * Compose a list of interceptor functions into a single callable that
 * eventually runs `finalHandler`. Each interceptor is bound to its own
 * position so that calling `next` more than once (e.g. for retry) re-enters
 * the chain cleanly from the next position rather than skipping siblings.
 *
 * @example
 * ```ts
 * const run = chain(
 *   interceptors.map((i) => i.toolCall).filter((fn): fn is InterceptorFn<ToolCallContext, ToolCallResult> => !!fn),
 *   async (ctx) => realToolExecute(ctx),
 * )
 * const result = await run({ name: "Echo", args: { text: "hi" } })
 * ```
 */
export function chain<Ctx, Out>(
  interceptors: ReadonlyArray<InterceptorFn<Ctx, Out> | undefined>,
  finalHandler: (ctx: Ctx) => Promise<Out>,
): (ctx: Ctx) => Promise<Out> {
  const active: ReadonlyArray<InterceptorFn<Ctx, Out>> = interceptors.filter(
    (fn): fn is InterceptorFn<Ctx, Out> => fn != null,
  );
  if (active.length === 0) return finalHandler;

  const dispatch = (i: number): ((ctx: Ctx) => Promise<Out>) => {
    return (ctx: Ctx) => {
      if (i >= active.length) return finalHandler(ctx);
      return active[i]!(ctx, dispatch(i + 1));
    };
  };
  return dispatch(0);
}

/**
 * Pluck a per-boundary fn from each `Interceptor` (preserving order, dropping
 * undefined) and wrap with `chain`. Convenience for boundary callsites.
 */
export function chainBoundary<K extends keyof Omit<Interceptor, "name">>(
  interceptors: ReadonlyArray<Interceptor> | undefined,
  boundary: K,
  finalHandler: (ctx: BoundaryCtx<K>) => Promise<BoundaryOut<K>>,
): (ctx: BoundaryCtx<K>) => Promise<BoundaryOut<K>> {
  if (!interceptors || interceptors.length === 0) return finalHandler;
  type Fn = InterceptorFn<BoundaryCtx<K>, BoundaryOut<K>>;
  const fns: Array<Fn | undefined> = interceptors.map(
    (i) => i[boundary] as Fn | undefined,
  );
  return chain<BoundaryCtx<K>, BoundaryOut<K>>(fns, finalHandler);
}

// ----------------------------------------------------------------------------
// Boundary mapping (internal)
// ----------------------------------------------------------------------------

type BoundaryCtxMap = {
  llmCall: LlmCallContext;
  toolCall: ToolCallContext;
  confirm: ConfirmContext;
  ask: AskContext;
  memory: MemoryContext;
  spawn: SpawnContext;
};

type BoundaryOutMap = {
  llmCall: LlmCallResult;
  toolCall: ToolCallResult;
  confirm: boolean;
  ask: string;
  memory: void;
  spawn: SpawnResult;
};

type BoundaryCtx<K extends keyof BoundaryCtxMap> = BoundaryCtxMap[K];
type BoundaryOut<K extends keyof BoundaryOutMap> = BoundaryOutMap[K];
