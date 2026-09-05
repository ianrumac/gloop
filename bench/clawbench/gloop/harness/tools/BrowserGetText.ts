import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, pageHeader, truncate } from "/opt/gloop-harness/lib/browser.ts";

const BrowserGetText: ToolDefinition = {
  name: "BrowserGetText",
  description:
    "Read the visible text of the page (or of one element by CSS selector / snapshot ref). Use it to read prices, descriptions, confirmation numbers, error messages. Output is trimmed to maxChars (default 6000).",
  arguments: [
    { name: "selector", description: "Optional CSS selector or snapshot ref (e.g. e12); default: whole page" },
    { name: "maxChars", description: "Optional character cap (default 6000)" },
  ],
  execute: async (args) => {
    const page = await getPage();
    const cap = Number.parseInt(args.maxChars ?? "", 10);
    const max = Number.isFinite(cap) && cap > 0 ? cap : 6_000;
    const sel = (args.selector ?? "").trim();
    let text: string;
    if (!sel) {
      text = await page.locator("body").innerText({ timeout: 10_000 });
    } else if (/^(?:f\d+)?e\d+$/i.test(sel)) {
      const { refLocator } = await import("/opt/gloop-harness/lib/browser.ts");
      text = await refLocator(page, sel).innerText({ timeout: 10_000 });
    } else {
      text = await page.locator(sel).first().innerText({ timeout: 10_000 });
    }
    const cleaned = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    return `${await pageHeader(page)}\n\n${truncate(cleaned, max)}`;
  },
};

export default BrowserGetText;
