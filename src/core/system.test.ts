import { test, expect, describe } from "bun:test";
import { buildSystemPrompt } from "./system.ts";

describe("buildSystemPrompt", () => {
  test("includes cwd and date", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain(process.cwd());
    expect(prompt).toContain("Date is");
  });

  test("includes tool calling instructions", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("TOOL CALLING");
    expect(prompt).toContain("function calls");
  });

  test("includes WriteFile usage instructions", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("WriteFile");
    expect(prompt).toContain("COMPLETE, LITERAL file content");
  });

  test("clone mode includes self-modification section", async () => {
    const prompt = await buildSystemPrompt({ clone: true });
    expect(prompt).toContain("SELF-MODIFICATION");
    expect(prompt).toContain(".gloop/src/");
    expect(prompt).toContain("Reboot");
  });

  test("non-clone mode excludes self-modification section", async () => {
    const prompt = await buildSystemPrompt({ clone: false });
    expect(prompt).not.toContain("SELF-MODIFICATION");
  });

  test("includes context management section", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("CONTEXT MANAGEMENT");
    expect(prompt).toContain("ManageContext");
  });

  test("includes custom tools creation guide", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("CREATING CUSTOM TOOLS");
    expect(prompt).toContain(".gloop/tools/");
  });

  test("includes memory system instructions", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("Remember");
    expect(prompt).toContain("Forget");
    expect(prompt).toContain("MEMORY USAGE");
  });

  test("never mentions a Reload-or-Restart tool; Reboot only with --clone", async () => {
    const plain = await buildSystemPrompt();
    expect(plain).not.toContain("Restart to load");
    expect(plain).not.toContain("call Reboot");
    expect(await buildSystemPrompt({ clone: true })).toContain("call Reboot");
  });

  test("custom-tool example imports types from where gloop is installed", async () => {
    const prompt = await buildSystemPrompt();
    const path = /import type \{ ToolDefinition \} from "([^"]+)"/.exec(prompt)?.[1];
    expect(path).toBeDefined();
    expect(await Bun.file(path!).exists()).toBe(true);
    expect(prompt).toContain("ctx.signal");
  });

  test("tells the model about the tool output cap", async () => {
    expect(await buildSystemPrompt({ maxToolOutput: 50_000 })).toContain("longer than 50,000 characters");
    expect(await buildSystemPrompt({ maxToolOutput: 0 })).not.toContain("characters are cut");
  });
});
