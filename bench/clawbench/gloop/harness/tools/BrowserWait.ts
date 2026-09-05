import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserWait: ToolDefinition = {
  name: "BrowserWait",
  description:
    "Wait for the page to finish loading, for a number of seconds (max 30), and/or until some text appears on the page. Use after actions that trigger slow updates.",
  arguments: [
    { name: "seconds", description: "Optional seconds to wait (default 2, max 30)" },
    { name: "text", description: "Optional text to wait for on the page" },
  ],
  execute: (args) => callDaemon("BrowserWait", args),
};

export default BrowserWait;
