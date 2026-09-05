import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, pageHeader, settle } from "/opt/gloop-harness/lib/browser.ts";

const BrowserWait: ToolDefinition = {
  name: "BrowserWait",
  description:
    "Wait for the page to finish loading, for a number of seconds (max 30), and/or until some text appears on the page. Use after actions that trigger slow updates.",
  arguments: [
    { name: "seconds", description: "Optional seconds to wait (default 2, max 30)" },
    { name: "text", description: "Optional text to wait for on the page" },
  ],
  execute: async (args) => {
    const page = await getPage();
    const secs = Math.min(30, Math.max(0, Number.parseFloat(args.seconds ?? "") || 2));
    await settle(page, 2_000);
    let note = "";
    if (args.text) {
      try {
        await page.getByText(args.text, { exact: false }).first().waitFor({ state: "visible", timeout: Math.max(1, secs) * 1000 });
        note = `Text "${args.text}" is visible.`;
      } catch {
        note = `Text "${args.text}" did not appear within ${secs}s.`;
      }
    } else {
      await page.waitForTimeout(secs * 1000);
      note = `Waited ${secs}s.`;
    }
    return `${note}\n${await pageHeader(page)}`;
  },
};

export default BrowserWait;
