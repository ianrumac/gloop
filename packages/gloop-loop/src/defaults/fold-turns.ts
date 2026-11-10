/**
 * gloop-loop/defaults/fold-turns — model-free context compaction by turn
 * folding.
 *
 * The unit is the **turn**: one user message plus everything the agent did
 * until the next one.  Once the older turns grow past a token budget, every
 * one of them is folded in a single step into two messages:
 *
 *   user       the original message, unchanged
 *   assistant  [folded turn — N tool calls, M messages omitted]
 *              <evidence>
 *              $ Bash: bun test
 *              error: expected 3 but got 4 (src/x.test.ts:41)
 *              </evidence>
 *
 *              <the turn's final reply>
 *
 * The evidence block keeps the lines of tool output that are expensive to
 * rediscover (errors, hashes, paths with line numbers, test summaries…),
 * picked by a cheap line scorer.  No model is called; the output is
 * deterministic, and folded turns are never folded again, so the prompt
 * prefix stays byte-stable between folds (good for prompt caching).
 *
 * Approach inspired by the eunoe project (MIT).
 */

import type { JsonToolCall, Message } from "../ai/types.js";
import { contextGraph, type ContextGraph, type ContextNode, type ContextStrategy } from "../context.js";

// ============================================================================
// Options
// ============================================================================

export interface FoldTurnsOptions {
  /** Most recent turns kept whole. Default 3.  With `ctx.targetTokens`, fewer (down to 1) when needed to reach the target. */
  keep?: number;
  /**
   * Fold only once the foldable (older, still-unfolded) turns exceed this
   * many estimated tokens; then fold ALL of them in one step.  Batch folding
   * keeps the prompt-cache prefix stable between folds.  Default 20_000.
   * 0 = always fold.  Not applied when `ctx.targetTokens` is set (the
   * caller has already decided compaction is due).
   */
  budget?: number;
  /** Max characters of evidence kept per folded turn. Default 4_000. */
  evidenceChars?: number;
  /** Tools whose output can simply be re-run and is therefore skipped entirely when extracting evidence. Default ["ReadFile"]. */
  rerunnable?: string[];
  /** Token estimator. Default: chars / 4. */
  estimateTokens?: (text: string) => number;
  /** Custom line scorer; return 0 to drop a line. Default: scoreEvidenceLine. */
  scoreLine?: (line: string) => number;
}

export const FOLD_DEFAULTS = {
  keep: 3,
  budget: 20_000,
  evidenceChars: 4_000,
  rerunnable: ["ReadFile"] as readonly string[],
} as const;

/** First characters of every folded-turn message — how a fold is recognised. */
export const FOLD_MARKER = "[folded turn";

/** Tools that carry no evidence worth keeping (AskUser is handled specially). */
const INTERNAL_TOOLS = new Set(["AskUser", "Remember", "Forget", "ManageContext", "CompleteTask"]);

const MAX_LINE_CHARS = 300;
const MAX_PREVIEW_CHARS = 120;

// ============================================================================
// Helpers
// ============================================================================

/** Default token estimate: one token per four characters. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface Turn {
  /** The turn id (`node.turn`). */
  id: string;
  /** The turn's nodes, in graph order. */
  nodes: ContextNode[];
  /** Index of each node in `graph.nodes`. */
  indices: number[];
}

/** Group the nodes with a known turn into turns, in order of first appearance.  `turn: null` nodes belong to none. */
export function turnsOf(graph: ContextGraph): Turn[] {
  const byId = new Map<string, Turn>();
  const turns: Turn[] = [];
  graph.nodes.forEach((node, i) => {
    if (node.turn === null) return;
    let turn = byId.get(node.turn);
    if (!turn) {
      turn = { id: node.turn, nodes: [], indices: [] };
      byId.set(node.turn, turn);
      turns.push(turn);
    }
    turn.nodes.push(node);
    turn.indices.push(i);
  });
  return turns;
}

