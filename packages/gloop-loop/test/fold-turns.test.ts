/**
 * foldTurns — model-free compaction that folds older turns into their user
 * message plus one assistant message of evidence and final reply.
 */

import { test, expect, describe } from "bun:test";
import { contextGraph, trimContext, type ContextGraph, type ContextNode } from "../src/context.js";
import { foldTurns, scoreEvidenceLine, turnsOf, estimateTokens, FOLD_MARKER } from "../src/defaults/fold-turns.js";
import type { Message } from "../src/ai/types.js";
import { ScriptedProvider, tc } from "./mock-provider.js";

const ctx = { agent: "agent", instructions: "", trigger: "auto", events: [], provider: new ScriptedProvider([]), model: "m" } as const;

/** Build a graph from turns; each turn's messages are tagged with its id. */
function build(turns: Array<[string | null, Message[]]>): ContextGraph {
  const nodes: ContextNode[] = [];
  let i = 0;
  for (const [turn, messages] of turns) {
    for (const message of messages) nodes.push({ id: `n${i++}`, message, turn });
  }
  return contextGraph("agent", nodes);
}

/** A typical tool-using turn. */
function toolTurn(n: number, output = `output of step ${n}`): Message[] {
  return [
    { role: "user", content: `task ${n}` },
    { role: "assistant", content: "", toolCalls: [tc(`c${n}a`, "Bash", { command: `make step${n}` })] },
    { role: "tool", toolCallId: `c${n}a`, content: output },
    { role: "assistant", content: "", toolCalls: [tc(`c${n}b`, "ReadFile", { path: `src/f${n}.ts` })] },
    { role: "tool", toolCallId: `c${n}b`, content: `secret file body ${n}\nconst zz${n} = 1;` },
    { role: "assistant", content: `done with task ${n}` },
  ];
}

function sixTurns(): ContextGraph {
  return build([1, 2, 3, 4, 5, 6].map((n) => [`t${n}`, toolTurn(n)]));
}

const run = (g: ContextGraph, opts = {}) => foldTurns({ budget: 0, ...opts })(g, ctx) as ContextGraph;

function messagesOf(g: ContextGraph, turn: string): Message[] {
  return g.nodes.filter((n) => n.turn === turn).map((n) => n.message);
}

