import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, pageHeader, settle } from "/opt/gloop-harness/lib/browser.ts";

const BrowserPressKey: ToolDefinition = {
  name: "BrowserPressKey",
  description:
    "Press a keyboard key in the active tab, e.g. Enter, Escape, Tab, ArrowDown, PageDown, Backspace, or a chord like Control+A.",
  arguments: [{ name: "key", description: "Key name or chord (Playwright syntax)" }],
  execute: async (args) => {
    const page = await getPage();
    if (!args.key) throw new Error("key is required");
    await page.keyboard.press(args.key);
    await settle(page, 800);
    return `Pressed ${args.key}.\n${await pageHeader(page)}`;
  },
};

export default BrowserPressKey;
