/**
 * gloop-effect/Conversation — Effect-native replacement for AIConversation.
 *
 * Conversation state (history, system prompt, tools, maxTokens) is held in a
 * `Ref`. Sends and streams thread the current state through an `AIProvider`
 * request, then append the resulting assistant message back to history.
 *
 * Created per-agent via `makeConversation` — not a singleton service. This
 * mirrors the resource-ownership model of the actor.
 */

import { Effect, Ref, Stream } from "effect"
import type { JsonTool, Message, ProviderRouting } from "@hypen-space/gloop-loop"
import { AIProvider, type StreamResponse } from "./AIProvider.js"
import type { AIProviderError } from "./Errors.js"
import type { ModelId } from "./Schema.js"

// ============================================================================
// State
// ============================================================================

interface ConversationState {
  readonly systemPrompt: string | undefined
  readonly history: ReadonlyArray<Message>
  readonly maxTokens: number
  readonly jsonTools: ReadonlyArray<JsonTool>
  readonly providerRouting: ProviderRouting | undefined
}

const initialState = (
  systemPrompt: string | undefined,
  maxTokens: number,
): ConversationState => ({
  systemPrompt,
  history: [],
  maxTokens,
  jsonTools: [],
  providerRouting: undefined,
})

// ============================================================================
// Public interface
// ============================================================================

export interface ConversationHandle {
  readonly model: ModelId

  /** One-shot request — appends user + assistant messages to history. */
  readonly send: (
    content: string,
  ) => Effect.Effect<string, AIProviderError, AIProvider>

  /**
   * Streaming request. The returned `StreamResponse` is a pointer to the
   * in-flight request; the assistant message is committed to history after
   * the result resolves (or when the stream is cancelled with partial text).
   */
   readonly stream: (
    content: string,
  ) => Effect.Effect<StreamResponse, never, AIProvider>

  /**
   * Streaming request from the CURRENT history without appending a new user
   * message.  Used after tool results have been written into history as
   * native `role: "tool"` messages — the model responds to those directly.
   */
  readonly streamContinue: Effect.Effect<StreamResponse, never, AIProvider>

  readonly clear: Effect.Effect<void>
  readonly fork: Effect.Effect<ConversationHandle, never, AIProvider>
  readonly setSystem: (prompt: string | undefined) => Effect.Effect<void>
  readonly getSystem: Effect.Effect<string | undefined>
  readonly setJsonTools: (tools: ReadonlyArray<JsonTool>) => Effect.Effect<void>
  readonly clearJsonTools: Effect.Effect<void>
  readonly setMaxTokens: (n: number) => Effect.Effect<void>
  readonly setProviderRouting: (
    routing: ProviderRouting | undefined,
  ) => Effect.Effect<void>
  readonly getHistory: Effect.Effect<ReadonlyArray<Message>>
  readonly setHistory: (messages: ReadonlyArray<Message>) => Effect.Effect<void>
  readonly appendAssistant: (text: string) => Effect.Effect<void>
}

// ============================================================================
// Factory
// ============================================================================

export interface ConversationOptions {
  readonly model: ModelId
  readonly system?: string
  readonly maxTokens?: number
}

