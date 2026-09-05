import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserClick: ToolDefinition = {
  name: "BrowserClick",
  description:
    "Click an element by its snapshot ref (e.g. e12). Handles scrolling into view and stubborn overlays; new tabs opened by the click become the active tab. Returns the resulting url/title.",
  arguments: [
    { name: "ref", description: "Element ref from BrowserSnapshot" },
    { name: "double", description: "Optional: 'true' for a double-click" },
  ],
  execute: (args) => callDaemon("BrowserClick", args),
};

export default BrowserClick;
