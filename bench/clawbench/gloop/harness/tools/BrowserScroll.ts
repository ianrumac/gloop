import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserScroll: ToolDefinition = {
  name: "BrowserScroll",
  description:
    "Scroll the page. Either give a direction (down|up|left|right, default down) with an optional pixel amount (default 700), or a ref to scroll that element into view.",
  arguments: [
    { name: "direction", description: "down | up | left | right (default down)" },
    { name: "amount", description: "Pixels to scroll (default 700)" },
    { name: "ref", description: "Optional element ref to scroll into view instead" },
  ],
  execute: (args) => callDaemon("BrowserScroll", args),
};

export default BrowserScroll;