describe("foldTurns", () => {
  test("under budget → the same graph back, and trimContext reports no change", async () => {
    const g = sixTurns();
    expect(foldTurns()(g, ctx)).toBe(g);
    const trim = await trimContext(foldTurns(), g, ctx);
    expect(trim.changed).toBe(false);
  });

  test("folds all but the last `keep` turns, in one step", () => {
    const g = sixTurns();
    const out = run(g, { keep: 2 });
    for (const t of ["t1", "t2", "t3", "t4"]) {
      const ms = messagesOf(out, t);
      expect(ms).toHaveLength(2);
      expect(ms[0]).toEqual({ role: "user", content: `task ${t.slice(1)}` });
      expect(ms[1]!.role).toBe("assistant");
      expect(ms[1]!.content.startsWith(FOLD_MARKER)).toBe(true);
      expect(ms[1]!.content.endsWith(`done with task ${t.slice(1)}`)).toBe(true);
    }
    for (const t of ["t5", "t6"]) expect(messagesOf(out, t)).toEqual(messagesOf(g, t));
  });

  test("exact folded format", () => {
    const out = run(sixTurns(), { keep: 5 });
    expect(messagesOf(out, "t1")[1]!.content).toBe(
      "[folded turn — 2 tool calls, 5 messages omitted]\n<evidence>\n$ Bash: make step1\noutput of step 1\n</evidence>\n\ndone with task 1",
    );
  });

  test("the first node is never changed", () => {
    const g = sixTurns();
    const out = run(g);
    expect(out.nodes[0]).toBe(g.nodes[0]);
  });

  test("the in-progress last turn is never folded, even with keep 0", () => {
    const g = build([
      ["t1", toolTurn(1)],
      ["t2", toolTurn(2).slice(0, 3)], // still running: ends on a tool result
    ]);
    const out = run(g, { keep: 0 });
    expect(messagesOf(out, "t1")).toHaveLength(2);
    expect(messagesOf(out, "t2")).toEqual(messagesOf(g, "t2"));
  });

  test("turn: null nodes are left untouched", () => {
    const note: Message = { role: "user", content: "[earlier summary]" };
    const g = build([[null, [note]], ["t1", toolTurn(1)], ["t2", toolTurn(2)]]);
    const out = run(g, { keep: 1 });
    expect(out.nodes[0]!.message).toBe(note);
    expect(messagesOf(out, "t1")).toHaveLength(2);
  });

  test("no tool messages or toolCalls remain in folded turns; unfolded turns keep theirs intact", async () => {
    const g = sixTurns();
    const trim = await trimContext(foldTurns({ budget: 0, keep: 3 }), g, ctx);
    const folded = trim.graph.nodes.filter((n) => ["t1", "t2", "t3"].includes(n.turn!));
    expect(folded.some((n) => n.message.role === "tool" || n.message.toolCalls)).toBe(false);
    for (const t of ["t4", "t5", "t6"]) expect(messagesOf(trim.graph, t)).toEqual(messagesOf(g, t));
    // Nothing extra was dropped by closeToolGroups: 3 folded × 2 + 3 whole × 6.
    expect(trim.history).toHaveLength(3 * 2 + 3 * 6);
    expect(trim.changed).toBe(true);
    expect(trim.removed).toBe(3 * 5);
    expect(trim.added).toBe(3);
    // Roles alternate across the folded region.
    expect(trim.history.slice(0, 6).map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);
  });

  test("rerunnable tools are skipped in evidence", () => {
    const out = run(sixTurns());
    const text = messagesOf(out, "t1")[1]!.content;
    expect(text).not.toContain("ReadFile");
    expect(text).not.toContain("secret file body");

    const custom = run(sixTurns(), { rerunnable: [] });
    expect(messagesOf(custom, "t1")[1]!.content).toContain("$ ReadFile: src/f1.ts");
  });

  test("idempotent", () => {
    const opts = { keep: 2 };
    const once = run(sixTurns(), opts);
    const twice = run(once, opts);
    expect(twice).toBe(once);
    expect(twice.nodes.map((n) => n.message)).toEqual(once.nodes.map((n) => n.message));
  });

  test("deterministic", () => {
    const a = run(sixTurns());
    const b = run(sixTurns());
    expect(JSON.stringify(a.nodes)).toBe(JSON.stringify(b.nodes));
  });

  test("evidence keeps errors and hashes, drops boilerplate, under a tight evidenceChars", () => {
    const noise = [
      "bun install v1.1.0",
      "Resolving dependencies",
      "████████████████ 100%",
      "⠋ building",
      "────────────────",
      "",
      ...Array.from({ length: 40 }, (_, i) => `just some chatter line number ${i}`),
      "error: expected 3 but got 4 (src/x.test.ts:41)",
      "HEAD is now at 9f2c4e1a7b",
      "12 pass, 1 fail",
    ].join("\n");
    const g = build([["t1", toolTurn(1, noise)], ["t2", toolTurn(2)]]);
    const out = run(g, { keep: 1, evidenceChars: 120 });
    const text = messagesOf(out, "t1")[1]!.content;
    expect(text).toContain("$ Bash: make step1");
    expect(text).toContain("error: expected 3 but got 4 (src/x.test.ts:41)");
    expect(text).toContain("9f2c4e1a7b");
    expect(text).toContain("12 pass, 1 fail");
    expect(text).not.toContain("Resolving");
    expect(text).not.toContain("chatter");
    expect(text).not.toContain("█");
    const evidence = text.split("<evidence>\n")[1]!.split("\n</evidence>")[0]!;
    expect(evidence.length).toBeLessThanOrEqual(120);
    // Original order is preserved.
    expect(evidence.indexOf("error:")).toBeLessThan(evidence.indexOf("HEAD"));
  });

  test("a planted commit SHA survives a noisy 500-line output", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `processing record ${i} of 500 ... ok so far`);
    lines[317] = "[main 4be2d9c7f1a3] fix the frobnicator";
    const g = build([["t1", toolTurn(1, lines.join("\n"))], ["t2", toolTurn(2)]]);
    const out = run(g, { keep: 1 });
    const text = messagesOf(out, "t1")[1]!.content;
    expect(text).toContain("4be2d9c7f1a3");
    expect(text.length).toBeLessThan(4_000 + 500);
  });

  test("failed tool results rank high; duplicate lines are deduped", () => {
    const turn: Message[] = [
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [tc("a", "Bash", { command: "ls" }), tc("b", "Bash", { command: "cat x" })] },
      { role: "tool", toolCallId: "a", content: "same line here\nsame line here\nsame line here" },
      { role: "tool", toolCallId: "b", content: "Error: cat: x: No such file or directory" },
      { role: "assistant", content: "x is missing" },
    ];
    const out = run(build([["t1", turn], ["t2", toolTurn(2)]]), { keep: 1 });
    const text = messagesOf(out, "t1")[1]!.content;
    expect(text).toContain("$ Bash: cat x\nError: cat: x: No such file or directory");
    expect(text.split("same line here").length - 1).toBe(1);

    const tight = run(build([["t1", turn], ["t2", toolTurn(2)]]), { keep: 1, evidenceChars: 60 });
    expect(messagesOf(tight, "t1")[1]!.content).toContain("No such file");
    expect(messagesOf(tight, "t1")[1]!.content).not.toContain("same line");
  });

  test("CompleteTask summary is the final reply when there is no trailing text", () => {
    const turn: Message[] = [
      { role: "user", content: "fix it" },
      { role: "assistant", content: "", toolCalls: [tc("a", "Bash", { command: "bun test" })] },
      { role: "tool", toolCallId: "a", content: "3 pass" },
      { role: "assistant", content: "", toolCalls: [tc("b", "CompleteTask", { summary: "Fixed the parser; all tests pass." })] },
      { role: "tool", toolCallId: "b", content: "Fixed the parser; all tests pass." },
    ];
    const out = run(build([["t1", turn], ["t2", toolTurn(2)]]), { keep: 1 });
    const text = messagesOf(out, "t1")[1]!.content;
    expect(text.endsWith("\n\nFixed the parser; all tests pass.")).toBe(true);
    expect(text).not.toContain("CompleteTask");
  });

  test("an interrupted turn keeps its last text and lists the commands it ran", () => {
    const turn: Message[] = [
      { role: "user", content: "deploy" },
      { role: "assistant", content: "Building first.", toolCalls: [tc("a", "Bash", { command: "make build" })] },
      { role: "tool", toolCallId: "a", content: "built" },
      { role: "assistant", content: "", toolCalls: [tc("b", "Bash", { command: "make deploy" })] },
    ];
    const out = run(build([["t1", turn], ["t2", toolTurn(2)]]), { keep: 1 });
    const text = messagesOf(out, "t1")[1]!.content;
    expect(text).toContain("$ Bash: make build");
    expect(text).toContain("$ Bash: make deploy\n(no result)");
    expect(text.endsWith("(turn ended without a final reply)\n\nBuilding first.")).toBe(true);
  });

  test("AskUser is kept as one evidence line", () => {
    const turn: Message[] = [
      { role: "user", content: "pick a db" },
      { role: "assistant", content: "", toolCalls: [tc("a", "AskUser", { question: "Postgres or SQLite?" })] },
      { role: "tool", toolCallId: "a", content: "User answered: SQLite" },
      { role: "assistant", content: "", toolCalls: [tc("b", "Remember", { content: "uses sqlite" })] },
      { role: "tool", toolCallId: "b", content: "Remembered: uses sqlite" },
      { role: "assistant", content: "Going with SQLite." },
    ];
    const out = run(build([["t1", turn], ["t2", toolTurn(2)]]), { keep: 1 });
    const text = messagesOf(out, "t1")[1]!.content;
    expect(text).toContain("$ AskUser: Postgres or SQLite? → SQLite");
    expect(text).not.toContain("Remember");
  });

  test("a turn without tools is left as it is", () => {
    const plain: Message[] = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const g = build([["t1", plain], ["t2", toolTurn(2)], ["t3", toolTurn(3)]]);
    const out = run(g, { keep: 1 });
    expect(messagesOf(out, "t1")).toEqual(plain);
    expect(out.nodes.slice(0, 2)).toEqual(g.nodes.slice(0, 2));
    expect(messagesOf(out, "t2")).toHaveLength(2);
  });

  test("budget counts only foldable turns and folds them all once exceeded", () => {
    const g = sixTurns();
    const foldable = turnsOf(g).slice(0, 3);
    let tokens = 0;
    for (const t of foldable) for (const n of t.nodes) {
      tokens += estimateTokens(n.message.content);
      if (n.message.toolCalls) tokens += estimateTokens(JSON.stringify(n.message.toolCalls));
    }
    expect(foldTurns({ budget: tokens })(g, ctx)).toBe(g);
    const out = foldTurns({ budget: tokens - 1 })(g, ctx) as ContextGraph;
    expect(out.nodes).toHaveLength(3 * 2 + 3 * 6);
  });
});

