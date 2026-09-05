import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, pageHeader, settle } from "/opt/gloop-harness/lib/browser.ts";

const BrowserNavigate: ToolDefinition = {
  name: "BrowserNavigate",
  description:
    "Navigate the active browser tab. Pass a URL (https:// is added if missing) or one of: back, forward, reload. Returns the resulting url/title; call BrowserSnapshot next to see the page.",
  arguments: [{ name: "url", description: "URL to open, or 'back' | 'forward' | 'reload'" }],
  execute: async (args) => {
    const page = await getPage();
    const target = (args.url ?? "").trim();
    if (!target) throw new Error("url is required");
    const lower = target.toLowerCase();
    if (lower === "back") await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
    else if (lower === "forward") await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
    else if (lower === "reload") await page.reload({ waitUntil: "domcontentloaded" });
    else {
      const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`;
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    await settle(page);
    return `Navigated.\n${await pageHeader(page)}`;
  },
};

export default BrowserNavigate;
