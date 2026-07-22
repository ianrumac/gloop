/**
 * Stacked LLMs: a main responder thread + a "thinker" that observes each
 * message and directs the responder. Runnable with no API key (scripted stub).
 *
 *   bun run examples/react-thinker.ts
 *
 * Per turn the runtime:
 *   1. renders the component; `useThinker` kicks off a nested one-shot LLM
 *      (the inner monologue) that observes the user message,
 *   2. SUSPENDS the turn until the thinker resolves,
 *   3. re-renders — now the thinker's guidance is in hand and gets injected as
 *      a system section for the responder,
 *   4. runs the responder turn, conditioned on that guidance.
 *
 * Two different models, one conversation. The thinker never talks to the user;
 * it only shapes the responder's config.
 */

import { Effect, Layer, Stream } from "effect"
import { AIProvider, type AIProviderImpl } from "../src/index.js"
import {
  buildAgent,
  directive,
  group,
  model,
  system,
  useThinker,
  useTurn,
} from "../src/react/index.js"

// --- The component: thinker output flows into the responder's prompt -------

function ChatAgent() {
  const turn = useTurn()

  // A nested LLM. The parent turn waits for it (Suspense) before responding.
  const guidance = useThinker({
    model: "cheap-thinker",
    system:
      "You are the private inner monologue of an assistant. In ONE line, tell " +
      "the responder what to focus on and what tone to take. Never address the user.",
    input: turn.message || "(session start)",
  })

  if (guidance) process.stderr.write(`\n  💭 thinker: ${guidance}\n  🗣️  responder: `)

  return group(
    model("strong-responder"),
    system("You are a helpful assistant."), // standing identity — unchanged
    // The stack: the thinker's thoughts steer THIS answer only, as an
    // ephemeral directive — not a system section, not persisted.
    guidance && directive(`(inner voice) ${guidance}`),
  )
}

// --- Stub: complete() serves the thinker, stream() serves the responder ----
// (nested one-shot LLMs go through complete; the agent loop streams.)

const stub: AIProviderImpl = {
  name: "stub",
  complete: (req) => {
    const user = req.messages.find((m) => m.role === "user")?.content ?? ""
    const topic = user.toLowerCase().includes("refund")
      ? "billing — be reassuring and mention the timeline"
      : user.toLowerCase().includes("bug")
        ? "reproduction steps first, stay technical"
        : "answer the core question directly"
    return Effect.succeed({
      id: "think",
      model: req.model,
      content: `focus: ${topic}; tone: warm, concise (≤2 sentences)`,
      finishReason: "stop",
    })
  },
  stream: (req) => {
    // The guidance now arrives as an ephemeral directive message, not system.
    const note = req.messages.find((m) => m.content.includes("(inner voice)"))
    const guided = note ? note.content.replace("(inner voice)", "").trim() : "(no guidance)"
    const sys = req.messages.find((m) => m.role === "system")?.content ?? ""
    const user = req.messages.filter((m) => !m.content.includes("(inner voice)"))
      .reverse().find((m) => m.role === "user")?.content ?? ""
    const text = `[system stays: "${sys}"]\n[steered by → ${guided}]\nHere's my reply about "${user}".`
    return {
      chunks: Stream.fromIterable(text.match(/.{1,24}/g) ?? [text]),
      result: Effect.succeed({ id: "resp", model: req.model, content: text, finishReason: "stop" }),
      cancel: Effect.void,
    }
  },
}

// --- Run two turns ---------------------------------------------------------

const program = Effect.gen(function* () {
  const app = yield* buildAgent(ChatAgent)

  yield* app.agent.eventsOf("StreamChunk").pipe(
    Stream.runForEach((e) => Effect.sync(() => process.stdout.write(e.text))),
    Effect.forkScoped,
  )

  for (const msg of ["Can I get a refund? I was double charged.", "Also the export button throws a bug."]) {
    process.stderr.write(`\n\n👤 user: ${msg}`)
    yield* app.send(msg)
  }
  process.stdout.write("\n")
})

Effect.runPromise(
  Effect.scoped(program).pipe(Effect.provide(Layer.succeed(AIProvider, stub))),
).catch((e) => {
  console.error(e)
  process.exit(1)
})
