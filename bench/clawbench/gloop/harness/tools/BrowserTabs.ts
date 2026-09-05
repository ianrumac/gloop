import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { callDaemon } from "/opt/gloop-harness/lib/client.ts";

const BrowserTabs: ToolDefinition = {
  name: "BrowserTabs",
  description:
    "Manage browser tabs. action=list shows open tabs with their index; switch (index) makes one active; new (optional url) opens a tab; close (optional index, default active) closes one.",
  arguments: [
    { name: "action", description: "list | switch | new | close (default list)" },
    { name: "index", description: "Tab index for switch/close (from list)" },
    { name: "url", description: "URL for new" },
  ],
  execute: (args) => callDaemon("BrowserTabs", args),
};

export default BrowserTabs;
