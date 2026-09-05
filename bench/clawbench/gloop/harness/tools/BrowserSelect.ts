import type { ToolDefinition } from "@hypen-space/gloop-loop";
import { getPage, pageHeader, refLocator, settle } from "/opt/gloop-harness/lib/browser.ts";

const BrowserSelect: ToolDefinition = {
  name: "BrowserSelect",
  description:
    "Choose an option in a <select> dropdown by its snapshot ref. Matches the option's visible text first, then its value. For custom (non-<select>) dropdowns use BrowserClick on the option instead.",
  arguments: [
    { name: "ref", description: "Element ref of the <select> from BrowserSnapshot" },
    { name: "option", description: "Option text (or value) to select" },
  ],
  execute: async (args) => {
    const page = await getPage();
    if (!args.ref) throw new Error("ref is required");
    if (!args.option) throw new Error("option is required");
    const loc = refLocator(page, args.ref);
    let picked: string[];
    try {
      picked = await loc.selectOption({ label: args.option });
    } catch {
      picked = await loc.selectOption({ value: args.option }).catch(() => loc.selectOption(args.option!));
    }
    await settle(page, 800);
    return `Selected ${JSON.stringify(picked)} in ${args.ref}.\n${await pageHeader(page)}`;
  },
};

export default BrowserSelect;
