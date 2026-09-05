import { describe, expect, test } from "bun:test";
import { TRIMMED_TOOL_OUTPUT_MARKER, trimOldToolOutputs } from "../src/core/core.js";
import type { Message } from "../src/ai/types.js";

const big = (tag: string) => `${tag} ` + "x".repeat(2_000);

function history(): Message[] {
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "do the thing" },
    { role: "assistant", content: "", toolCalls: [{ id: "c1", type: "function", function: { name: "A", arguments: "{}" } }] },
    { role: "tool", content: big("out1"), toolCallId: "c1" },
    { role: "assistant", content: "", toolCalls: [{ id: "c2", type: "function", function: { name: "B", arguments: "{}" } }] },
    { role: "tool", content: big("out2"), toolCallId: "c2" },
    { role: "assistant", content: "", toolCalls: [{ id: "c3", type: "function", function: { name: "C", arguments: "{}" } }] },
    { role: "tool", content: "short", toolCallId: "c3" },
    { role: "user", content: `<tool_result name="D">${big("legacy")}</tool_result>` },
    { role: "assistant", content: "", toolCalls: [{ id: "c5", type: "function", function: { name: "E", arguments: "{}" } }] },
    { role: "tool", content: big("out5"), toolCallId: "c5" },
  ];
}

describe("trimOldToolOutputs", () => {
  test("keeps the last N tool outputs verbatim and collapses older long ones", () => {
    const h = history();
    const out = trimOldToolOutputs(h, 2, 100);
    // last two tool outputs: legacy user tool_result (#8) and tool #10 — untouched
    expect(out[8]!.content).toBe(h[8]!.content);
    expect(out[10]!.content).toBe(h[10]!.content);
    // older long outputs are trimmed to 100 chars + marker
    expect(out[3]!.content.startsWith("out1 xxxx")).toBe(true);
    expect(out[3]!.content).toContain(TRIMMED_TOOL_OUTPUT_MARKER);
    expect(out[3]!.content.length).toBeLessThan(220);
    expect(out[5]!.content).toContain(TRIMMED_TOOL_OUTPUT_MARKER);
    // short outputs are left alone, as are non-tool messages
    expect(out[7]!.content).toBe("short");
    expect(out[2]).toBe(h[2]!);
    expect(out[0]!.content).toBe("sys");
    // tool metadata survives
    expect(out[3]!.toolCallId).toBe("c1");
    expect(out[3]!.role).toBe("tool");
  });

  test("is idempotent", () => {
    const once = trimOldToolOutputs(history(), 1, 50);
    const twice = trimOldToolOutputs(once, 1, 50);
    expect(twice).toEqual(once);
  });

  test("0 disables trimming and does not mutate the input", () => {
    const h = history();
    const out = trimOldToolOutputs(h, 0, 10);
    expect(out).toEqual(h);
    expect(out).not.toBe(h);
    trimOldToolOutputs(h, 1, 10);
    expect(h[3]!.content.length).toBeGreaterThan(2_000);
  });
});
