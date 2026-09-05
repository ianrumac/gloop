import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, truncate } from "/opt/gloop-harness/lib/browser.ts";

const BrowserExecuteJs: ToolDefinition = {
  name: "BrowserExecuteJs",
  description:
    "Run a JavaScript expression in the active page and return its JSON-serialised result (e.g. document.title, or an IIFE that inspects the DOM). Escape hatch for things the other Browser* tools cannot express.",
  arguments: [{ name: "script", description: "JavaScript expression to evaluate in the page" }],
  execute: async (args) => {
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

export default BrowserExecuteJs;
