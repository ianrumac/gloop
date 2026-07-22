/**
 * A real "React, for agents" program: a repo assistant with a two-phase
 * lifecycle, reusable fragment components, the tool() monad, persistent state,
 * and an effect — reconciled into a live OpenRouter agent.
 *
 *   OPENROUTER_API_KEY=sk-... bun run examples/react-repo-assistant.ts \
 *     "What does this package do? Then leave a one-line note in README.md."
 *
 * The agent starts in "explore" mode with read-only tools. When it decides it
 * knows enough, it calls EnterEditMode — that flips a useState, and on the next
 * turn the component *returns a different tree*: the write tool appears (gated
 * behind a confirm). No addTool/removeTool anywhere — just an `if` over state.
 */

import { exec } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline/promises"
import { promisify } from "node:util"
import { Effect, Stream } from "effect"
import { OpenRouterProviderLive } from "../src/index.js"
import {
  buildAgent,
  group,
  model,
  system,
  tool,
  useEffect,
  usePersistentState,
  useState,
  useTurn,
} from "../src/react/index.js"

const sh = promisify(exec)

// ---------------------------------------------------------------------------
// Reusable fragment components — each is just a function returning nodes.
// ---------------------------------------------------------------------------

/** Persona: a system section + a sign-off tool, reused by any agent. */
const Persona = (name: string) =>
  group(
    system(`You are ${name}, a terse, careful repo assistant.`),
    tool("Signoff")
      .describe("End the session with a short summary")
      .arg("summary", "one-line summary of what you did")
      .handle((a) => `— ${name}: ${a.summary}`),
  )

/** Read-only exploration tools, available in every phase. */
const ExploreTools = () =>
  group(
    tool("ReadFile")
      .describe("Read a UTF-8 file relative to the repo root")
      .arg("path", "file path")
      .handle((a) => readFile(a.path!, "utf8"))
      .map((body) => (body.length > 4000 ? body.slice(0, 4000) + "\n…(truncated)" : body)),

    tool("Search")
      .describe("Grep the repo for a string")
      .arg("query", "text to search for")
      // A Promise handler is coerced automatically; map trims the output.
      .handle((a) => sh(`grep -rn --exclude-dir=node_modules -F ${JSON.stringify(a.query)} . || true`)
        .then((r) => r.stdout))
      .map((out) => out.split("\n").slice(0, 40).join("\n") || "(no matches)"),
  )

/** Mutation tools — only rendered once we're in edit mode. Write is gated. */
const EditTools = () =>
  tool("WriteFile")
    .describe("Overwrite a file with new contents")
    .arg("path", "file path")
    .arg("contents", "the full new file contents")
    .confirmWhen((a) => `Overwrite ${a.path} (${a.contents?.length ?? 0} bytes)?`)
    .handle((a) => writeFile(a.path!, a.contents ?? "").then(() => `wrote ${a.path}`))

// ---------------------------------------------------------------------------
// The agent component. Hooks = state/effects. Return value = config.
// ---------------------------------------------------------------------------

function RepoAssistant() {
  const [phase, setPhase] = useState<"explore" | "edit">("explore")
  const [sessions, setSessions] = usePersistentState("sessions", 0)
  const turn = useTurn()

  // An effect: bump the persisted session counter + log, once per turn.
  useEffect(() => {
    setSessions((n) => n + 1)
    process.stderr.write(`\n[turn ${turn.turn} · phase=${phase} · session #${sessions}]\n`)
  }, [turn.turn])

  return group(
    model("anthropic/claude-sonnet-4.5"),
    Persona("gloop"),
    ExploreTools(),

    phase === "explore"
      ? group(
          system("You are exploring. Use ReadFile/Search. When you know exactly what to change, call EnterEditMode — do not guess."),
          tool("EnterEditMode")
            .describe("Unlock file-writing tools once you know what to change")
            .handle(() => {
              setPhase("edit") // schedules a rerender — next turn's tree has WriteFile
              return "Edit mode unlocked. WriteFile is now available."
            }),
        )
      : group(
          system("You may now edit files with WriteFile. Make the smallest change that satisfies the request, then call Signoff."),
          EditTools(),
        ),
  )
}

// ---------------------------------------------------------------------------
// Host wiring: confirm prompt, streaming to the terminal, run one turn.
// ---------------------------------------------------------------------------

const askConfirm = (command: string): Effect.Effect<boolean> =>
  Effect.promise(async () => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`\n⚠️  ${command} [y/N] `)
    rl.close()
    return answer.trim().toLowerCase().startsWith("y")
  })

const program = Effect.gen(function* () {
  const app = yield* buildAgent(RepoAssistant, { confirm: askConfirm })

  // Stream assistant text to stdout; announce tool calls on stderr.
  yield* Effect.forkScoped(
    app.agent.events.pipe(
      Stream.runForEach((e) =>
        Effect.sync(() => {
          if (e._tag === "StreamChunk") process.stdout.write(e.text)
          else if (e._tag === "ToolStart") process.stderr.write(`\n  ↳ ${e.name}(${e.preview})\n`)
        }),
      ),
    ),
  )

  const question =
    process.argv[2] ??
    "What does this package do? Read the README, then add a one-line note to it."

  yield* app.send(question)
  process.stdout.write("\n")
})

const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) {
  console.error("Set OPENROUTER_API_KEY to run this example.")
  process.exit(1)
}

Effect.runPromise(
  Effect.scoped(program).pipe(Effect.provide(OpenRouterProviderLive({ apiKey }))),
).catch((err) => {
  console.error("\n" + (err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
