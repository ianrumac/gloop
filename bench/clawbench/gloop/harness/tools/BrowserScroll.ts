import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, pageHeader, refLocator } from "/opt/gloop-harness/lib/browser.ts";

const BrowserScroll: ToolDefinition = {
  name: "BrowserScroll",
  description:
    "Scroll the page. Either give a direction (down|up|left|right, default down) with an optional pixel amount (default 700), or a ref to scroll that element into view.",
  arguments: [
    { name: "direction", description: "down | up | left | right (default down)" },
    { name: "amount", description: "Pixels to scroll (default 700)" },
    { name: "ref", description: "Optional element ref to scroll into view instead" },
  ],
  execute: async (args) => {
    const page = await getPage();
    if (args.ref) {
      await refLocator(page, args.ref).scrollIntoViewIfNeeded();
      return `Scrolled ${args.ref} into view.\n${await pageHeader(page)}`;
    }
    const dir = (args.direction ?? "down").toLowerCase();
    const amt = Number.parseInt(args.amount ?? "", 10);
    const px = Number.isFinite(amt) && amt > 0 ? amt : 700;
    const [dx, dy] =
      dir === "up" ? [0, -px] : dir === "left" ? [-px, 0] : dir === "right" ? [px, 0] : [0, px];
    await page.mouse.wheel(dx, dy);
    await page.waitForTimeout(400);
    const pos = await page.evaluate(() => `${Math.round(window.scrollY)}/${Math.round(document.documentElement.scrollHeight - window.innerHeight)}`).catch(() => "?");
    return `Scrolled ${dir} ${px}px (scrollY ${pos}).\n${await pageHeader(page)}`;
  },
};

export default BrowserScroll;