/** True when the turn is already the output of a fold. */
export function isFoldedTurn(turn: Turn): boolean {
  return turn.nodes.some((n) => n.message.role === "assistant" && n.message.content.startsWith(FOLD_MARKER));
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

function parseArgs(call: JsonToolCall): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const PREVIEW_KEYS = ["command", "cmd", "path", "file_path", "file", "pattern", "query", "url", "question", "text"];

/** A compact one-line preview of a tool call's main argument. */
function argPreview(call: JsonToolCall): string {
  const args = parseArgs(call);
  let value: unknown;
  for (const key of PREVIEW_KEYS) {
    if (typeof args[key] === "string" && args[key]) { value = args[key]; break; }
  }
  if (value === undefined) value = Object.values(args).find((v) => typeof v === "string" && v);
  if (value === undefined) value = Object.keys(args).length ? JSON.stringify(args) : "";
  return truncate(String(value).replace(/\s+/g, " ").trim(), MAX_PREVIEW_CHARS);
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Split tool output into clean lines: ANSI stripped, carriage-return overwrites resolved, trimmed. */
function outputLines(content: string): string[] {
  return content.split("\n").map((raw) => {
    const segments = raw.replace(ANSI, "").split("\r");
    // A progress-style line redraws itself — the last non-empty segment is what was shown.
    const shown = [...segments].reverse().find((s) => s.trim()) ?? "";
    return shown.trim();
  });
}

// ============================================================================
// Line scoring
// ============================================================================

const PURE_PUNCT = /^[\p{P}\p{S}\s]+$/u;
const SPINNER = /[⠀-⣿]/;
const BAR = /[█▉▊▋▌▍▎▏▓▒░■□#=>]{4,}|\[[=#>\-. ]{4,}\]/;
const PERCENT_OR_COUNT = /\d{1,3}(\.\d+)?\s?%|\b\d+\/\d+\b/;
const BOILERPLATE =
  /^(npm (warn|notice|http)|bun (install|test|run) v\d|resolving|resolved|downloading|downloaded|fetching|installing|compiling|collecting|requirement already satisfied|using cached|added \d+ packages?|removed \d+ packages?|up to date|audited \d+|found 0 vulnerabilities|\d+ packages? are looking for funding|run `npm fund`|saved lockfile|checked \d+ installs?|\(pass\)|✓|✔|ok\b|pass\b)/i;

const ZERO_COUNTS = /\b0 (errors?|fail(s|ed|ures?)?|failing|warnings?)\b/gi;
const ERROR_WORDS =
  /\bERR!|\b(error|errors|fail|fails|failed|failure|failures|failing|exception|panic|panicked|traceback|denied|refused|fatal|segfault|segmentation fault|aborted|not found|no such file|cannot|can't|unable to|timed out|timeout|conflict|invalid|unexpected|assertion|enoent|eacces|econnrefused)\b/i;
const NONZERO_EXIT = /\bexit(ed)?( with)? (code|status)[: ]*([1-9]\d*|-\d+)\b/i;

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const URL = /\bhttps?:\/\/\S+/i;
const PATH_LINE = /[\w./\\-]+\.[A-Za-z]\w*:\d+/;
const VERSION = /\bv?\d+\.\d+\.\d+\b|\bv\d+\.\d+\b/;
const HEX = /\b[0-9a-f]{7,64}\b/gi;

const TEST_DIFF_SUMMARY =
  /\b\d+ (pass|passed|passing|fail|failed|failing|tests?|skipped|todo|expect\(\) calls|files? changed|insertions?|deletions?|errors?|warnings?)\b|^(\+\+\+|---) \S|^diff --git |^@@ .* @@/i;
const DURATION = /\b\d+(\.\d+)?\s?(ms|s|secs?|seconds?|mins?|minutes?)\b|\[\d+(\.\d+)?ms\]/i;
const KEY_VALUE = /^[\w.\- ]{1,40}?\s*(:|=)\s*\S/;

function hasHash(line: string): boolean {
  for (const m of line.match(HEX) ?? []) {
    // A hash mixes digits and letters; plain words ("deadbeef") or numbers are not one.
    if (/\d/.test(m) && /[a-f]/i.test(m)) return true;
  }
  return false;
}

/**
 * How much a line of tool output is worth keeping.  0 = drop.
 *
 * - 10: errors / failures (error, fail, exception, panic, traceback, denied,
 *       not found, non-zero exit code, …)
 * -  8: identifiers costly to rediscover — commit SHAs / hex hashes, UUIDs,
 *       URLs, `file:line` paths, version numbers
 * -  6: test and diff summaries ("12 pass", "3 files changed", `+++` / `---`)
 * -  4: durations, `key: value` / `key=value` lines
 * -  1: any other line
 * -  0: blank lines, pure punctuation / box drawing, progress bars and
 *       spinners, obvious installer / runner boilerplate
 *
 * A line matching several categories gets the best one plus one per extra.
 */
export function scoreEvidenceLine(line: string): number {
  const text = line.trim();
  if (!text) return 0;
  if (PURE_PUNCT.test(text)) return 0;
  if (SPINNER.test(text)) return 0;
  if (BAR.test(text) && PERCENT_OR_COUNT.test(text)) return 0;
  if (/^\d{1,3}(\.\d+)?\s?%$/.test(text)) return 0;

  const errorish = ERROR_WORDS.test(text.replace(ZERO_COUNTS, "")) || NONZERO_EXIT.test(text);
  if (!errorish && BOILERPLATE.test(text)) return 0;

  const scores: number[] = [];
  if (errorish) scores.push(10);
  if (UUID.test(text) || URL.test(text) || PATH_LINE.test(text) || VERSION.test(text) || hasHash(text)) scores.push(8);
  if (TEST_DIFF_SUMMARY.test(text)) scores.push(6);
  if (DURATION.test(text) || KEY_VALUE.test(text)) scores.push(4);
  if (scores.length === 0) return 1;
  return Math.max(...scores) + scores.length - 1;
}

// ============================================================================
// Evidence
// ============================================================================

interface Candidate {
  text: string;
  score: number;
  /** Index of this line's header candidate (for output lines), or -1. */
  header: number;
}

const HEADER_SCORE = 7;
const FAILED_HEADER_SCORE = 12;
/** Headers of an interrupted turn: the commands it ran are the best record of where it got to. */
const INTERRUPTED_HEADER_SCORE = 20;
const USER_LINE_SCORE = 15;
const FAILED_OUTPUT_BONUS = 3;

/** Pick the best evidence lines under `budget` characters; returns them in original order. */
function selectEvidence(candidates: Candidate[], budget: number): string[] {
  const order = candidates
    .map((c, i) => i)
    .filter((i) => candidates[i]!.score > 0)
    .sort((a, b) => candidates[b]!.score - candidates[a]!.score || a - b);
  const chosen = new Set<number>();
  const seen = new Set<string>();
  let used = 0;
  for (const i of order) {
    if (chosen.has(i)) continue;
    const c = candidates[i]!;
    // Dedupe identical output lines (headers are never deduped against output).
    if (c.header >= 0 && seen.has(c.text)) continue;
    let cost = c.text.length + 1;
    const needsHeader = c.header >= 0 && !chosen.has(c.header);
    if (needsHeader) cost += candidates[c.header]!.text.length + 1;
    if (used + cost > budget) continue;
    used += cost;
    chosen.add(i);
    if (needsHeader) chosen.add(c.header);
    if (c.header >= 0) seen.add(c.text);
  }
  return [...chosen].sort((a, b) => a - b).map((i) => candidates[i]!.text);
}

// ============================================================================
// Folding one turn
// ============================================================================

interface FoldConfig {
  evidenceChars: number;
  rerunnable: Set<string>;
  scoreLine: (line: string) => number;
}

function finalReply(nodes: ContextNode[]): { text: string; interrupted: boolean } {
  const last = nodes[nodes.length - 1]!.message;
  if (last.role === "assistant" && !last.toolCalls?.length && last.content.trim()) {
    return { text: last.content, interrupted: false };
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const m = nodes[i]!.message;
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    const complete = [...m.toolCalls].reverse().find((c) => c.function.name === "CompleteTask");
    if (complete) {
      const summary = parseArgs(complete).summary;
      const text = typeof summary === "string" && summary.trim() ? summary : m.content;
      if (text.trim()) return { text, interrupted: false };
    }
  }
  const lastText = [...nodes].reverse().find((n) => n.message.role === "assistant" && n.message.content.trim());
  return { text: lastText ? lastText.message.content : "", interrupted: true };
}

/** The folded assistant message for a turn (head excluded). */
function foldMessage(turn: Turn, config: FoldConfig): Message {
  const body = turn.nodes.slice(1);
  const results = new Map<string, Message>();
  for (const n of body) if (n.message.role === "tool" && n.message.toolCallId) results.set(n.message.toolCallId, n.message);

  const reply = finalReply(turn.nodes);
  const headerScore = reply.interrupted ? INTERRUPTED_HEADER_SCORE : HEADER_SCORE;
  const candidates: Candidate[] = [];
  let toolCalls = 0;

  for (const node of body) {
    const m = node.message;
    if (m.role === "user" || m.role === "system") {
      // A message injected mid-turn — keep what was said.
      const text = truncate(`${m.role}: ${m.content.replace(/\s+/g, " ").trim()}`, MAX_LINE_CHARS);
      candidates.push({ text, score: USER_LINE_SCORE, header: -1 });
      continue;
    }
    if (m.role !== "assistant" || !m.toolCalls?.length) continue;
    for (const call of m.toolCalls) {
      toolCalls++;
      const name = call.function.name;
      const result = results.get(call.id);
      if (name === "AskUser") {
        const question = String(parseArgs(call).question ?? "").replace(/\s+/g, " ").trim();
        const answer = (result?.content ?? "(no answer)").replace(/^User answered:\s*/, "").replace(/\s+/g, " ").trim();
        candidates.push({ text: truncate(`$ AskUser: ${question} → ${answer}`, MAX_LINE_CHARS), score: USER_LINE_SCORE, header: -1 });
        continue;
      }
      if (INTERNAL_TOOLS.has(name) || config.rerunnable.has(name)) continue;

      const preview = argPreview(call);
      const failed = !!result && result.content.startsWith("Error:");
      const header = candidates.length;
      candidates.push({
        text: preview ? `$ ${name}: ${preview}` : `$ ${name}`,
        score: failed ? Math.max(headerScore, FAILED_HEADER_SCORE) : headerScore,
        header: -1,
      });
      if (!result) {
        candidates.push({ text: "(no result)", score: headerScore, header });
        continue;
      }
      for (const line of outputLines(result.content)) {
        const base = config.scoreLine(line);
        if (base <= 0) continue;
        candidates.push({ text: truncate(line, MAX_LINE_CHARS), score: failed ? base + FAILED_OUTPUT_BONUS : base, header });
      }
    }
  }

  const evidence = selectEvidence(candidates, config.evidenceChars);
  const parts = [`${FOLD_MARKER} — ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}, ${body.length} message${body.length === 1 ? "" : "s"} omitted]`];
  if (evidence.length) parts.push(`<evidence>\n${evidence.join("\n")}\n</evidence>`);
  let content = parts.join("\n");
  const tail = reply.interrupted
    ? ["(turn ended without a final reply)", reply.text].filter((s) => s.trim()).join("\n\n")
    : reply.text;
  content += `\n\n${tail}`;
  return { role: "assistant", content };
}

function turnTokens(turn: Turn, estimate: (text: string) => number): number {
  return graphTokens(turn.nodes, estimate);
}

function canFold(turn: Turn): boolean {
  const head = turn.nodes[0]!.message;
  if (head.role !== "user") return false;
  if (turn.nodes.length < 2) return false;
  if (isFoldedTurn(turn)) return false;
  const hasTools = turn.nodes.some((n) => n.message.role === "tool" || !!n.message.toolCalls?.length);
  // A plain question and answer has nothing to fold.
  if (!hasTools && turn.nodes.length <= 2) return false;
  return true;
}

// ============================================================================
// The strategy
// ============================================================================

/**
 * Model-free compaction: once the older turns exceed `budget` estimated
 * tokens, fold every one of them (all but the last `keep`, and never the
 * in-progress last turn) into its user message plus one assistant message
 * holding an evidence block and the turn's final reply.  Nodes with an
 * unknown turn and turns folded before are left as they are.
 *
 * With `ctx.targetTokens` (an automatic run under
 * `compactAtTokens: { trigger, target }`) the budget gate is skipped and
 * the goal is an estimated context at or under the target: fold with
 * `keep`, and while the estimate is still above the target, fold with
 * `keep - 1`, `keep - 2`, … down to 1.  The estimate is the strategy's
 * estimator over the resulting messages, scaled by
 * `ctx.tokens / estimate(input)` when `ctx.tokens` is given (so the
 * system prompt and tokenizer differences are accounted for).
 */
export function foldTurns(options: FoldTurnsOptions = {}): ContextStrategy {
  const keep = Math.max(0, options.keep ?? FOLD_DEFAULTS.keep);
  const budget = Math.max(0, options.budget ?? FOLD_DEFAULTS.budget);
  const estimate = options.estimateTokens ?? estimateTokens;
  const config: FoldConfig = {
    evidenceChars: Math.max(0, options.evidenceChars ?? FOLD_DEFAULTS.evidenceChars),
    rerunnable: new Set(options.rerunnable ?? FOLD_DEFAULTS.rerunnable),
    scoreLine: options.scoreLine ?? scoreEvidenceLine,
  };
  // A turn's fold depends only on the turn — cache it across `keep` attempts.
  const foldOne = (turn: Turn, cache: Map<string, ContextNode>): ContextNode => {
    let fold = cache.get(turn.id);
    if (!fold) {
      fold = { id: `fold#${turn.id}`, message: foldMessage(turn, config), turn: turn.id };
      cache.set(turn.id, fold);
    }
    return fold;
  };

  /** Fold the foldable turns among all but the last `k`; null when there are none. */
  const foldWith = (
    graph: ContextGraph,
    turns: Turn[],
    k: number,
    gate: number | null,
    cache: Map<string, ContextNode>,
  ): ContextGraph | null => {
    // The last turn may still be running; the last `k` are kept whole.
    const older = turns.slice(0, Math.max(0, turns.length - Math.max(k, 1)));
    const foldable = older.filter(canFold);
    if (foldable.length === 0) return null;
    if (gate !== null) {
      const tokens = foldable.reduce((sum, t) => sum + turnTokens(t, estimate), 0);
      if (tokens <= gate) return null;
    }

    // Each folded turn becomes [head, fold] at the head's position.
    const replace = new Map<number, ContextNode[]>();
    const drop = new Set<number>();
    for (const turn of foldable) {
      replace.set(turn.indices[0]!, [turn.nodes[0]!, foldOne(turn, cache)]);
      for (const i of turn.indices.slice(1)) drop.add(i);
    }

    const nodes: ContextNode[] = [];
    graph.nodes.forEach((node, i) => {
      const swap = replace.get(i);
      if (swap) nodes.push(...swap);
      else if (!drop.has(i)) nodes.push(node);
    });
    return contextGraph(graph.agent, nodes);
  };

  return (graph, ctx) => {
    const turns = turnsOf(reattributeFolds(graph));
    const cache = new Map<string, ContextNode>();
    const target = ctx?.targetTokens;
    if (target === undefined) return foldWith(graph, turns, keep, budget, cache) ?? graph;

    // Range mode: the caller decided compaction is due — no budget gate.
    const inputEstimate = graphTokens(graph.nodes, estimate);
    const scale = ctx.tokens !== undefined && ctx.tokens > 0 && inputEstimate > 0 ? ctx.tokens / inputEstimate : 1;
    const fits = (g: ContextGraph) => graphTokens(g.nodes, estimate) * scale <= target;

    // A smaller `k` folds a superset of the turns a larger one does; null
    // means nothing (more) to fold at this `k`, so the last result stands.
    let best: ContextGraph = graph;
    for (let k = Math.max(keep, 1); k >= 1; k--) {
      best = foldWith(graph, turns, k, null, cache) ?? best;
      if (fits(best)) break;
    }
    return best;
  };
}

/**
 * A fold written by an earlier run comes back from the log attributed to
 * the turn that ran the compaction (`history_replaced` only carries
 * messages), which would make that turn look folded and group it with
 * older ones.  A fold always directly follows its turn's user message:
 * give it that message's turn again.  Node indices are unchanged.
 */
function reattributeFolds(graph: ContextGraph): ContextGraph {
  let nodes: ContextNode[] | null = null;
  graph.nodes.forEach((node, i) => {
    const prev = graph.nodes[i - 1];
    if (
      prev && prev.turn !== null && prev.message.role === "user" && node.turn !== prev.turn &&
      node.message.role === "assistant" && node.message.content.startsWith(FOLD_MARKER)
    ) {
      nodes ??= [...graph.nodes];
      nodes[i] = { ...node, turn: prev.turn };
    }
  });
  return nodes ? { ...graph, nodes } : graph;
}

/** Estimated tokens of a list of nodes (content plus tool-call JSON). */
function graphTokens(nodes: ReadonlyArray<ContextNode>, estimate: (text: string) => number): number {
  let total = 0;
  for (const n of nodes) {
    total += estimate(n.message.content);
    if (n.message.toolCalls?.length) total += estimate(JSON.stringify(n.message.toolCalls));
  }
  return total;
}
