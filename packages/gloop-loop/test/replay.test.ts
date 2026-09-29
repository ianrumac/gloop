/**
 * The `/replay` entry must stay pure: everything a viewer needs, nothing
 * that drags in a provider, the filesystem, or the actor.
 */
import { test, expect, describe } from "bun:test";
import * as replay from "../src/replay.js";
import * as full from "../src/index.js";

describe("@hypen-space/gloop-loop/replay", () => {
  test("exports the read-only surface", () => {
    for (const name of ["EventLog", "MemoryEventStore", "projectState", "reduce", "initialState", "messagesToRequeue", "projectGraph", "graphToMermaid", "linkedLogs", "isEphemeralEvent", "serializeEvent", "toErrorInfo"]) {
      expect(typeof (replay as Record<string, unknown>)[name]).toMatch(/function/);
      expect((replay as Record<string, unknown>)[name]).toBe((full as Record<string, unknown>)[name]);
    }
  });

  test("does not export anything that needs a runtime", () => {
    for (const name of ["AgentLoop", "OpenRouterProvider", "createJsonlEventStore", "createFileMemory", "primitiveTools", "createNodeIO"]) {
      expect((replay as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  test("bundles for the browser with no node: imports", async () => {
    const out = await Bun.build({
      entrypoints: [new URL("../src/replay.ts", import.meta.url).pathname],
      target: "browser",
      format: "esm",
    });
    expect(out.success).toBe(true);
    const js = await out.outputs[0]!.text();
    expect(js).not.toMatch(/node:(fs|path|child_process)/);
    expect(js).not.toContain("@openrouter");
  });
});
