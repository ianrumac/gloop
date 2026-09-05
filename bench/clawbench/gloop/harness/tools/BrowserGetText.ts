import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserGetText: ToolDefinition = {
  name: "BrowserGetText",
  description:
    "Read the visible text of the page (or of one element by CSS selector / snapshot ref). Use it to read prices, descriptions, confirmation numbers, error messages. Output is trimmed to maxChars (default 6000).",
  arguments: [
    { name: "selector", description: "Optional CSS selector or snapshot ref (e.g. e12); default: whole page" },
    { name: "maxChars", description: "Optional character cap (default 6000)" },
  ],
  execute: (args) => callDaemon("BrowserGetText", args),
};

export default BrowserGetText;
