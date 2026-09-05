import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserNavigate: ToolDefinition = {
  name: "BrowserNavigate",
  description:
    "Navigate the active browser tab. Pass a URL (https:// is added if missing) or one of: back, forward, reload. Returns the resulting url/title; call BrowserSnapshot next to see the page.",
  arguments: [{ name: "url", description: "URL to open, or 'back' | 'forward' | 'reload'" }],
  execute: (args) => callDaemon("BrowserNavigate", args),
};

export default BrowserNavigate;