export const makeConversation = (
  options: ConversationOptions,
): Effect.Effect<ConversationHandle, never, AIProvider> =>
  Effect.gen(function* () {
    const provider = yield* AIProvider
    const state = yield* Ref.make(
      initialState(options.system, options.maxTokens ?? 262_144),
    )

    const buildMessages = (
      st: ConversationState,
      newUser: string,
    ): ReadonlyArray<Message> => {
      const msgs: Message[] = []
      if (st.systemPrompt) msgs.push({ role: "system", content: st.systemPrompt })
      msgs.push(...st.history)
      msgs.push({ role: "user", content: newUser })
      return msgs
    }

    const send = Effect.fn("Conversation.send")(function* (content: string) {
      const st = yield* Ref.get(state)
      yield* Effect.annotateCurrentSpan("model", options.model)
      yield* Effect.annotateCurrentSpan("historyLength", st.history.length)
      yield* Effect.annotateCurrentSpan("toolCount", st.jsonTools.length)
      const response = yield* provider.complete({
        model: options.model,
        messages: [...buildMessages(st, content)],
        maxTokens: st.maxTokens,
        tools: st.jsonTools.length > 0 ? [...st.jsonTools] : undefined,
        provider: st.providerRouting,
      })
      const assistant = response.content ?? ""
      yield* Ref.update(state, (s) => ({
        ...s,
        history: [
          ...s.history,
          { role: "user", content } as const,
          { role: "assistant", content: assistant } as const,
        ],
      }))
      return assistant
    })

    // Shared streaming body: request from the CURRENT state (system prompt +
    // history), commit the assistant text back when the stream resolves (or
    // is cancelled with partial text).
    const streamFromHistory = Effect.fn("Conversation.streamFromHistory")(function* () {
      const st = yield* Ref.get(state)
      yield* Effect.annotateCurrentSpan("model", options.model)
      yield* Effect.annotateCurrentSpan("historyLength", st.history.length)
      yield* Effect.annotateCurrentSpan("toolCount", st.jsonTools.length)
      const msgs: Message[] = []
      if (st.systemPrompt) msgs.push({ role: "system", content: st.systemPrompt })
      msgs.push(...st.history)
      const baseStream = provider.stream({
        model: options.model,
        messages: msgs,
        maxTokens: st.maxTokens,
        tools: st.jsonTools.length > 0 ? [...st.jsonTools] : undefined,
        provider: st.providerRouting,
      })

      // Capture chunks as they flow so a cancel can still write a partial
      // assistant message to history.
      const bufferRef = yield* Ref.make("")
      const chunks = baseStream.chunks.pipe(
        Stream.tap((chunk) => Ref.update(bufferRef, (b) => b + chunk)),
      )

      const commitAssistant = Ref.get(bufferRef).pipe(
        Effect.flatMap((text) =>
          text.length === 0
            ? Effect.void
            : Ref.update(state, (s) => ({
                ...s,
                history: [...s.history, { role: "assistant", content: text } as const],
              })),
        ),
      )

      const result = baseStream.result.pipe(
        Effect.tap(() => commitAssistant),
      )

      const cancel = baseStream.cancel.pipe(
        Effect.zipRight(commitAssistant),
      )

      return { chunks, result, cancel } satisfies StreamResponse
    })

    const stream = Effect.fn("Conversation.stream")(function* (content: string) {
      // Commit user message eagerly so interrupts preserve the exchange
      // structure (user asked, assistant reply may be partial).
      yield* Ref.update(state, (s) => ({
        ...s,
        history: [...s.history, { role: "user", content } as const],
      }))
      return yield* streamFromHistory()
    })

    const streamContinue = streamFromHistory()

    const appendAssistant = (text: string) =>
      Ref.update(state, (s) => ({
        ...s,
        history: [...s.history, { role: "assistant", content: text } as const],
      }))

    const clear = Ref.update(state, (s) => ({ ...s, history: [] }))

    const setSystem = (prompt: string | undefined) =>
      Ref.update(state, (s) => ({ ...s, systemPrompt: prompt }))

    const getSystem = Ref.get(state).pipe(Effect.map((s) => s.systemPrompt))

    const setJsonTools = (tools: ReadonlyArray<JsonTool>) =>
      Ref.update(state, (s) => ({ ...s, jsonTools: tools }))

    const clearJsonTools = Ref.update(state, (s) => ({ ...s, jsonTools: [] }))

    const setMaxTokens = (n: number) =>
      Ref.update(state, (s) => ({ ...s, maxTokens: n }))

    const setProviderRouting = (routing: ProviderRouting | undefined) =>
      Ref.update(state, (s) => ({ ...s, providerRouting: routing }))

    const getHistory = Ref.get(state).pipe(Effect.map((s) => s.history))

    const setHistory = (messages: ReadonlyArray<Message>) =>
      Ref.update(state, (s) => ({ ...s, history: messages }))

    const fork = Effect.gen(function* () {
      const st = yield* Ref.get(state)
      return yield* makeConversation({
        model: options.model,
        system: st.systemPrompt,
        maxTokens: st.maxTokens,
      })
    })

    return {
      model: options.model,
      send,
      stream,
      streamContinue,
      clear,
      fork,
      setSystem,
      getSystem,
      setJsonTools,
      clearJsonTools,
      setMaxTokens,
      setProviderRouting,
      getHistory,
      setHistory,
      appendAssistant,
    } satisfies ConversationHandle
  })
