import { test, expect, describe } from "bun:test";
import { buildSystemPrompt } from "./system.ts";
import { ToolRegistry } from "../tools/registry.ts";

describe("buildSystemPrompt", () => {
  test("includes tool definitions", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "TestTool",
      description: "A test tool",
      arguments: [{ name: "input", description: "the input" }],
      execute: async () => "ok",
    });

    const prompt = await buildSystemPrompt(registry);
    expect(prompt).toContain("TestTool");
    expect(prompt).toContain("A test tool");
    expect(prompt).toContain("the input");
  });

  test("includes cwd and date", async () => {
    const registry = new ToolRegistry();
    const prompt = await buildSystemPrompt(registry);
    expect(prompt).toContain(process.cwd());
    expect(prompt).toContain("Date is");
  });

  test("includes tool usage instructions", async () => {
    const registry = new ToolRegistry();
    const prompt = await buildSystemPrompt(registry);
    expect(prompt).toContain("<tools>");
    expect(prompt).toContain("TOOL AND MEMORY USAGE");
    expect(prompt).toContain("WriteFile");
  });

  test("clone mode includes self-modification section", async () => {
    const registry = new ToolRegistry();
    const prompt = await buildSystemPrompt(registry, { clone: true });
    expect(prompt).toContain("SELF-MODIFICATION");
    expect(prompt).toContain(".gloop/src/");
    expect(prompt).toContain("Reboot");
  });

  test("non-clone mode excludes self-modification section", async () => {
    const registry = new ToolRegistry();
    const prompt = await buildSystemPrompt(registry, { clone: false });
    expect(prompt).not.toContain("SELF-MODIFICATION");
  });

  test("includes context management section", async () => {
    const registry = new ToolRegistry();
    const prompt = await buildSystemPrompt(registry);
    expect(prompt).toContain("CONTEXT MANAGEMENT");
    expect(prompt).toContain("ManageContext");
  });

  test("includes custom tools creation guide", async () => {
    const registry = new ToolRegistry();
    const prompt = await buildSystemPrompt(registry);
    expect(prompt).toContain("CREATING CUSTOM TOOLS");
    expect(prompt).toContain(".gloop/tools/");
  });

  test("includes memory system instructions", async () => {
    const registry = new ToolRegistry();
    const prompt = await buildSystemPrompt(registry);
    expect(prompt).toContain("<remember>");
    expect(prompt).toContain("<forget>");
  });

  test("multiple tools generate correct block", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "ToolA",
      description: "First",
      arguments: [],
      execute: async () => "ok",
    });
    registry.register({
      name: "ToolB",
      description: "Second",
      arguments: [{ name: "x", description: "x val" }],
      execute: async () => "ok",
    });

    const prompt = await buildSystemPrompt(registry);
    expect(prompt).toContain('name = "ToolA"');
    expect(prompt).toContain('name = "ToolB"');
  });
});
