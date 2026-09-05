import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserHover: ToolDefinition = {
  name: "BrowserHover",
  description: "Move the mouse over an element (by snapshot ref) to reveal hover menus or tooltips.",
  arguments: [{ name: "ref", description: "Element ref from BrowserSnapshot" }],
  execute: (args) => callDaemon("BrowserHover", args),
};

export default BrowserHover;