describe("foldTurns — targetTokens (compactAtTokens range)", () => {
  const big = (n: number) => Array.from({ length: 200 }, (_, i) => `line ${i} of step ${n} with some filler text`).join("\n");
  const bigTurns = () => build([1, 2, 3, 4, 5, 6].map((n) => [`t${n}`, toolTurn(n, big(n))]));
  const est = (g: ContextGraph) =>
    g.nodes.reduce(
      (sum, n) => sum + estimateTokens(n.message.content) + (n.message.toolCalls?.length ? estimateTokens(JSON.stringify(n.message.toolCalls)) : 0),
      0,
    );
  const opts = { evidenceChars: 200 };
  const withKeep = (g: ContextGraph, keep: number) => foldTurns({ ...opts, budget: 0, keep })(g, ctx) as ContextGraph;
  const targeted = (g: ContextGraph, targetTokens: number, extra: Record<string, unknown> = {}, tokens?: number) =>
    foldTurns({ ...opts, ...extra })(g, { ...ctx, targetTokens, ...(tokens !== undefined && { tokens }) }) as ContextGraph;

  test("the budget gate does not stop a targeted run", () => {
    const g = bigTurns();
    const out = targeted(g, est(g), { budget: 1e9 });
    expect(out.nodes.map((n) => n.message)).toEqual(withKeep(g, 3).nodes.map((n) => n.message));
  });

  test("folds with `keep` when that reaches the target", () => {
    const g = bigTurns();
    const k3 = withKeep(g, 3);
    const out = targeted(g, est(k3));
    expect(out.nodes.map((n) => n.message)).toEqual(k3.nodes.map((n) => n.message));
  });

  test("reduces keep until the estimate is at or under the target", () => {
    const g = bigTurns();
    const k3 = withKeep(g, 3);
    const k2 = withKeep(g, 2);
    expect(est(k2)).toBeLessThan(est(k3));
    const out = targeted(g, est(k3) - 1);
    expect(out.nodes.map((n) => n.message)).toEqual(k2.nodes.map((n) => n.message));
    expect(est(out)).toBeLessThanOrEqual(est(k3) - 1);
    expect(messagesOf(out, "t5")).toEqual(messagesOf(g, "t5"));
  });

  test("an unreachable target folds everything but the last turn — never the last turn or the first node", () => {
    const g = bigTurns();
    const out = targeted(g, 1);
    expect(out.nodes.map((n) => n.message)).toEqual(withKeep(g, 1).nodes.map((n) => n.message));
    expect(messagesOf(out, "t6")).toEqual(messagesOf(g, "t6"));
    expect(out.nodes[0]).toBe(g.nodes[0]);
    for (const t of ["t1", "t2", "t3", "t4", "t5"]) expect(messagesOf(out, t)).toHaveLength(2);
  });

  test("calibrates the estimate against ctx.tokens", () => {
    const g = bigTurns();
    const k3 = withKeep(g, 3);
    // Uncalibrated, keep 3 fits; with the real figure twice the estimate it does not.
    expect(targeted(g, est(k3)).nodes.length).toBe(k3.nodes.length);
    const out = targeted(g, est(k3), {}, est(g) * 2);
    expect(out.nodes.length).toBeLessThan(k3.nodes.length);
    expect(est(out) * 2).toBeLessThanOrEqual(est(k3));
  });

  test("deterministic and idempotent", async () => {
    const g = bigTurns();
    const target = est(withKeep(g, 3)) - 1;
    const a = targeted(g, target);
    const b = targeted(g, target);
    expect(a.nodes.map((n) => n.message)).toEqual(b.nodes.map((n) => n.message));
    const again = await trimContext(foldTurns(opts), a, { ...ctx, targetTokens: target });
    expect(again.changed).toBe(false);
    const unreachable = targeted(g, 1);
    expect((await trimContext(foldTurns(opts), unreachable, { ...ctx, targetTokens: 1 })).changed).toBe(false);
  });

  test("folds from an earlier run that the log attributes to a later turn still count as folded, and that turn can fold", () => {
    // What projectContext gives after a history_replaced in turn t3: the
    // folds of t1 and t2 carry t3's turn id.
    const first = withKeep(build([1, 2, 3].map((n) => [`t${n}`, toolTurn(n, big(n))])), 1);
    const relabeled = first.nodes.map((n) => (n.message.content.startsWith(FOLD_MARKER) ? { ...n, turn: "t3" } : n));
    const g = contextGraph("agent", [
      ...relabeled,
      ...build([4, 5].map((n) => [`t${n}`, toolTurn(n, big(n))])).nodes.map((n) => ({ ...n, id: `x${n.id}` })),
    ]);
    const out = targeted(g, 1);
    // Every turn but the last is [user, fold]; the last is whole.
    const msgs = out.nodes.map((n) => n.message);
    expect(msgs.slice(0, 8).map((m) => m.role)).toEqual(Array(4).fill(["user", "assistant"]).flat());
    for (const [i, n] of [1, 2, 3, 4].entries()) {
      expect(msgs[i * 2]!.content).toBe(`task ${n}`);
      expect(msgs[i * 2 + 1]!.content.startsWith(FOLD_MARKER)).toBe(true);
      expect(msgs[i * 2 + 1]!.content.endsWith(`done with task ${n}`)).toBe(true);
    }
    expect(msgs.slice(8)).toEqual(toolTurn(5, big(5)));
  });

  test("without a target the budget gate still applies", () => {
    const g = bigTurns();
    expect(foldTurns({ ...opts, budget: 1e9 })(g, { ...ctx, tokens: 1e9 })).toBe(g);
  });
});

