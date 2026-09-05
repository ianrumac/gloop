/**
 * browser.ts — shared Playwright-over-CDP session for the gloop ClawBench harness.
 *
 * Every Browser* tool in ../tools imports this module by absolute path
 * (/opt/gloop-harness/lib/browser.ts inside the container), so the CDP
 * connection, the active page and the ref counters are shared across tools
 * and survive gloop's `Reload` (which re-imports the tool files, not the lib).
 *
 * Refs: BrowserSnapshot stamps every visible interactive element with a
 * `data-gloop-ref` attribute and reports it as `e12` (main frame) or `f2e12`
 * (frame #2). Action tools resolve refs back to locators via `refLocator`.
 */

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright-core";

const CDP_URL = process.env.CLAWBENCH_BROWSER_CDP_URL || "http://127.0.0.1:9222";
export const ACTION_TIMEOUT_MS = 15_000;
export const NAV_TIMEOUT_MS = 45_000;

let browser: Browser | null = null;
let context: BrowserContext | null = null;
let active: Page | null = null;
let lastDialog = "";
const wired = new WeakSet<Page>();

function wirePage(page: Page): void {
  if (wired.has(page)) return;
  wired.add(page);
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
  page.on("dialog", async (dialog) => {
    lastDialog = `${dialog.type()}: ${dialog.message()}`;
    try {
      await dialog.accept();
    } catch {
      /* already handled */
    }
  });
}

export async function getBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  browser = await chromium.connectOverCDP(CDP_URL, { timeout: 30_000 });
  browser.on("disconnected", () => {
    browser = null;
    context = null;
    active = null;
  });
  context = browser.contexts()[0] ?? (await browser.newContext());
  context.on("page", (page) => {
    wirePage(page);
    // A click that opened a popup/tab almost always wants follow-up actions
    // on the new page, so it becomes the active one.
    active = page;
  });
  for (const page of context.pages()) wirePage(page);
  return browser;
}

export async function getContext(): Promise<BrowserContext> {
  await getBrowser();
  return context!;
}

export async function listPages(): Promise<Page[]> {
  const ctx = await getContext();
  return ctx.pages().filter((p) => !p.isClosed());
}

export async function getPage(): Promise<Page> {
  const ctx = await getContext();
  if (active && !active.isClosed()) return active;
  const open = ctx.pages().filter((p) => !p.isClosed());
  active = open[open.length - 1] ?? (await ctx.newPage());
  wirePage(active);
  return active;
}

export function setActivePage(page: Page): void {
  wirePage(page);
  active = page;
}

/** Return and clear the last auto-accepted dialog message. */
export function takeDialog(): string {
  const d = lastDialog;
  lastDialog = "";
  return d;
}

/** Best-effort wait for a page to calm down after an action. */
export async function settle(page: Page, idleMs = 1_500): Promise<void> {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 });
  } catch {
    /* no navigation happened */
  }
  try {
    await page.waitForLoadState("networkidle", { timeout: idleMs });
  } catch {
    /* still busy — fine */
  }
}

export async function pageHeader(page: Page): Promise<string> {
  let title = "";
  try {
    title = await page.title();
  } catch {
    /* page navigating */
  }
  const dialog = takeDialog();
  return `url: ${page.url()}\ntitle: ${title}${dialog ? `\ndialog (auto-accepted): ${dialog}` : ""}`;
}

const REF_RE = /^(?:f(\d+))?e(\d+)$/i;

