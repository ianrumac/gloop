/// <reference lib="dom" />
/**
 * gloop log viewer — browser app.
 *
 * Bundled by `gloop graph --html` (see src/core/graph-command.ts) into a
 * self-contained page.  Reads events from `window.__GLOOP_EVENTS__` when
 * the CLI embedded them, and from dropped / opened .jsonl files otherwise.
 * Everything it shows is a projection over the events — there is no
 * agent, provider or filesystem involved.
 */

import {
  EventLog,
  MemoryEventStore,
  projectState,
  projectGraph,
  linkedLogs,
  type AgentGraph,
  type AgentState,
  type LogEvent,
} from "@hypen-space/gloop-loop/replay";
import {
  NODE_W, NODE_H, GAP_X, PAD,
  clip, esc, layout, mergeEvents, parseJsonl, statusColor, summarize, turnEvents,
} from "./model.ts";

declare global {
  interface Window {
    __GLOOP_EVENTS__?: LogEvent[];
    __GLOOP_SOURCES__?: string[];
    /** A bundled sample log (static hosted build) — loaded on "Load demo". */
    __GLOOP_DEMO__?: LogEvent[];
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let events: LogEvent[] = [];
let log = new EventLog();
let graph: AgentGraph = { agents: [], nodes: [], edges: [], roots: [] };
let sources: string[] = [];
let selectedTurn: string | null = null;
let selectedEvent: string | null = null;
let cursor = 0;
let agentFilter = "*";

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function setEvents(next: LogEvent[], names: string[]): Promise<void> {
  events = mergeEvents(events, next);
  sources = [...new Set([...sources, ...names])];
  log = new EventLog({ store: new MemoryEventStore(events) });
  await log.load();
  graph = projectGraph(events);
  cursor = events.length;
  selectedTurn = graph.roots[0] ?? graph.nodes[0]?.key ?? null;
  selectedEvent = null;
  renderAll();
}

async function loadFiles(files: FileList | File[]): Promise<void> {
  const loaded: LogEvent[] = [];
  const names: string[] = [];
  for (const f of Array.from(files)) {
    loaded.push(...parseJsonl(await f.text()));
    names.push(f.name);
  }
  await setEvents(loaded, names);
}

// ---------------------------------------------------------------------------
// Rendering — header
// ---------------------------------------------------------------------------

function renderHeader(): void {
  const el = $("sources");
  if (!events.length) { el.textContent = "no log loaded"; $("stats").textContent = ""; return; }
  const links = linkedLogs(events).filter((l) => !sources.some((s) => l.log.endsWith(s) || s.endsWith(l.log)));
  el.textContent = sources.join(", ") + (links.length ? `   ·   also referenced: ${links.map((l) => `${l.direction} ${l.log}`).join(", ")}` : "");
  el.title = el.textContent;
  $("stats").textContent = `${events.length} events · ${graph.agents.length} agents · ${graph.nodes.length} turns · ${graph.edges.length} edges`;
  $("graphWrap").classList.toggle("empty", events.length === 0);
}

// ---------------------------------------------------------------------------
// Rendering — turn graph
// ---------------------------------------------------------------------------

function renderGraph(): void {
  const svg = $("graph") as unknown as SVGSVGElement;
  const pos = layout(graph);
  let maxX = 0, maxY = 0;
  for (const p of pos.values()) { maxX = Math.max(maxX, p.x + NODE_W); maxY = Math.max(maxY, p.y + NODE_H); }
  svg.setAttribute("width", String(maxX + PAD));
  svg.setAttribute("height", String(maxY + PAD));

  const parts: string[] = [
    `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow"/></marker></defs>`,
  ];
  for (const e of graph.edges) {
    const to = pos.get(e.to);
    if (!to) continue;
    const from = e.from ? pos.get(e.from) : undefined;
    const x2 = to.x, y2 = to.y + NODE_H / 2;
    const x1 = from ? from.x + NODE_W : to.x - GAP_X + 10;
    const y1 = from ? from.y + NODE_H / 2 : y2;
    const mx = (x1 + x2) / 2;
    parts.push(`<path class="edge${from ? "" : " dangling"}" marker-end="url(#arrow)" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`);
    parts.push(`<text class="edgeLabel" x="${mx}" y="${(y1 + y2) / 2 - 5}" text-anchor="middle">${esc(e.causeType ?? "cause")}</text>`);
  }
  for (const { x, y, node } of pos.values()) {
    const sel = node.key === selectedTurn ? " selected" : "";
    const title = clip(node.message.content, 30);
    const sub = node.summary ? "→ " + clip(node.summary, 30) : node.message.role === "system" ? "(system prompt)" : "";
    parts.push(
      `<g class="node${sel}" data-key="${esc(node.key)}" transform="translate(${x},${y})">` +
      `<rect width="${NODE_W}" height="${NODE_H}"/>` +
      `<rect class="bar" x="0" y="0" width="6" height="${NODE_H}" style="fill:${statusColor[node.status] ?? "var(--queued)"}"/>` +
      `<text x="14" y="18" font-weight="600">${esc(clip(node.agent, 28))}</text>` +
      `<text class="meta" x="14" y="33">${esc(node.turn)} · ${esc(node.status)}</text>` +
      `<text x="14" y="50">${esc(title)}</text>` +
      (sub ? `<text class="meta" x="14" y="66">${esc(sub)}</text>` : "") +
      `<title>${esc(node.message.content)}${node.summary ? "\n\n→ " + esc(node.summary) : ""}</title>` +
      `</g>`,
    );
  }
  svg.innerHTML = parts.join("");
  svg.querySelectorAll<SVGGElement>(".node").forEach((g) => {
    g.addEventListener("click", () => { selectedTurn = g.dataset.key!; selectedEvent = null; renderGraph(); renderTurn(); renderInspector(); });
  });
}

// ---------------------------------------------------------------------------
// Rendering — turn panel + inspector
// ---------------------------------------------------------------------------

function eventRow(e: LogEvent, extraClass = ""): string {
  const sel = e.eventId === selectedEvent ? " selected" : "";
  return `<div class="ev${sel}${extraClass}" data-id="${esc(e.eventId)}"><span class="seq">${e.seq}</span><span class="type">${esc(e.type)}</span><span class="sum">${esc(clip(summarize(e), 160))}</span></div>`;
}

function wireRows(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>(".ev").forEach((row) => {
    row.addEventListener("click", () => { selectedEvent = row.dataset.id!; renderTurn(); renderInspector(); });
  });
}

function renderTurn(): void {
  const el = $("turnPanel");
  if (!selectedTurn) { el.innerHTML = `<h2>Turn</h2><div class="empty">Select a turn in the graph.</div>`; return; }
  const list = turnEvents(events, selectedTurn);
  el.innerHTML = `<h2>Turn ${esc(selectedTurn)} · ${list.length} events</h2>` + list.map((e) => eventRow(e)).join("");
  wireRows(el);
}

function renderInspector(): void {
  const el = $("inspector");
  const e = selectedEvent ? log.get(selectedEvent) : undefined;
  if (!e) { el.innerHTML = `<h2>Event</h2><div class="empty">Select an event.</div>`; return; }
  const chain = log.ancestors(e.eventId).slice(1);
  const kids = log.children(e.eventId);
  const chip = (x: LogEvent) => `<span class="chip${x.agent !== e.agent ? " other" : ""}" data-id="${esc(x.eventId)}" title="${esc(x.eventId)}">${esc(x.agent)} · ${esc(x.type)} #${x.seq}</span>`;
  el.innerHTML =
    `<h2>Event ${esc(e.type)} #${e.seq}</h2>` +
    `<div class="kv"><b>id</b> ${esc(e.eventId)} <b>agent</b> ${esc(e.agent)} <b>turn</b> ${esc(String(e.turn))} <b>at</b> ${new Date(e.ts).toLocaleTimeString()}</div>` +
    (chain.length ? `<div class="kv"><b>caused by</b></div><div class="chain">${chain.map(chip).join("")}</div>` : `<div class="kv"><b>root</b> — nothing caused this event</div>`) +
    (kids.length ? `<div class="kv"><b>led to</b> ${kids.length} event(s)</div><div class="chain">${kids.slice(0, 40).map(chip).join("")}</div>` : "") +
    `<pre>${esc(JSON.stringify(e, null, 2))}</pre>`;
  el.querySelectorAll<HTMLElement>(".chip").forEach((c) => c.addEventListener("click", () => jumpTo(c.dataset.id!)));
}

function jumpTo(eventId: string): void {
  const e = log.get(eventId);
  if (!e) return;
  selectedEvent = eventId;
  const turn = e.turn ?? (e.type === "message_queued" ? e.message.id ?? null : null);
  if (turn) selectedTurn = `${e.agent}:${turn}`;
  renderGraph(); renderTurn(); renderInspector();
}

// ---------------------------------------------------------------------------
// Rendering — scrubber + projected state
// ---------------------------------------------------------------------------

function renderScrubber(): void {
  const scrub = $<HTMLInputElement>("scrub");
  scrub.max = String(events.length);
  scrub.value = String(cursor);
  const sel = $<HTMLSelectElement>("agent");
  const agents = [...new Set(events.map((e) => e.agent))];
  sel.innerHTML = [`<option value="*">all agents</option>`, ...agents.map((a) => `<option value="${esc(a)}"${a === agentFilter ? " selected" : ""}>${esc(a)}</option>`)].join("");
  if (agentFilter !== "*" && !agents.includes(agentFilter)) agentFilter = "*";
  const at = events[cursor - 1];
  $("scrubLabel").textContent = at ? `${cursor}/${events.length} · ${at.agent} · ${at.type} #${at.seq}` : `0/${events.length}`;
}

function renderState(): void {
  const slice = events.slice(0, cursor);
  const state: AgentState = projectState(slice, agentFilter === "*" ? undefined : agentFilter);
  const hist = $("history");
  hist.innerHTML = `<h2>Conversation (${state.history.length} messages${agentFilter === "*" ? ", all agents folded" : ""})</h2>` +
    (state.history.length ? state.history.map((m) => `<div class="msg ${m.role}"><div class="role">${m.role}${m.toolCallId ? " · " + esc(m.toolCallId) : ""}${m.toolCalls ? ` · ${m.toolCalls.length} tool call(s)` : ""}</div><div class="body">${esc(clip(m.content, 600))}</div></div>`).join("") : `<div class="empty">empty</div>`);
  const meta = $("meta");
  const turn = state.currentTurn;
  meta.innerHTML = `<h2>Agent state</h2>` +
    `<div class="kv"><b>system</b> ${state.system ? esc(clip(state.system, 120)) : "—"}</div>` +
    `<div class="kv"><b>turns</b> ${state.turns.length} done${turn ? `, running: ${esc(turn.id)} (${turn.llmCalls} llm, ${turn.toolCalls} tools)` : ""}</div>` +
    `<div class="kv"><b>inbox</b> ${state.inbox.length ? state.inbox.map((m) => esc(clip(m.content, 40))).join(" | ") : "empty"}</div>` +
    `<div class="kv"><b>tools</b> ${state.tools.length ? esc(state.tools.join(", ")) : "—"}</div>` +
    `<div class="kv"><b>memory</b></div>` + (state.memory.length ? `<ul class="plain">${state.memory.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>` : `<div class="empty">nothing remembered</div>`) +
    (state.pendingConfirms.length || state.pendingAsks.length ? `<div class="kv"><b>waiting on</b> ${[...state.pendingConfirms.map((c) => "confirm: " + c.command), ...state.pendingAsks.map((a) => "ask: " + a.question)].map((s) => esc(clip(s, 60))).join("; ")}</div>` : "") +
    (state.completions.length ? `<div class="kv"><b>completed</b></div><ul class="plain">${state.completions.map((c) => `<li>${esc(clip(c, 120))}</li>`).join("")}</ul>` : "");
}

function renderAll(): void {
  renderHeader(); renderGraph(); renderTurn(); renderInspector(); renderScrubber(); renderState();
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

$<HTMLInputElement>("file").addEventListener("change", (ev) => {
  const input = ev.target as HTMLInputElement;
  if (input.files?.length) void loadFiles(input.files);
});
document.addEventListener("dragover", (ev) => { ev.preventDefault(); document.body.classList.add("dragging"); });
document.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
document.addEventListener("drop", (ev) => {
  ev.preventDefault();
  document.body.classList.remove("dragging");
  if (ev.dataTransfer?.files.length) void loadFiles(ev.dataTransfer.files);
});
$<HTMLInputElement>("scrub").addEventListener("input", (ev) => {
  cursor = Number((ev.target as HTMLInputElement).value);
  renderScrubber(); renderState();
});
$<HTMLSelectElement>("agent").addEventListener("change", (ev) => {
  agentFilter = (ev.target as HTMLSelectElement).value;
  renderState();
});

const demoBtn = $("demoBtn");
if (window.__GLOOP_DEMO__?.length) {
  demoBtn.hidden = false;
  demoBtn.addEventListener("click", () => { void setEvents(window.__GLOOP_DEMO__!, ["demo: planner → coder + writer, coder spawns a test runner"]); });
}

if (window.__GLOOP_EVENTS__?.length) {
  void setEvents(window.__GLOOP_EVENTS__, window.__GLOOP_SOURCES__ ?? ["embedded"]);
} else {
  renderAll();
}
