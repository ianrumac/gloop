import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, pageHeader, refLocator, settle } from "/opt/gloop-harness/lib/browser.ts";

const BrowserHover: ToolDefinition = {
  name: "BrowserHover",
  description: "Move the mouse over an element (by snapshot ref) to reveal hover menus or tooltips.",
  arguments: [{ name: "ref", description: "Element ref from BrowserSnapshot" }],
  execute: async (args) => {
    const page = await getPage();
    if (!args.ref) throw new Error("ref is required");
    const loc = refLocator(page, args.ref);
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => null);
    await loc.hover();
    await settle(page, 600);
    return `Hovering ${args.ref}.\n${await pageHeader(page)}`;
  },
};

export default BrowserHover;