/** Resolve a snapshot ref (`e12` or `f2e12`) to a Playwright locator. */
export function refLocator(page: Page, ref: string) {
  const m = REF_RE.exec(ref.trim());
  if (!m) {
    throw new Error(`Invalid ref "${ref}". Use a ref from BrowserSnapshot, e.g. e12 or f2e12.`);
  }
  const frameIdx = m[1] ? Number(m[1]) : 0;
  const frames = page.frames();
  const frame = frameIdx === 0 ? page.mainFrame() : frames[frameIdx];
  if (!frame) throw new Error(`Frame f${frameIdx} no longer exists — take a new BrowserSnapshot.`);
  return frame.locator(`[data-gloop-ref="${m[2]}"]`).first();
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

interface SnapshotItem {
  kind: "el" | "heading";
  ref?: string;
  role?: string;
  label: string;
  attrs?: string;
}

interface FrameSnapshot {
  items: SnapshotItem[];
  total: number;
}

/**
 * Runs inside the page. Must stay self-contained (no closures over module
 * scope) because Playwright serialises it.
 */
function collectInPage(maxItems: number): FrameSnapshot {
  const w = window as unknown as { __gloopRefSeq?: number };
  if (!w.__gloopRefSeq) w.__gloopRefSeq = 0;

  const INTERACTIVE =
    'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], ' +
    '[role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], ' +
    '[role="menuitemradio"], [role="option"], [role="combobox"], [role="textbox"], [role="switch"], ' +
    '[role="slider"], [role="searchbox"], [role="spinbutton"], [contenteditable="true"], ' +
    '[contenteditable=""], [onclick], [tabindex]:not([tabindex="-1"])';
  const HEADING = "h1, h2, h3";

  const clean = (s: string | null | undefined) => (s || "").replace(/\s+/g, " ").trim();
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  const visible = (el: Element) => {
    const st = getComputedStyle(el);
    if (st.display === "none" || st.visibility === "hidden" || st.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    // Fully outside the document (e.g. off-screen menus) is still "visible"
    // enough to scroll to, so no viewport check here.
    return true;
  };

  const roleOf = (el: Element) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "select") return "select";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      const map: Record<string, string> = {
        checkbox: "checkbox",
        radio: "radio",
        submit: "button",
        button: "button",
        reset: "button",
        image: "button",
        file: "file",
        range: "slider",
        search: "searchbox",
        password: "password",
        email: "textbox",
        tel: "textbox",
        number: "spinbutton",
        date: "date",
        hidden: "hidden",
      };
      return map[t] || "textbox";
    }
    if ((el as HTMLElement).isContentEditable) return "textbox";
    return "clickable";
  };

  const labelOf = (el: Element) => {
    const aria = el.getAttribute("aria-label");
    if (aria && clean(aria)) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by
        .split(/\s+/)
        .map((id) => (document.getElementById(id) as HTMLElement | null)?.innerText || "")
        .join(" ");
      if (clean(t)) return clean(t);
    }
    const labels = (el as HTMLInputElement).labels;
    if (labels && labels.length) {
      const t = clean(Array.from(labels).map((l) => l.innerText).join(" "));
      if (t) return t;
    }
    const txt = clean((el as HTMLElement).innerText || el.textContent);
    if (txt) return txt;
    for (const a of ["placeholder", "title", "alt", "name", "value", "id"]) {
      const v = el.getAttribute(a);
      if (v && clean(v)) return clean(v);
    }
    const img = el.querySelector("img[alt]");
    if (img) return clean(img.getAttribute("alt"));
    return "";
  };

  const attrsOf = (el: Element, role: string) => {
    const parts: string[] = [];
    const tag = el.tagName.toLowerCase();
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) parts.push(`href=${cut(href, 80)}`);
    }
    if (tag === "input" || tag === "textarea") {
      const input = el as HTMLInputElement;
      const type = (input.getAttribute("type") || "").toLowerCase();
      if (type === "checkbox" || type === "radio") {
        if (input.checked) parts.push("checked");
      } else if (type !== "password" && input.value) {
        parts.push(`value="${cut(clean(input.value), 60)}"`);
      }
      const ph = input.getAttribute("placeholder");
      if (ph && clean(ph) && clean(ph) !== labelOf(el)) parts.push(`placeholder="${cut(clean(ph), 40)}"`);
      if (input.required) parts.push("required");
    }
    if (tag === "select") {
      const sel = el as HTMLSelectElement;
      const opts = Array.from(sel.options).map((o) => clean(o.text));
      parts.push(`options=[${cut(opts.slice(0, 12).join("|"), 160)}${opts.length > 12 ? `|…+${opts.length - 12}` : ""}]`);
      if (sel.selectedIndex >= 0) parts.push(`selected="${cut(clean(sel.options[sel.selectedIndex]?.text || ""), 40)}"`);
    }
    if (role === "checkbox" || role === "switch" || role === "radio" || role === "tab") {
      const ac = el.getAttribute("aria-checked") ?? el.getAttribute("aria-selected");
      if (ac === "true") parts.push("checked");
    }
    if (el.getAttribute("aria-expanded") === "true") parts.push("expanded");
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") parts.push("disabled");
    return parts.join(" ");
  };

  const items: SnapshotItem[] = [];
  let total = 0;
  const emitted = new Map<Element, string>();
  const all = document.body ? document.body.querySelectorAll<HTMLElement>("*") : ([] as unknown as NodeListOf<HTMLElement>);

  for (const el of Array.from(all)) {
    const tag = el.tagName.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") continue;

    if (el.matches(HEADING)) {
      if (!visible(el)) continue;
      const t = clean(el.innerText);
      if (!t) continue;
      total++;
      if (items.length < maxItems) items.push({ kind: "heading", label: `${"#".repeat(Number(tag[1]))} ${cut(t, 120)}` });
      continue;
    }

    if (!el.matches(INTERACTIVE)) continue;
    if (tag === "input" && (el.getAttribute("type") || "").toLowerCase() === "hidden") continue;
    if (!visible(el)) continue;

    const role = roleOf(el);
    const label = cut(labelOf(el), 80);

    // Skip nested duplicates: <a><button>Same text</button></a>.
    const parentInteractive = el.parentElement?.closest(INTERACTIVE) as Element | null;
    if (parentInteractive && emitted.get(parentInteractive) === label && roleOf(parentInteractive) === role) continue;

    total++;
    if (items.length >= maxItems) continue;

    let id = el.getAttribute("data-gloop-ref");
    if (!id) {
      w.__gloopRefSeq = (w.__gloopRefSeq || 0) + 1;
      id = String(w.__gloopRefSeq);
      el.setAttribute("data-gloop-ref", id);
    }
    emitted.set(el, label);
    items.push({ kind: "el", ref: id, role, label, attrs: attrsOf(el, role) });
  }

  return { items, total };
}

