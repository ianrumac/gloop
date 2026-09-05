import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserType: ToolDefinition = {
  name: "BrowserType",
  description:
    "Type text into an input, textarea, contenteditable or combobox identified by its snapshot ref. Replaces the existing value. Set submit='true' to press Enter afterwards, slowly='true' to type key-by-key (for autocomplete/search boxes).",
  arguments: [
    { name: "ref", description: "Element ref from BrowserSnapshot" },
    { name: "text", description: "Text to enter" },
    { name: "submit", description: "Optional: 'true' to press Enter after typing" },
    { name: "slowly", description: "Optional: 'true' to type character by character" },
  ],
  execute: (args) => callDaemon("BrowserType", args),
};

export default BrowserType;
