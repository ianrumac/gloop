/**
 * actions.ts — the browser actions behind gloop's Browser* tools.
 *
 * Runs inside the Node browser daemon (see server.ts), which holds the
 * Playwright-over-CDP session. Each action takes the tool's string args
 * and returns the tool's string result; errors propagate as exceptions.
 */

import {
  ACTION_TIMEOUT_MS,
  getContext,
  getPage,
  listPages,
  pageHeader,
  refLocator,
  setActivePage,
  settle,
  snapshot,
  truncate,
} from "../lib/browser.ts";

type Args = Record<string, string>;
export type Action = (args: Args) => Promise<string>;

const isTrue = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";
const withScheme = (u: string) => (/^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`);

export const actions: Record<string, Action> = {
  async BrowserNavigate(args) {
    const page = await getPage();
    const target = (args.url ?? "").trim();
    if (!target) throw new Error("url is required");
    const lower = target.toLowerCase();
    if (lower === "back") await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    else if (lower === "forward") await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
    else if (lower === "reload") await page.reload({ waitUntil: "domcontentloaded" });
    else await page.goto(withScheme(target), { waitUntil: "domcontentloaded" });
    await settle(page);
    return `Navigated.\n${await pageHeader(page)}`;
  },

  async BrowserSnapshot(args) {
    const page = await getPage();
    const max = Number.parseInt(args.maxItems ?? "", 10);
    return snapshot(page, Number.isFinite(max) && max > 0 ? max : 250);
  },

  async BrowserClick(args) {
    const page = await getPage();
    if (!args.ref) throw new Error("ref is required");
    const loc = refLocator(page, args.ref);
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => null);
    try {
      if (isTrue(args.double)) await loc.dblclick({ timeout: ACTION_TIMEOUT_MS });
      else await loc.click({ timeout: ACTION_TIMEOUT_MS });
    } catch (first) {
      try {
        await loc.click({ timeout: 5_000, force: true });
      } catch {
        // Last resort: synthetic click (elements under transparent overlays).
        const clicked = await loc
          .evaluate((el) => {
            (el as HTMLElement).click();
            return true;
          })
          .catch(() => false);
        if (!clicked) throw first;
      }
    }
    await settle(page);
    const current = await getPage(); // may be a popup opened by the click
    return `Clicked ${args.ref}.\n${await pageHeader(current)}`;
  },

  async BrowserType(args) {
    const page = await getPage();
    if (!args.ref) throw new Error("ref is required");
    const text = args.text ?? "";
    const loc = refLocator(page, args.ref);
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => null);
    if (isTrue(args.slowly)) {
      await loc.click();
      await page.keyboard.press("ControlOrMeta+A").catch(() => null);
      await page.keyboard.press("Backspace").catch(() => null);
      await loc.pressSequentially(text, { delay: 40 });
    } else {
      try {
        await loc.fill(text);
      } catch {
        await loc.click();
        await page.keyboard.press("ControlOrMeta+A").catch(() => null);
        await page.keyboard.type(text);
      }
    }
    if (isTrue(args.submit)) {
      await loc.press("Enter").catch(() => page.keyboard.press("Enter"));
      await settle(page);
    }
    return `Typed into ${args.ref}.\n${await pageHeader(await getPage())}`;
  },

  async BrowserSelect(args) {
    const page = await getPage();
    if (!args.ref) throw new Error("ref is required");
    if (!args.option) throw new Error("option is required");
    const loc = refLocator(page, args.ref);
    let picked: string[];
    try {
      picked = await loc.selectOption({ label: args.option });
    } catch {
      picked = await loc.selectOption({ value: args.option }).catch(() => loc.selectOption(args.option!));
    }
    await settle(page, 800);
    return `Selected ${JSON.stringify(picked)} in ${args.ref}.\n${await pageHeader(page)}`;
  },

  async BrowserHover(args) {
    const page = await getPage();
    if (!args.ref) throw new Error("ref is required");
    const loc = refLocator(page, args.ref);
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => null);
    await loc.hover();
    await settle(page, 600);
    return `Hovering ${args.ref}.\n${await pageHeader(page)}`;
  },

  async BrowserPressKey(args) {
    const page = await getPage();
    if (!args.key) throw new Error("key is required");
    await page.keyboard.press(args.key);
    await settle(page, 800);
    return `Pressed ${args.key}.\n${await pageHeader(page)}`;
  },

  async BrowserScroll(args) {
    const page = await getPage();
    if (args.ref) {
      await refLocator(page, args.ref).scrollIntoViewIfNeeded();
      return `Scrolled ${args.ref} into view.\n${await pageHeader(page)}`;
    }
    const dir = (args.direction ?? "down").toLowerCase();
    const amt = Number.parseInt(args.amount ?? "", 10);
    const px = Number.isFinite(amt) && amt > 0 ? amt : 700;
    const [dx, dy] = dir === "up" ? [0, -px] : dir === "left" ? [-px, 0] : dir === "right" ? [px, 0] : [0, px];
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(400);
    const pos = await page
      .evaluate(() => `${Math.round(window.scrollY)}/${Math.round(document.documentElement.scrollHeight - window.innerHeight)}`)
      .catch(() => "?");
    return `Scrolled ${dir} ${px}px (scrollY ${pos}).\n${await pageHeader(page)}`;
  },

  async BrowserGetText(args) {
    const page = await getPage();
    const cap = Number.parseInt(args.maxChars ?? "", 10);
    const max = Number.isFinite(cap) && cap > 0 ? cap : 6_000;
    const sel = (args.selector ?? "").trim();
    let text: string;
    if (!sel) text = await page.locator("body").innerText({ timeout: 10_000 });
    else if (/^(?:f\d+)?e\d+$/i.test(sel)) text = await refLocator(page, sel).innerText({ timeout: 10_000 });
    else text = await page.locator(sel).first().innerText({ timeout: 10_000 });
    const cleaned = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return `${await pageHeader(page)}\n\n${truncate(cleaned, max)}`;
  },

  async BrowserTabs(args) {
    const action = (args.action ?? "list").toLowerCase();
    const pages = await listPages();
    const active = await getPage();
    const describe = async () => {
      const lines: string[] = [];
      const current = await getPage();
      for (const [i, p] of (await listPages()).entries()) {
        const title = await p.title().catch(() => "");
        lines.push(`${p === current ? "*" : " "} [${i}] ${title || "(untitled)"} — ${p.url()}`);
      }
      return lines.join("\n");
    };
    if (action === "list") return `tabs:\n${await describe()}`;
    if (action === "switch") {
      const i = Number.parseInt(args.index ?? "", 10);
      const target = pages[i];
      if (!target) throw new Error(`No tab with index ${args.index}. Tabs:\n${await describe()}`);
      setActivePage(target);
      await target.bringToFront().catch(() => null);
      return `Switched to tab ${i}.\n${await pageHeader(target)}`;
    }
    if (action === "new") {
      const ctx = await getContext();
      const page = await ctx.newPage();
      setActivePage(page);
      if (args.url) {
        await page.goto(withScheme(args.url), { waitUntil: "domcontentloaded" });
        await settle(page);
      }
      return `Opened new tab.\n${await pageHeader(page)}`;
    }
    if (action === "close") {
      const i = args.index ? Number.parseInt(args.index, 10) : pages.indexOf(active);
      const target = pages[i];
      if (!target) throw new Error(`No tab with index ${args.index}.`);
      await target.close();
      const remaining = await listPages();
      if (remaining.length) setActivePage(remaining[remaining.length - 1]!);
      return `Closed tab ${i}.\ntabs:\n${await describe()}`;
    }
    throw new Error(`Unknown action "${args.action}". Use list | switch | new | close.`);
  },

  async BrowserWait(args) {
    const page = await getPage();
    const secs = Math.min(30, Math.max(0, Number.parseFloat(args.seconds ?? "") || 2));
    await settle(page, 2_000);
    let note: string;
    if (args.text) {
      try {
        await page.getByText(args.text, { exact: false }).first().waitFor({ state: "visible", timeout: Math.max(1, secs) * 1000 });
        note = `Text "${args.text}" is visible.`;
      } catch {
        note = `Text "${args.text}" did not appear within ${secs}s.`;
      }
    } else {
      // Wait for the page to go idle, but never longer than requested; a
      // fixed sleep wastes the task's time budget on already-settled pages.
      const started = Date.now();
      await page.waitForTimeout(Math.min(500, secs * 1000));
      await page.waitForLoadState("networkidle", { timeout: Math.max(0, secs * 1000 - 500) }).catch(() => null);
      note = `Page idle after ${((Date.now() - started) / 1000).toFixed(1)}s (asked for up to ${secs}s).`;
    }
    return `${note}\n${await pageHeader(page)}`;
  },

  async BrowserExecuteJs(args) {
    const page = await getPage();
    if (!args.script) throw new Error("script is required");
    const result = await page.evaluate(args.script);
    let rendered: string;
    try {
      rendered = result === undefined ? "undefined" : JSON.stringify(result, null, 1);
    } catch {
      rendered = String(result);
    }
    return truncate(rendered ?? "null", 6_000);
  },
};
