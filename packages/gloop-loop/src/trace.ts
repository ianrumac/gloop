/**
 * gloop-loop/trace — Optional, dependency-free tracing.
 *
 * The shapes (`Tracer`, `Span`, `SpanOptions`, `AttributeValue`) are a
 * minimal subset of the OpenTelemetry API so a real OTEL tracer can be
 * adapted in a few lines:
 *
 *     import { trace } from "@opentelemetry/api";
 *     const tracer = adaptOtel(trace.getTracer("my-app"));
 *     new AgentLoop({ ..., tracer });
 *
 * For local debugging, `new ConsoleTracer()` prints an indented duration
 * tree as spans complete.  When `tracer` is undefined, every wrapper
 * short-circuits — zero runtime cost.
 *
 * Parent linkage is **explicit**: spans take an optional `parent` in
 * `SpanOptions`. The interpreter threads the current span via `World.span`
 * so nested calls inherit automatically.
 */

// ============================================================================
// Public types — OTEL-shaped
// ============================================================================

export type AttributeValue = string | number | boolean | undefined

export interface SpanOptions {
  /** Attributes attached at span start. More can be added via `setAttribute`. */
  attributes?: Record<string, AttributeValue>;
  /** Explicit parent span. If omitted, the span has no parent. */
  parent?: Span;
}

export interface SpanStatus {
  code: "ok" | "error" | "unset";
  message?: string;
}

export interface Span {
  setAttribute(key: string, value: AttributeValue): void;
  setAttributes(attrs: Record<string, AttributeValue>): void;
  recordException(error: unknown): void;
  setStatus(status: SpanStatus): void;
  addEvent(name: string, attributes?: Record<string, AttributeValue>): void;
  end(endTime?: number): void;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
}

// ============================================================================
// NoopTracer — the implicit default when no tracer is provided.
// ============================================================================

const NOOP_SPAN: Span = {
  setAttribute() {},
  setAttributes() {},
  recordException() {},
  setStatus() {},
  addEvent() {},
  end() {},
};

export const NoopTracer: Tracer = {
  startSpan: () => NOOP_SPAN,
};

// ============================================================================
// ConsoleTracer — parent-aware tree renderer, prints on span.end().
// ============================================================================

interface ConsoleSpanState {
  name: string;
  start: number;
  attrs: Record<string, AttributeValue>;
  status: SpanStatus;
  events: Array<{ name: string; attrs?: Record<string, AttributeValue>; t: number }>;
  depth: number;
  ended: boolean;
}

export interface ConsoleTracerOptions {
  /** Where to write each span line. Defaults to `console.log`. */
  sink?: (line: string) => void;
  /** If true, attribute values are JSON-stringified rather than coerced. */
  jsonAttrs?: boolean;
  /** If true, span events are printed inline beneath the span. */
  showEvents?: boolean;
}

export class ConsoleTracer implements Tracer {
  private readonly states = new WeakMap<Span, ConsoleSpanState>();
  private readonly sink: (line: string) => void;
  private readonly jsonAttrs: boolean;
  private readonly showEvents: boolean;

  constructor(options: ConsoleTracerOptions = {}) {
    this.sink = options.sink ?? ((line) => console.log(line));
    this.jsonAttrs = options.jsonAttrs ?? false;
    this.showEvents = options.showEvents ?? true;
  }

  startSpan(name: string, options?: SpanOptions): Span {
    const parentState = options?.parent ? this.states.get(options.parent) : undefined;
    const depth = (parentState?.depth ?? -1) + 1;
    const state: ConsoleSpanState = {
      name,
      start: Date.now(),
      attrs: { ...(options?.attributes ?? {}) },
      status: { code: "unset" },
      events: [],
      depth,
      ended: false,
    };

    const sink = this.sink;
    const jsonAttrs = this.jsonAttrs;
    const showEvents = this.showEvents;
    const fmtAttrs = (a: Record<string, AttributeValue>): string => {
      const entries = Object.entries(a).filter(([, v]) => v !== undefined);
      if (entries.length === 0) return "";
      return (
        " " +
        entries
          .map(([k, v]) => {
            const value = jsonAttrs ? JSON.stringify(v) : String(v);
            return `${k}=${value}`;
          })
          .join(" ")
      );
    };

    const span: Span = {
      setAttribute(key, value) {
        state.attrs[key] = value;
      },
      setAttributes(attrs) {
        Object.assign(state.attrs, attrs);
      },
      recordException(err) {
        state.events.push({
          name: "exception",
          attrs: { message: err instanceof Error ? err.message : String(err) },
          t: Date.now(),
        });
      },
      setStatus(status) {
        state.status = status;
      },
      addEvent(name, attributes) {
        state.events.push({ name, attrs: attributes, t: Date.now() });
      },
      end() {
        if (state.ended) return;
        state.ended = true;
        const dur = Date.now() - state.start;
        const indent = "  ".repeat(state.depth);
        const mark = state.status.code === "error" ? " ✗" : state.status.code === "ok" ? " ✓" : "";
        sink(`${indent}${state.name} (${dur}ms)${fmtAttrs(state.attrs)}${mark}`);
        if (state.status.code === "error" && state.status.message) {
          sink(`${indent}  ↳ ${state.status.message}`);
        }
        if (showEvents) {
          for (const event of state.events) {
            const evtAttrs = event.attrs ? fmtAttrs(event.attrs) : "";
            sink(`${indent}  · ${event.name}${evtAttrs}`);
          }
        }
      },
    };

    this.states.set(span, state);
    return span;
  }
}

// ============================================================================
// Helpers — wrap a callable with a span.  Cheap enough to pepper through
// the interpreter; when tracer is undefined we skip the whole thing.
// ============================================================================

/**
 * Wrap a Promise-returning function with a span.  Sets `ok`/`error` status
 * automatically, records exceptions, and ends the span in a `finally`.
 *
 * If `tracer` is undefined the function runs without instrumentation and
 * receives the noop span — callers can still call `setAttribute` etc.
 * unconditionally.
 */
export async function withSpan<T>(
  tracer: Tracer | undefined,
  name: string,
  options: SpanOptions | undefined,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  if (!tracer) return fn(NOOP_SPAN);
  const span = tracer.startSpan(name, options);
  try {
    const result = await fn(span);
    if (span === NOOP_SPAN) return result;
    span.setStatus({ code: "ok" });
    return result;
  } catch (err) {
    span.recordException(err);
    span.setStatus({
      code: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}

/** Synchronous variant of `withSpan` for non-async callsites. */
export function withSpanSync<T>(
  tracer: Tracer | undefined,
  name: string,
  options: SpanOptions | undefined,
  fn: (span: Span) => T,
): T {
  if (!tracer) return fn(NOOP_SPAN);
  const span = tracer.startSpan(name, options);
  try {
    const result = fn(span);
    span.setStatus({ code: "ok" });
    return result;
  } catch (err) {
    span.recordException(err);
    span.setStatus({
      code: "error",
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    span.end();
  }
}
