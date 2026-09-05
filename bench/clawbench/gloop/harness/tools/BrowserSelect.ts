import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserSelect: ToolDefinition = {
  name: "BrowserSelect",
  description:
    "Choose an option in a <select> dropdown by its snapshot ref. Matches the option's visible text first, then its value. For custom (non-<select>) dropdowns use BrowserClick on the option instead.",
  arguments: [
    { name: "ref", description: "Element ref of the <select> from BrowserSnapshot" },
    { name: "option", description: "Option text (or value) to select" },
  ],
  execute: (args) => callDaemon("BrowserSelect", args),
};

export default BrowserSelect;
