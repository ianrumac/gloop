/**
 * gloop-effect/Agent — Effect-native replacement for `AgentLoop`.
 *
 * Actor model:
 *   - `Queue<AgentMessage>` is the inbox.
 *   - `PubSub<AgentEvent>` is the event bus; `events` is a Stream over it.
 *   - A single loop fiber drains the inbox, one turn at a time.
 *   - Each turn forks a child fiber so `interrupt` can target just that turn.
 *
 * Lifecycle:
 *   - `Agent.make(opts)` is scoped — call it inside an `Effect.scoped` or
 *     `Layer.scoped` so the loop fiber is cleaned up when the scope closes.
 *   - `interrupt` fires the current turn's fiber; the loop keeps running.
 *   - `stop` interrupts the loop and drains the inbox.
 */

import {
  Cause,
  Chunk,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect"
import type { Skill, SpawnResult } from "@hypen-space/gloop-loop"
import {
  createInvokeSkillTool,
  mergeSkillsIntoSystem,
} from "@hypen-space/gloop-loop"
import { toEffectTool } from "./defaults/Builtins.js"
import { AIProvider } from "./AIProvider.js"
import {
  makeConversation,
  type ConversationHandle,
} from "./Conversation.js"
import {
  makeToolRegistry,
  type AnyTool,
  type Tool,
  type ToolRegistry,
} from "./Tool.js"
import {
  AgentHooksTag,
  type AgentHooks,
  type LoopConfig,
  mkWorld,
  run as runInterpreter,
} from "./Interpreter.js"
import {
  AgentInterruptedError,
  FatalAgentError,
  type AgentError,
} from "./Errors.js"
import type { MessageId, ModelId, RequestId, ToolCallId } from "./Schema.js"

// ============================================================================
// Message + Event types — re-exported from Schema.ts (single source of truth)
// ============================================================================

import type {
  AgentEvent,
  AgentEventOf,
  AgentMessage,
  AgentMessageRole,
  EnqueuedAgentMessage,
} from "./Schema.js"

export type {
  AgentEvent,
  AgentEventOf,
  AgentMessage,
  AgentMessageRole,
  EnqueuedAgentMessage,
}

// ============================================================================
// Options
// ============================================================================

export interface AgentMakeOptions {
  readonly model: ModelId | string
  readonly system?: string
  readonly skills?: ReadonlyArray<Skill>
  readonly tools?: ReadonlyArray<AnyTool>
  readonly maxTokens?: number
  readonly contextPruneInterval?: number
  readonly classifySpawn?: LoopConfig["classifySpawn"]
  /**
   * Maximum LLM calls per turn — when set (> 0), stops a runaway
   * think→invoke loop with a `FatalAgentError` instead of spinning forever.
   * Default: 0 (disabled) — opt in per host.
   */
  readonly maxIterations?: number
  /**
   * Idle timeout for a single LLM stream (ms).  If the provider produces no
   * chunk for this long the stream is cancelled and the turn fails with an
   * `AIProviderError` instead of hanging the request.  0 disables.
   * Default: 120000 (2 minutes).
   */
  readonly llmIdleTimeoutMs?: number

  /** Override the default `confirm_request` + `respondToConfirm` handshake. */
  readonly confirm?: (command: string) => Effect.Effect<boolean>
  /** Override the default `ask_request` + `respondToAsk` handshake. */
  readonly ask?: (question: string) => Effect.Effect<string>
  readonly remember?: (content: string) => Effect.Effect<void>
  readonly forget?: (content: string) => Effect.Effect<void>
  /**
   * Rebuild the base system prompt. The returned string is fed back through
   * `mergeSkillsIntoSystem` before being applied. Return `void` to keep the
   * existing prompt and just re-emit `system_refreshed`.
   */
  readonly refreshSystem?: () => Effect.Effect<string | void>
  readonly manageContext?: (
    instructions: string,
  ) => Effect.Effect<string>
  readonly installTool?: (source: string) => Effect.Effect<string>
  readonly listTools?: () => Effect.Effect<string>
  readonly spawn?: (task: string) => Effect.Effect<SpawnResult>
  /** Classify an error as fatal. Fatal errors stop the loop. */
  readonly isFatal?: (error: AgentError) => boolean
  readonly log?: (label: string, content: string) => Effect.Effect<void>
}

// ============================================================================
// Public Agent handle
// ============================================================================

export interface Agent {
  /** Enqueue a message. Returns its `MessageId` for correlation. */
  readonly send: (
    msg: AgentMessage | string,
  ) => Effect.Effect<MessageId>

  /**
   * Enqueue and await the turn's completion. Fails with the turn's
   * `AgentError`, or `AgentInterruptedError` if the turn was interrupted.
   */
  readonly sendSync: (
    msg: AgentMessage | string,
  ) => Effect.Effect<void, AgentError>

  /** Full event firehose. Each call creates a fresh subscription. */
  readonly events: Stream.Stream<AgentEvent>

  /** Filtered stream of a single event tag. */
  readonly eventsOf: <T extends AgentEvent["_tag"]>(
    tag: T,
  ) => Stream.Stream<AgentEventOf<T>>

  /** Interrupt the current turn. The loop keeps running. */
  readonly interrupt: Effect.Effect<void>

  /** Stop the loop, drain the inbox. */
  readonly stop: Effect.Effect<void>

  /** Resolves when the inbox is empty *and* no turn is running. */
  readonly awaitIdle: Effect.Effect<void>

  readonly pending: Effect.Effect<number>

  /** Register / update a tool; takes effect next turn. */
  readonly addTool: <E extends import("./Errors.js").AgentError>(
    tool: Tool<E>,
  ) => Effect.Effect<void>
  readonly removeTool: (name: string) => Effect.Effect<void>
  readonly setTools: (
    tools: ReadonlyArray<AnyTool>,
  ) => Effect.Effect<void>
  readonly setSystem: (prompt: string) => Effect.Effect<void>
  readonly clear: Effect.Effect<void>

  /** Resolve a pending `ConfirmRequest`. */
  readonly respondToConfirm: (
    id: RequestId,
    ok: boolean,
  ) => Effect.Effect<void>
  /** Resolve a pending `AskRequest`. */
  readonly respondToAsk: (
    id: RequestId,
    answer: string,
  ) => Effect.Effect<void>

  /** Snapshot access for advanced callers. */
  readonly registry: ToolRegistry
  readonly conversation: ConversationHandle
}

// ============================================================================
// Factory
// ============================================================================

export const make = (
  options: AgentMakeOptions,
): Effect.Effect<Agent, never, AIProvider | Scope.Scope> =>
  Effect.gen(function* () {
    // --- Core resources --------------------------------------------------

    const inbox = yield* Queue.unbounded<AgentMessage & { id: MessageId }>()
    const pubsub = yield* PubSub.unbounded<AgentEvent>()

    const skillsArr = [...(options.skills ?? [])]
    const userTools = options.tools ?? []

    // Auto-register InvokeSkill when skills are provided so the model can
    // call them as a tool. Users can override by passing their own tool
    // named "InvokeSkill" — explicit wins.
    const userHasInvokeSkill = userTools.some((t) => t.name === "InvokeSkill")
    const invokeSkillDef =
      !userHasInvokeSkill && skillsArr.length > 0
        ? createInvokeSkillTool(skillsArr)
        : null
    const initialTools = invokeSkillDef
      ? [toEffectTool(invokeSkillDef), ...userTools]
      : userTools

    const registry = yield* makeToolRegistry(initialTools)
    const conversation = yield* makeConversation({
      model: options.model as ModelId,
      system: mergeSkillsIntoSystem(options.system, skillsArr),
      maxTokens: options.maxTokens,
    })
    const world = mkWorld(conversation, registry)

    // --- Per-turn state --------------------------------------------------

    const currentTurn = yield* Ref.make<Option.Option<Fiber.RuntimeFiber<
      void,
      AgentError
    >>>(Option.none())
    const pendingConfirms = yield* Ref.make(
      new Map<RequestId, Deferred.Deferred<boolean>>(),
    )
    const pendingAsks = yield* Ref.make(
      new Map<RequestId, Deferred.Deferred<string>>(),
    )
    const running = yield* Ref.make(true)
    const messageCounter = yield* Ref.make(0)
    const toolIdCounter = yield* Ref.make(0)
    const requestCounter = yield* Ref.make(0)

    // --- Helpers ---------------------------------------------------------

    const publish = (event: AgentEvent) =>
      PubSub.publish(pubsub, event).pipe(Effect.asVoid)

    const nextMessageId = Ref.updateAndGet(messageCounter, (n) => n + 1).pipe(
      Effect.map((n) => `msg_${n}` as MessageId),
    )
    const nextToolId = Ref.updateAndGet(toolIdCounter, (n) => n + 1).pipe(
      Effect.map((n) => `tool_${n}` as ToolCallId),
    )
    const nextRequestId = Ref.updateAndGet(requestCounter, (n) => n + 1).pipe(
      Effect.map((n) => `req_${n}` as RequestId),
    )

    const normalize = (
      msg: AgentMessage | string,
    ): Effect.Effect<AgentMessage & { id: MessageId }> =>
      Effect.gen(function* () {
        if (typeof msg === "string") {
          const id = yield* nextMessageId
          return { id, role: "user" as const, content: msg }
        }
        const id = msg.id ?? (yield* nextMessageId)
        return { ...msg, id }
      })

    // --- Tool-id stack (mirrors toolStart → toolDone pairing) ------------

    const toolIdStack = yield* Ref.make<ReadonlyArray<ToolCallId>>([])

    // --- Hooks -----------------------------------------------------------

    const hooks: AgentHooks = {
      streamChunk: (text) => publish({ _tag: "StreamChunk", text }),
      streamDone: publish({ _tag: "StreamDone" }),

      toolStart: (name, preview) =>
        Effect.gen(function* () {
          const id = yield* nextToolId
          yield* Ref.update(toolIdStack, (s) => [...s, id])
          yield* publish({ _tag: "ToolStart", id, name, preview })
        }),

      toolDone: (name, ok, output) =>
        Effect.gen(function* () {
          const popped = yield* Ref.modify(
            toolIdStack,
            (s): readonly [Option.Option<ToolCallId>, ReadonlyArray<ToolCallId>] => {
              const last = Option.fromNullable(s.at(-1))
              return Option.isSome(last)
                ? [last, s.slice(0, -1)]
                : [Option.none(), s]
            },
          )
          const id = yield* Option.match(popped, {
            onSome: (v) => Effect.succeed(v),
            onNone: () => nextToolId,
          })
          yield* publish({ _tag: "ToolDone", id, name, ok, output })
        }),

      confirm: (command) =>
        options.confirm
          ? options.confirm(command)
          : Effect.acquireUseRelease(
              Effect.gen(function* () {
                const id = yield* nextRequestId
                const deferred = yield* Deferred.make<boolean>()
                yield* Ref.update(pendingConfirms, (m) =>
                  new Map(m).set(id, deferred),
                )
                yield* publish({ _tag: "ConfirmRequest", id, command })
                return { id, deferred }
              }),
              ({ deferred }) => Deferred.await(deferred),
              ({ id }) =>
                Ref.update(pendingConfirms, (m) => {
                  if (!m.has(id)) return m
                  const next = new Map(m)
                  next.delete(id)
                  return next
                }),
            ),

      ask: (question) =>
        options.ask
          ? options.ask(question)
          : Effect.acquireUseRelease(
              Effect.gen(function* () {
                const id = yield* nextRequestId
                const deferred = yield* Deferred.make<string>()
                yield* Ref.update(pendingAsks, (m) =>
                  new Map(m).set(id, deferred),
                )
                yield* publish({ _tag: "AskRequest", id, question })
                return { id, deferred }
              }),
              ({ deferred }) => Deferred.await(deferred),
              ({ id }) =>
                Ref.update(pendingAsks, (m) => {
                  if (!m.has(id)) return m
                  const next = new Map(m)
                  next.delete(id)
                  return next
                }),
            ),

      remember: (content) =>
        Effect.gen(function* () {
          if (options.remember) yield* options.remember(content)
          yield* publish({ _tag: "Memory", op: "remember", content })
        }),

      forget: (content) =>
        Effect.gen(function* () {
          if (options.forget) yield* options.forget(content)
          yield* publish({ _tag: "Memory", op: "forget", content })
        }),

      refreshSystem: Effect.gen(function* () {
        if (options.refreshSystem) {
          const next = yield* options.refreshSystem()
          if (typeof next === "string") {
            yield* conversation.setSystem(
              mergeSkillsIntoSystem(next, skillsArr),
            )
          }
        }
        yield* publish({ _tag: "SystemRefreshed" })
      }),

      manageContext: (instructions) =>
        options.manageContext
          ? options.manageContext(instructions)
          : Effect.succeed("Context management not configured"),

      complete: (summary) => publish({ _tag: "TaskComplete", summary }),

      installTool: (source) =>
        options.installTool
          ? options.installTool(source)
          : Effect.succeed("Tool installation not available"),

      listTools: options.listTools
        ? options.listTools()
        : registry.names.pipe(
            Effect.map(
              (names) =>
                `${names.length} tools available: ${names.join(", ")}`,
            ),
          ),

      spawn: (task) =>
        options.spawn
          ? options.spawn(task)
          : Effect.succeed<SpawnResult>({
              success: false,
              summary:
                "Spawn not configured — provide a spawn handler in options",
              exitCode: 1,
              stdout: "",
              stderr: "",
            }),

      log: (label, content) =>
        Effect.logDebug(label, { content }).pipe(
          Effect.zipRight(
            options.log ? options.log(label, content) : Effect.void,
          ),
        ),
    }

    // --- Turn runner -----------------------------------------------------

    const runTurn = (
      msg: AgentMessage & { id: MessageId },
    ): Effect.Effect<void, AgentError, AIProvider> => {
      const work =
        msg.role === "system"
          ? conversation
              .setSystem(msg.content)
              .pipe(Effect.zipRight(publish({ _tag: "SystemRefreshed" })))
          : runInterpreter(msg.content, world, {
              classifySpawn: options.classifySpawn,
              contextPruneInterval: options.contextPruneInterval,
              maxIterations: options.maxIterations,
              llmIdleTimeoutMs: options.llmIdleTimeoutMs,
              skills: skillsArr,
            }).pipe(Effect.provideService(AgentHooksTag, hooks))

      return work.pipe(
        Effect.withSpan("Agent.runTurn", {
          attributes: {
            messageId: msg.id,
            role: msg.role,
            contentLength: msg.content.length,
          },
        }),
      )
    }

    // --- Main loop -------------------------------------------------------

    // Queue.size returns the element count; when the loop is parked on
    // take() with no elements, the raw size goes negative (one per waiter).
    // On a shut-down queue Queue.size fails with an interrupt — semantically
    // "no pending work", so collapse both to 0.
    const clampedSize = Queue.size(inbox).pipe(
      Effect.map((n) => Math.max(0, n)),
      Effect.catchAllCause(() => Effect.succeed(0)),
    )

    const runLoop: Effect.Effect<void, never, AIProvider> = Effect.gen(
      function* () {
        yield* publish({ _tag: "Idle" })

        while (yield* Ref.get(running)) {
          const msg = yield* Queue.take(inbox).pipe(
            Effect.catchAllCause(() => Effect.succeed(null)),
          )
          if (msg === null || !(yield* Ref.get(running))) break
          yield* publish({
            _tag: "QueueChanged",
            pending: yield* clampedSize,
          })
          yield* publish({ _tag: "Busy" })
          yield* publish({ _tag: "TurnStart", message: msg })

          const fiber = yield* Effect.fork(runTurn(msg))
          yield* Ref.set(currentTurn, Option.some(fiber))
          const exit = yield* Fiber.await(fiber)
          yield* Ref.set(currentTurn, Option.none())

          // Reset per-turn state.
          yield* Ref.set(toolIdStack, [])

          if (Exit.isSuccess(exit)) {
            // nothing — success path
          } else if (Cause.isInterruptedOnly(exit.cause)) {
            yield* publish({ _tag: "Interrupted" })
          } else {
            const err = firstFailure(exit.cause) ??
              new FatalAgentError({
                message: "Unknown turn error",
                cause: Cause.pretty(exit.cause),
              })
            if (options.isFatal?.(err) || err._tag === "FatalAgentError") {
              yield* Ref.set(running, false)
              // Drain inbox so stop() doesn't wait on stale work.
              yield* Queue.takeAll(inbox)
              yield* publish({ _tag: "Fatal", error: err })
            } else {
              yield* publish({ _tag: "Error", error: err })
            }
          }

          yield* publish({ _tag: "TurnEnd" })

          const size = yield* clampedSize
          if (size === 0 && (yield* Ref.get(running))) {
            yield* publish({ _tag: "Idle" })
          }
        }
      },
    )

    // --- Fork the loop ---------------------------------------------------

    const loopFiber = yield* Effect.forkScoped(runLoop)

    // Tear everything down when the outer scope closes.
    yield* Effect.addFinalizer(() =>
      Ref.set(running, false).pipe(
        Effect.zipRight(Queue.shutdown(inbox)),
        Effect.zipRight(PubSub.shutdown(pubsub)),
        Effect.zipRight(Fiber.interrupt(loopFiber)),
      ),
    )

    // --- Public API ------------------------------------------------------

    const send: Agent["send"] = Effect.fn("Agent.send")(function* (raw) {
      const msg = yield* normalize(raw)
      yield* Effect.annotateCurrentSpan("messageId", msg.id)
      yield* Queue.offer(inbox, msg)
      yield* publish({
        _tag: "QueueChanged",
        pending: yield* clampedSize,
      })
      return msg.id
    })

    const sendSync: Agent["sendSync"] = (raw) =>
      Effect.fn("Agent.sendSync")(function* () {
        const msg = yield* normalize(raw)
        yield* Effect.annotateCurrentSpan("messageId", msg.id)
        // Subscribe *before* offering so we can't race past TurnStart.
        const subscription = yield* PubSub.subscribe(pubsub)
        yield* Queue.offer(inbox, msg)
        yield* publish({
          _tag: "QueueChanged",
          pending: yield* clampedSize,
        })

        let ours = false
        let err: AgentError | undefined

        while (true) {
          const event = yield* Queue.take(subscription)
          if (event._tag === "TurnStart" && event.message.id === msg.id) {
            ours = true
            continue
          }
          if (!ours) continue
          if (event._tag === "Error" || event._tag === "Fatal") {
            err = event.error
          } else if (event._tag === "Interrupted") {
            err = new AgentInterruptedError({ message: "Turn interrupted" })
          } else if (event._tag === "TurnEnd") {
            if (err) return yield* Effect.fail(err)
            return
          }
        }
      })().pipe(Effect.scoped)

    const events: Stream.Stream<AgentEvent> = Stream.fromPubSub(pubsub)

    const eventsOf = <T extends AgentEvent["_tag"]>(tag: T) =>
      events.pipe(
        Stream.filter(
          (e): e is AgentEventOf<T> => e._tag === tag,
        ),
      )

    const interrupt: Agent["interrupt"] = Effect.fn("Agent.interrupt")(
      function* () {
        const maybe = yield* Ref.get(currentTurn)
        if (Option.isSome(maybe)) {
          yield* Fiber.interrupt(maybe.value)
        }
        // Unblock any pending confirm/ask with a safe default so the turn
        // can wind down quickly.
        const confirms = yield* Ref.getAndSet(pendingConfirms, new Map())
        for (const [, d] of confirms) yield* Deferred.succeed(d, false)
        const asks = yield* Ref.getAndSet(pendingAsks, new Map())
        for (const [, d] of asks) yield* Deferred.succeed(d, "")
      },
    )()

    const stop: Agent["stop"] = Effect.fn("Agent.stop")(function* () {
      yield* Ref.set(running, false)
      yield* Queue.takeAll(inbox)
      yield* interrupt
      yield* Queue.shutdown(inbox)
      yield* Fiber.await(loopFiber)
    })()

    const awaitIdle: Agent["awaitIdle"] = Effect.fn("Agent.awaitIdle")(
      function* () {
        const size = yield* Queue.size(inbox)
        const active = yield* Ref.get(currentTurn)
        if (size === 0 && Option.isNone(active)) return
        yield* eventsOf("Idle").pipe(Stream.take(1), Stream.runDrain)
      },
    )().pipe(Effect.scoped)

    const pending: Agent["pending"] = clampedSize

    const addTool: Agent["addTool"] = (tool) => registry.register(tool)
    const removeTool: Agent["removeTool"] = (name) => registry.unregister(name)
    const setTools: Agent["setTools"] = (tools) => registry.replace(tools)
    const setSystem: Agent["setSystem"] = (prompt) =>
      conversation.setSystem(mergeSkillsIntoSystem(prompt, skillsArr))
    const clear: Agent["clear"] = conversation.clear

    const respondToConfirm: Agent["respondToConfirm"] = Effect.fn(
      "Agent.respondToConfirm",
    )(function* (id, ok) {
      yield* Effect.annotateCurrentSpan("requestId", id)
      const m = yield* Ref.get(pendingConfirms)
      const d = m.get(id)
      if (!d) return
      yield* Ref.update(pendingConfirms, (prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      yield* Deferred.succeed(d, ok)
    })

    const respondToAsk: Agent["respondToAsk"] = Effect.fn(
      "Agent.respondToAsk",
    )(function* (id, answer) {
      yield* Effect.annotateCurrentSpan("requestId", id)
      const m = yield* Ref.get(pendingAsks)
      const d = m.get(id)
      if (!d) return
      yield* Ref.update(pendingAsks, (prev) => {
        const next = new Map(prev)
        next.delete(id)
        return next
      })
      yield* Deferred.succeed(d, answer)
    })

    return {
      send,
      sendSync,
      events,
      eventsOf,
      interrupt,
      stop,
      awaitIdle,
      pending,
      addTool,
      removeTool,
      setTools,
      setSystem,
      clear,
      respondToConfirm,
      respondToAsk,
      registry,
      conversation,
    } satisfies Agent
  })

// ============================================================================
// Helpers
// ============================================================================

const firstFailure = (cause: Cause.Cause<AgentError>): AgentError | undefined => {
  const failures = Chunk.toReadonlyArray(Cause.failures(cause))
  return failures[0]
}

// ============================================================================
// Namespace export for ergonomic `Agent.make(...)`
// ============================================================================

export const Agent = { make }