async function snapshotFrame(frame: Frame, prefix: string, maxItems: number): Promise<string[]> {
  const snap = await frame.evaluate(collectInPage, maxItems);
  const lines: string[] = [];
  for (const it of snap.items) {
    if (it.kind === "heading") {
      lines.push(it.label);
    } else {
      lines.push(`${prefix}e${it.ref} ${it.role} "${it.label}"${it.attrs ? ` ${it.attrs}` : ""}`);
    }
  }
  if (snap.total > snap.items.length) {
    lines.push(`… ${snap.total - snap.items.length} more element(s) not shown (raise maxItems or BrowserScroll and snapshot again)`);
  }
  return lines;
}

/**
 * Build a compact, LLM-friendly snapshot of the page: headings for structure
 * and every visible interactive element with a ref, main frame first, then
 * visible child frames (payment widgets, embedded forms, ...).
 */
export async function snapshot(page: Page, maxItems = 250): Promise<string> {
  const out: string[] = [await pageHeader(page)];
  let mainLines: string[];
  try {
    mainLines = await snapshotFrame(page.mainFrame(), "", maxItems);
  } catch (err) {
    // Page mid-navigation: wait briefly and retry once.
    await settle(page, 2_000);
    mainLines = await snapshotFrame(page.mainFrame(), "", maxItems);
  }
  out.push("", "elements:", ...(mainLines.length ? mainLines : ["(no visible interactive elements — page may still be loading; try BrowserWait)"]));

  const frames = page.frames();
  let budget = Math.max(20, Math.floor(maxItems / 3));
  for (let i = 1; i < frames.length && i < 12; i++) {
    const frame = frames[i]!;
    if (frame === page.mainFrame() || frame.isDetached()) continue;
    try {
      const el = await frame.frameElement();
      const box = await el.boundingBox();
      if (!box || box.width < 40 || box.height < 20) continue;
      const lines = await snapshotFrame(frame, `f${i}`, budget);
      if (!lines.length) continue;
      const title = (await frame.title().catch(() => "")) || frame.name() || frame.url();
      out.push("", `frame f${i} (${truncate(title, 80)}):`, ...lines);
      budget = Math.max(10, budget - lines.length);
    } catch {
      /* cross-origin frame that refused evaluation, or it went away */
    }
  }
  return out.join("\n");
}
