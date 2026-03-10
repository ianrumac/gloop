/**
 * Integration test — runs a real agent loop against a live LLM via OpenRouter.
 *
 * The agent is pointed at the pizza-delivery project (tests/src/pizza-delivery.ts)
 * which has 2 bugs that cause 5 test failures. The agent must read the code,
 * diagnose the bugs, fix them, and verify with `bun test`.
 *
 * After the test, the original file is restored from memory (no git).
 *
 * Requires OPENROUTER_API_KEY in environment. Skipped otherwise.
 * Run with: bun test test/integration.test.ts
 */

import { test, expect, describe } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentLoop } from "../src/agent.js";
import { OpenRouterProvider } from "../src/ai/provider.js";
import { createNodeIO } from "../src/defaults/io.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.GLOOP_TEST_MODEL ?? "moonshotai/kimi-k2.5";
const TIMEOUT = 180_000; // 3 minutes — real LLM + tool calls

// Paths relative to repo root
const PIZZA_DIR = resolve(import.meta.dir, "../../../tests");
const SOURCE_FILE = resolve(PIZZA_DIR, "src/pizza-delivery.ts");
const TEST_FILE = resolve(PIZZA_DIR, "src/pizza-delivery.test.ts");

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("integration — pizza delivery", () => {
  if (!API_KEY) {
    test.skip("skipped — OPENROUTER_API_KEY not set", () => {});
    return;
  }

  test(
    "agent fixes pizza-delivery.ts bugs and tests pass",
    async () => {
      const io = createNodeIO();

      // 1. Remember the original file content before the agent touches it
      const originalSource = await readFile(SOURCE_FILE, "utf-8");

      // 2. Verify tests currently fail (sanity check)
      const beforeResult = await io.exec(
        `cd ${PIZZA_DIR} && bun test src/pizza-delivery.test.ts 2>&1`,
        30_000,
      );
      expect(beforeResult.exitCode).not.toBe(0);

      // 3. Set up the agent
      const provider = new OpenRouterProvider({ apiKey: API_KEY! });

      const agent = new AgentLoop({
        provider,
        model: MODEL,
        system:
          "You are a precise bug-fixing assistant. " +
          "Read the failing tests, trace failures to root causes in the source, fix only what's broken, " +
          "and verify your fix by running the tests. Be surgical — minimal changes only. " +
          "Do NOT modify test files. " +
          "When done, ALWAYS call the CompleteTask tool with a summary.",
        io,
        onStream: (text) => process.stderr.write(text),
        onToolStatus: (name, status) => process.stderr.write(`  [${name}] ${status}\n`),
        onComplete: () => {},
        confirm: async () => true,
      });

      try {
        // 4. Run the agent
        await agent.run(
          `The project at ${PIZZA_DIR} has failing tests. Run \`cd ${PIZZA_DIR} && bun test src/pizza-delivery.test.ts\` ` +
          `to see the failures, then read ${SOURCE_FILE} to find and fix the bugs. ` +
          `The test file is at ${TEST_FILE} — do NOT modify it. ` +
          `After fixing, run the tests again to verify, then call CompleteTask.`,
        );

        // 5. Run tests independently to confirm the fix
        const afterResult = await io.exec(
          `cd ${PIZZA_DIR} && bun test src/pizza-delivery.test.ts 2>&1`,
          30_000,
        );

        expect(afterResult.exitCode).toBe(0);
        expect(afterResult.stdout + afterResult.stderr).toMatch(/\bpass\b/i);
      } finally {
        // 7. Restore original (broken) file — no git, just rewrite from memory
        await writeFile(SOURCE_FILE, originalSource, "utf-8");
      }
    },
    TIMEOUT,
  );
});
