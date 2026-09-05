import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserPressKey: ToolDefinition = {
  name: "BrowserPressKey",
  description:
    "Press a keyboard key in the active tab, e.g. Enter, Escape, Tab, ArrowDown, PageDown, Backspace, or a chord like Control+A.",
  arguments: [{ name: "key", description: "Key name or chord (Playwright syntax)" }],
  execute: (args) => callDaemon("BrowserPressKey", args),
};

export default BrowserPressKey;
