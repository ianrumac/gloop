import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, snapshot } from "/opt/gloop-harness/lib/browser.ts";

const BrowserSnapshot: ToolDefinition = {
  name: "BrowserSnapshot",
  description:
    "Describe the current page: url, title, headings and every visible interactive element with a ref (e.g. e12, or f2e12 inside an iframe) plus its role, label and state. Use the refs with BrowserClick / BrowserType / BrowserSelect / BrowserHover. Take a fresh snapshot after anything that changes the page.",
  arguments: [
    { name: "maxItems", description: "Optional cap on listed elements (default 250)" },
  ],
  execute: async (args) => {
    const page = await getPage();
    const max = Number.parseInt(args.maxItems ?? "", 10);
    return snapshot(page, Number.isFinite(max) && max > 0 ? max : 250);
  },
};

export default BrowserSnapshot;
