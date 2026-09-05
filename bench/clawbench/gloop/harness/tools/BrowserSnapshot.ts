import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserSnapshot: ToolDefinition = {
  name: "BrowserSnapshot",
  description:
    "Describe the current page: url, title, headings and every visible interactive element with a ref (e.g. e12, or f2e12 inside an iframe) plus its role, label and state. Use the refs with BrowserClick / BrowserType / BrowserSelect / BrowserHover. Take a fresh snapshot after anything that changes the page.",
  arguments: [
    { name: "maxItems", description: "Optional cap on listed elements (default 250)" },
  ],
  execute: (args) => callDaemon("BrowserSnapshot", args),
};

export default BrowserSnapshot;
