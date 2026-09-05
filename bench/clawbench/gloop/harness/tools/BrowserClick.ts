import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { ACTION_TIMEOUT_MS, getPage, pageHeader, refLocator, settle } from "/opt/gloop-harness/lib/browser.ts";

const BrowserClick: ToolDefinition = {
  name: "BrowserClick",
  description:
    "Click an element by its snapshot ref (e.g. e12). Handles scrolling into view and stubborn overlays; new tabs opened by the click become the active tab. Returns the resulting url/title.",
  arguments: [
    { name: "ref", description: "Element ref from BrowserSnapshot" },
    { name: "double", description: "Optional: 'true' for a double-click" },
  ],
  execute: async (args) => {
    const page = await getPage();
    if (!args.ref) throw new Error("ref is required");
    const loc = refLocator(page, args.ref);
    const double = (args.double ?? "").toLowerCase() === "true";
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => null);
    try {
      if (double) await loc.dblclick({ timeout: ACTION_TIMEOUT_MS });
      else await loc.click({ timeout: ACTION_TIMEOUT_MS });
    } catch (first) {
      try {
        await loc.click({ timeout: 5_000, force: true });
      } catch {
        // Last resort: synthetic click (works for elements covered by transparent layers).
        const clicked = await loc.evaluate((el) => {
          (el as HTMLElement).click();
          return true;
        }).catch(() => false);
        if (!clicked) throw first;
      }
    }
    await settle(page);
    const current = await getPage(); // may be a popup opened by the click
    return `Clicked ${args.ref}.\n${await pageHeader(current)}`;
  },
};

export default BrowserClick;
