import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, pageHeader, refLocator, settle } from "/opt/gloop-harness/lib/browser.ts";

const BrowserType: ToolDefinition = {
  name: "BrowserType",
  description:
    "Type text into an input, textarea, contenteditable or combobox identified by its snapshot ref. Replaces the existing value. Set submit='true' to press Enter afterwards, slowly='true' to type key-by-key (for autocomplete/search boxes).",
  arguments: [
    { name: "ref", description: "Element ref from BrowserSnapshot" },
    { name: "text", description: "Text to enter" },
    { name: "submit", description: "Optional: 'true' to press Enter after typing" },
    { name: "slowly", description: "Optional: 'true' to type character by character" },
  ],
  execute: async (args) => {
    const page = await getPage();
    if (!args.ref) throw new Error("ref is required");
    const text = args.text ?? "";
    const loc = refLocator(page, args.ref);
    const slowly = (args.slowly ?? "").toLowerCase() === "true";
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => null);
    if (slowly) {
      await loc.click();
      await page.keyboard.press("ControlOrMeta+A").catch(() => null);
      await page.keyboard.press("Backspace").catch(() => null);
      await loc.pressSequentially(text, { delay: 40 });
    } else {
      try {
        await loc.fill(text);
      } catch {
        await loc.click();
        await page.keyboard.press("ControlOrMeta+A").catch(() => null);
        await page.keyboard.type(text);
      }
    }
    if ((args.submit ?? "").toLowerCase() === "true") {
      await loc.press("Enter").catch(() => page.keyboard.press("Enter"));
      await settle(page);
    }
    return `Typed into ${args.ref}.\n${await pageHeader(await getPage())}`;
  },
};

export default BrowserType;
