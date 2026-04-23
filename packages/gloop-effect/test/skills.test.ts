/**
 * Skill auto-registration tests.
 */

import { describe, expect, it } from "bun:test"
import { Effect } from "effect"
import { Agent, type Skill, type Tool } from "../src/index.js"
import { runTest, StubProviderLayer } from "./helpers.js"

const designSkill: Skill = {
  name: "web-design-guidelines",
  description: "Review UI for design guidelines",
  dir: "/fake/skills/web-design-guidelines",
  body: "You are a design reviewer.\nInputs: $ARGUMENTS",
}

describe("Agent — skills", () => {
  it("auto-registers an InvokeSkill tool when skills are provided", async () => {
    const names = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          skills: [designSkill],
        })
        return yield* agent.registry.names
      }),
      StubProviderLayer([{ chunks: ["ok"] }]),
    )
    expect(names).toContain("InvokeSkill")
  })

  it("does NOT register InvokeSkill when no skills are passed", async () => {
    const names = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({ model: "stub", system: "t" })
        return yield* agent.registry.names
      }),
      StubProviderLayer([{ chunks: ["ok"] }]),
    )
    expect(names).not.toContain("InvokeSkill")
  })

  it("respects a user-provided tool named InvokeSkill (no override)", async () => {
    const userTool: Tool<never, never> = {
      name: "InvokeSkill",
      description: "Custom skill runner",
      arguments: [{ name: "name", description: "skill name" }],
      execute: (args) => Effect.succeed(`custom:${args.name ?? ""}`),
    }

    const { names, description } = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "t",
          skills: [designSkill],
          tools: [userTool],
        })
        const all = yield* agent.registry.all
        const invokeSkill = all.find((t) => t.name === "InvokeSkill")
        return {
          names: yield* agent.registry.names,
          description: invokeSkill?.description ?? "",
        }
      }),
      StubProviderLayer([{ chunks: ["ok"] }]),
    )

    // Only one InvokeSkill present, and it's the user's.
    expect(names.filter((n) => n === "InvokeSkill").length).toBe(1)
    expect(description).toBe("Custom skill runner")
  })

  it("merges skills into the system prompt", async () => {
    const system = await runTest(
      Effect.gen(function* () {
        const agent = yield* Agent.make({
          model: "stub",
          system: "You are a helpful bot.",
          skills: [designSkill],
        })
        return yield* agent.conversation.getSystem
      }),
      StubProviderLayer([{ chunks: ["ok"] }]),
    )
    expect(system).toContain("You are a helpful bot.")
    expect(system).toContain("web-design-guidelines")
  })
})
