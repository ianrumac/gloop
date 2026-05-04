/**
 * Debug-mode wiring tests.
 *
 * Verifies that the `--debug` helpers (`debugTracer`, `debugInterceptor`)
 * return undefined when off and produce a real Tracer / Interceptor when on.
 * Also exercises the interceptor against a no-op `next` to confirm the
 * boundary-record format compiles end-to-end.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  enableDebug,
  isDebug,
  debugTracer,
  debugInterceptor,
} from "./debug.ts";
import type { Interceptor } from "@hypen-space/gloop-loop";

const LOG_DIR = join(process.cwd(), ".gloop");
const LOG_FILE = join(LOG_DIR, "debug.log");

describe("debug mode wiring", () => {
  // We can't easily reset the module-level `enabled` flag, so the tests
  // assume order: the off-tests run first, then the on-tests.

  describe("when off", () => {
    test("debugTracer() returns undefined", () => {
      // This test relies on `enableDebug` not having been called yet in
      // this module's lifetime.  Skip if already enabled.
      if (isDebug()) return;
      expect(debugTracer()).toBeUndefined();
    });

    test("debugInterceptor() returns undefined", () => {
      if (isDebug()) return;
      expect(debugInterceptor()).toBeUndefined();
    });
  });

  describe("when on", () => {
    beforeEach(() => {
      // Ensure .gloop dir exists; enableDebug writes to LOG_FILE.
      mkdirSync(LOG_DIR, { recursive: true });
      enableDebug();
    });

    afterEach(() => {
      // Best-effort cleanup; safe to ignore if file is gone.
      try {
        rmSync(LOG_FILE);
      } catch {
        /* ignore */
      }
    });

    test("debugTracer() produces a Tracer that writes spans into the debug log", () => {
      const tracer = debugTracer();
      expect(tracer).toBeDefined();

      const root = tracer!.startSpan("agent.turn", {
        attributes: { messageId: "msg_1" },
      });
      const child = tracer!.startSpan("ai.stream", {
        attributes: { model: "test" },
        parent: root,
      });
      child.setAttribute("ok", true);
      child.setStatus({ code: "ok" });
      child.end();
      root.setStatus({ code: "ok" });
      root.end();

      const log = readFileSync(LOG_FILE, "utf8");
      expect(log).toContain("agent.turn");
      expect(log).toContain("ai.stream");
      expect(log).toContain("messageId=msg_1");
      // Child is indented under parent.
      expect(log).toMatch(/^  ai\.stream/m);
    });

    test("debugInterceptor() records LLM_REQUEST + LLM_RESPONSE on a successful call", async () => {
      const interceptor = debugInterceptor();
      expect(interceptor).toBeDefined();

      const result = await interceptor!.llmCall!(
        {
          input: "ping",
          model: "test-model",
          messages: [],
          tools: [],
        },
        async () => ({ text: "pong", toolCalls: [] }),
      );

      expect(result.text).toBe("pong");
      const log = readFileSync(LOG_FILE, "utf8");
      expect(log).toContain("LLM_REQUEST");
      expect(log).toContain("ping");
      expect(log).toContain("LLM_RESPONSE");
      expect(log).toContain("pong");
      expect(log).toContain("model=test-model");
    });

    test("debugInterceptor() records TOOL_REQUEST + TOOL_RESPONSE", async () => {
      const interceptor = debugInterceptor()!;

      await interceptor.toolCall!(
        { name: "Echo", args: { text: "hi" } },
        async () => ({ success: true, output: "echo: hi" }),
      );

      const log = readFileSync(LOG_FILE, "utf8");
      expect(log).toContain("TOOL_REQUEST");
      expect(log).toContain("Echo");
      expect(log).toContain('"text": "hi"');
      expect(log).toContain("TOOL_RESPONSE");
      expect(log).toContain("ok=true");
      expect(log).toContain("echo: hi");
    });

    test("debugInterceptor() rethrows LLM errors after recording LLM_ERROR", async () => {
      const interceptor = debugInterceptor()!;

      await expect(
        interceptor.llmCall!(
          { input: "x", model: "m", messages: [], tools: [] },
          async () => {
            throw new Error("network down");
          },
        ),
      ).rejects.toThrow("network down");

      const log = readFileSync(LOG_FILE, "utf8");
      expect(log).toContain("LLM_ERROR");
      expect(log).toContain("network down");
    });

    test("interceptor shape conforms to the @hypen-space/gloop-loop Interceptor type", () => {
      const interceptor: Interceptor | undefined = debugInterceptor();
      expect(interceptor?.name).toBe("gloop-debug");
      expect(typeof interceptor?.llmCall).toBe("function");
      expect(typeof interceptor?.toolCall).toBe("function");
      expect(typeof interceptor?.confirm).toBe("function");
      expect(typeof interceptor?.ask).toBe("function");
      expect(typeof interceptor?.memory).toBe("function");
      expect(typeof interceptor?.spawn).toBe("function");
    });
  });
});