describe("scoreEvidenceLine", () => {
  test("ranks errors and identifiers over summaries over plain lines; drops noise", () => {
    const s = scoreEvidenceLine;
    expect(s("")).toBe(0);
    expect(s("   ")).toBe(0);
    expect(s("──────────")).toBe(0);
    expect(s("=====")).toBe(0);
    expect(s("[#####     ] 45%")).toBe(0);
    expect(s("⠙ Installing")).toBe(0);
    expect(s("Resolving dependencies")).toBe(0);
    expect(s("found 0 vulnerabilities")).toBe(0);

    const plain = s("some ordinary text");
    expect(plain).toBe(1);
    const kv = s("status: ready");
    const summary = s("3 files changed, 10 insertions(+)");
    const ident = s("commit 1a2b3c4d5e6f");
    const error = s("Traceback (most recent call last):");
    expect(kv).toBeGreaterThan(plain);
    expect(summary).toBeGreaterThan(kv);
    expect(ident).toBeGreaterThan(summary);
    expect(error).toBeGreaterThan(ident);

    expect(s("process exited with code 2")).toBeGreaterThanOrEqual(10);
    expect(s("12 pass 0 fail")).toBeLessThan(10);
    expect(s("see https://example.com/x")).toBeGreaterThanOrEqual(8);
    expect(s("at foo (src/a.ts:12:3)")).toBeGreaterThanOrEqual(8);
    expect(s("550e8400-e29b-41d4-a716-446655440000")).toBeGreaterThanOrEqual(8);
    expect(s("upgraded to v2.3.1")).toBeGreaterThanOrEqual(8);
    expect(s("npm ERR! code E404")).toBeGreaterThanOrEqual(10);
    expect(s("+++ b/src/x.ts")).toBeGreaterThanOrEqual(6);
    expect(s("took 1.2s")).toBeGreaterThanOrEqual(4);
  });

  test("a custom scorer can drop lines", () => {
    const out = run(build([["t1", toolTurn(1, "keep me\ndrop me")], ["t2", toolTurn(2)]]), {
      keep: 1,
      scoreLine: (l: string) => (l.startsWith("drop") ? 0 : 1),
    });
    const text = messagesOf(out, "t1")[1]!.content;
    expect(text).toContain("keep me");
    expect(text).not.toContain("drop me");
  });
});
