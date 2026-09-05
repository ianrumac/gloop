/**
 * `gloop graph` — show a session log as a graph.
 *
 *   gloop graph [log.jsonl]              Mermaid flowchart of the turn graph
 *   gloop graph [log.jsonl] --json       projectGraph() output as JSON
 *   gloop graph [log.jsonl] --html [out] Self-contained interactive viewer
 *   gloop graph --no-follow              Do not pull in linked parent/child logs
 *
 * Without a path the most recent session in .gloop/sessions/ is used.
 * Linked logs (spawned subagents, and the parent a subagent came from) are
 * followed by default so the graph crosses process boundaries.
 */

import { existsSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import {
  createJsonlEventStore,
  graphToMermaid,
  linkedLogs,
  projectGraph,
  type LogEvent,
} from "@hypen-space/gloop-loop";
import { latestSessionLogPath } from "./session.ts";

export interface GraphArgs {
  log?: string;
  format: "mermaid" | "json" | "html";
  out?: string;
  follow: boolean;
  help: boolean;
}

export function parseGraphArgs(args: string[]): GraphArgs {
  const out: GraphArgs = { format: "mermaid", follow: true, help: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--json") out.format = "json";
    else if (a === "--mermaid") out.format = "mermaid";
    else if (a === "--html") {
      out.format = "html";
      const next = args[i + 1];
      if (next && !next.startsWith("--") && next.endsWith(".html")) out.out = args[++i];
    } else if (a === "--out" && args[i + 1]) out.out = args[++i];
    else if (a === "--no-follow") out.follow = false;
    else if (a === "--help" || a === "-h") out.help = true;
    else if (!a.startsWith("--")) out.log = a;
  }
  return out;
}

export interface LoadedLogs {
  events: LogEvent[];
  /** Log paths that were read, in load order. */
  sources: string[];
  /** Linked logs that could not be found. */
  missing: string[];
}

/** Resolve a locator recorded in another log: as-is, then relative to that log. */
function resolveLinked(locator: string, fromLog: string): string | null {
  const candidates = isAbsolute(locator)
    ? [locator]
    : [resolve(process.cwd(), locator), join(dirname(fromLog), locator)];
  return candidates.find((c) => existsSync(c)) ?? null;
}

/** Load a log and (optionally) every log it links to, transitively. */
export async function loadLogWithLinks(path: string, follow = true): Promise<LoadedLogs> {
  const byId = new Map<string, LogEvent>();
  const sources: string[] = [];
  const missing: string[] = [];
  const queue = [resolve(path)];
  const seen = new Set<string>();

  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p)) continue;
    seen.add(p);
    if (!existsSync(p)) { missing.push(p); continue; }
    const loaded = await createJsonlEventStore(p).load();
    sources.push(p);
    for (const e of loaded) byId.set(e.eventId, e);
    if (!follow) break;
    for (const link of linkedLogs(loaded)) {
      const target = resolveLinked(link.log, p);
      if (target) queue.push(target);
      else if (!missing.includes(link.log)) missing.push(link.log);
    }
  }

  const events = [...byId.values()].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));
  return { events, sources, missing };
}

const VIEWER_DIR = join(import.meta.dirname, "..", "viewer");

/** Bundle the viewer app and embed `events` so the page is fully self-contained. */
export async function buildViewerHtml(events: LogEvent[], sources: string[]): Promise<string> {
  const bundle = await Bun.build({
    entrypoints: [join(VIEWER_DIR, "app.ts")],
    target: "browser",
    format: "esm",
    minify: true,
  });
  if (!bundle.success) {
    throw new Error("viewer bundle failed:\n" + bundle.logs.map((l) => String(l)).join("\n"));
  }
  const js = await bundle.outputs[0]!.text();
  const template = await Bun.file(join(VIEWER_DIR, "template.html")).text();
  // `</` inside a <script> would terminate it early — escape for safety.
  const safe = (s: string) => s.replace(/<\//g, "<\\/");
  const data = `<script>window.__GLOOP_EVENTS__=${safe(JSON.stringify(events))};window.__GLOOP_SOURCES__=${safe(JSON.stringify(sources))};</script>`;
  return template
    .replace("<!--DATA-->", data)
    .replace("<!--APP-->", `<script type="module">${safe(js)}</script>`);
}

/** The bare viewer (no session embedded) — what the hosted page and `buildStaticViewer` start from. */
export async function buildBareViewerHtml(): Promise<string> {
  return buildViewerHtml([], []);
}

export function graphHelp(): string {
  return `\
gloop graph — show a session's event log as a graph.

USAGE
  gloop graph [log.jsonl] [--json | --html [out.html]] [--no-follow]

  log.jsonl     A session log (default: the newest in .gloop/sessions/).
  --json        Print the turn graph (projectGraph) as JSON.
  --html [out]  Write a self-contained interactive viewer (default:
                <log>.html) — turn graph, per-event causality, and a
                scrubber that replays the agent's state at any point.
  --no-follow   Do not load linked logs (spawned subagents / parent).

Default output is a Mermaid flowchart of the turn graph.`;
}

/** Entry point.  Returns the process exit code. */
export async function runGraphCommand(args: string[]): Promise<number> {
  const opts = parseGraphArgs(args);
  if (opts.help) { console.log(graphHelp()); return 0; }

  const logPath = opts.log ?? latestSessionLogPath();
  if (!logPath) {
    console.error("No session log found. Pass a path or run gloop first (.gloop/sessions/ is empty).");
    return 1;
  }
  if (!existsSync(logPath)) {
    console.error(`No such log: ${logPath}`);
    return 1;
  }

  const { events, sources, missing } = await loadLogWithLinks(logPath, opts.follow);
  for (const m of missing) console.error(`warning: linked log not found: ${m}`);
  if (events.length === 0) {
    console.error(`${logPath} holds no events.`);
    return 1;
  }

  switch (opts.format) {
    case "json":
      console.log(JSON.stringify({ sources, ...projectGraph(events) }, null, 2));
      return 0;
    case "html": {
      const out = opts.out ?? logPath.replace(/\.jsonl$/, "") + ".html";
      await Bun.write(out, await buildViewerHtml(events, sources));
      console.log(out);
      return 0;
    }
    default:
      console.log(graphToMermaid(projectGraph(events)));
      return 0;
  }
}
