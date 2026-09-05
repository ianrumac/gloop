import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getContext, getPage, listPages, pageHeader, setActivePage, settle } from "/opt/gloop-harness/lib/browser.ts";

const BrowserTabs: ToolDefinition = {
  name: "BrowserTabs",
  description:
    "Manage browser tabs. action=list shows open tabs with their index; switch (index) makes one active; new (optional url) opens a tab; close (optional index, default active) closes one.",
  arguments: [
    { name: "action", description: "list | switch | new | close (default list)" },
    { name: "index", description: "Tab index for switch/close (from list)" },
    { name: "url", description: "URL for new" },
  ],
  execute: async (args) => {
    const action = (args.action ?? "list").toLowerCase();
    const pages = await listPages();
    const active = await getPage();
    const describe = async () => {
      const lines: string[] = [];
      for (const [i, p] of (await listPages()).entries()) {
        const title = await p.title().catch(() => "");
        lines.push(`${p === (await getPage()) ? "*" : " "} [${i}] ${title || "(untitled)"} — ${p.url()}`);
      }
      return lines.join("\n");
    };
    if (action === "list") return `tabs:\n${await describe()}`;
    if (action === "switch") {
      const i = Number.parseInt(args.index ?? "", 10);
      const target = pages[i];
      if (!target) throw new Error(`No tab with index ${args.index}. Tabs:\n${await describe()}`);
      setActivePage(target);
      await target.bringToFront().catch(() => null);
      return `Switched to tab ${i}.\n${await pageHeader(target)}`;
    }
    if (action === "new") {
      const ctx = await getContext();
      const page = await ctx.newPage();
      setActivePage(page);
      if (args.url) {
        const url = /^[a-z][a-z0-9+.-]*:/i.test(args.url) ? args.url : `https://${args.url}`;
        await page.goto(url, { waitUntil: "domcontentloaded" });
        await settle(page);
      }
      return `Opened new tab.\n${await pageHeader(page)}`;
    }
    if (action === "close") {
      const i = args.index ? Number.parseInt(args.index, 10) : pages.indexOf(active);
      const target = pages[i];
      if (!target) throw new Error(`No tab with index ${args.index}.`);
      await target.close();
      const remaining = await listPages();
      if (remaining.length) setActivePage(remaining[remaining.length - 1]!);
      return `Closed tab ${i}.\ntabs:\n${await describe()}`;
    }
    throw new Error(`Unknown action "${args.action}". Use list | switch | new | close.`);
  },
};

export default BrowserTabs;
