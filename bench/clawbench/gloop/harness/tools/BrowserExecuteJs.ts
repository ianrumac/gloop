import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserExecuteJs: ToolDefinition = {
  name: "BrowserExecuteJs",
  description:
    "Run a JavaScript expression in the active page and return its JSON-serialised result (e.g. document.title, or an IIFE that inspects the DOM). Escape hatch for things the other Browser* tools cannot express.",
  arguments: [{ name: "script", description: "JavaScript expression to evaluate in the page" }],
  execute: (args) => callDaemon("BrowserExecuteJs", args),
};

export default BrowserExecuteJs;
