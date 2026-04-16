import { describe, expect, test } from "bun:test";
import {
  applySkillSubstitutions,
  createInvokeSkillTool,
  formatSkillsListing,
  mergeSkillsIntoSystem,
  parseSkillMarkdown,
  splitSkillArguments,
  thinkInputFromSkillSubcommand,
} from "../src/skills.ts";

describe("parseSkillMarkdown", () => {
  test("parses frontmatter and body", () => {
    const md = `---
name: my-skill
description: Does a thing
---

Hello **world**.
`;
    const p = parseSkillMarkdown(md, "dir-name");
    expect(p.name).toBe("my-skill");
    expect(p.description).toBe("Does a thing");
    expect(p.body).toContain("Hello **world**");
  });

  test("falls back to directory name and first paragraph", () => {
    const md = `First line of help.

More text.
`;
    const p = parseSkillMarkdown(md, "fallback-name");
    expect(p.name).toBe("fallback-name");
    expect(p.description).toContain("First line");
  });
});

describe("thinkInputFromSkillSubcommand", () => {
  test("resolves name and args", () => {
    const skills = [
      { name: "a", description: "d", dir: "/x", body: "Do $0" },
    ];
    expect(thinkInputFromSkillSubcommand("a hello", skills)).toBe("Do hello");
  });

  test("null when unknown", () => {
    expect(thinkInputFromSkillSubcommand("nope", [{ name: "x", description: "", dir: "", body: "" }])).toBeNull();
  });
});

describe("formatSkillsListing", () => {
  test("empty skills", () => {
    expect(formatSkillsListing(undefined)).toContain("No skills");
  });

  test("lists names", () => {
    expect(
      formatSkillsListing([{ name: "a", description: "da", dir: "/a", body: "b" }]),
    ).toContain("/a");
  });
});

describe("mergeSkillsIntoSystem", () => {
  test("empty skills returns base", () => {
    expect(mergeSkillsIntoSystem("base", [])).toBe("base");
  });

  test("appends listing", () => {
    const s = mergeSkillsIntoSystem("base", [
      { name: "a", description: "da", dir: "/a", body: "b" },
    ]);
    expect(s).toContain("base");
    expect(s).toContain("AVAILABLE SKILLS");
    expect(s).toContain("/a");
    expect(s).toContain("da");
  });
});

describe("createInvokeSkillTool", () => {
  test("returns null when no skills", () => {
    expect(createInvokeSkillTool([])).toBeNull();
  });

  test("execute returns rendered body", async () => {
    const tool = createInvokeSkillTool([
      { name: "x", description: "d", dir: "/a", body: "Do $ARGUMENTS" },
    ]);
    expect(tool).not.toBeNull();
    const out = await tool!.execute({ name: "x", arguments: "thing" });
    expect(out).toBe("Do thing");
  });

  test("execute errors for unknown name", async () => {
    const tool = createInvokeSkillTool([
      { name: "only", description: "d", dir: "/a", body: "b" },
    ])!;
    const out = await tool.execute({ name: "nope", arguments: "" });
    expect(out).toContain("Unknown skill");
  });
});

describe("applySkillSubstitutions", () => {
  test("replaces $ARGUMENTS", () => {
    expect(applySkillSubstitutions("Run $ARGUMENTS", "x y")).toBe("Run x y");
  });

  test("replaces $0", () => {
    expect(applySkillSubstitutions("Fix $0", "issue-1")).toBe("Fix issue-1");
  });

  test("splitSkillArguments respects quotes", () => {
    expect(splitSkillArguments(`"hello world" second`)).toEqual(["hello world", "second"]);
  });
});
