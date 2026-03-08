import { test, expect, describe } from "bun:test";
import { ToolRegistry } from "./registry.ts";
import type { ToolDefinition } from "./types.ts";

function makeTool(name: string, args: string[] = []): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    arguments: args.map(a => ({ name: a, description: `${a} arg` })),
    execute: async () => "ok",
  };
}

describe("ToolRegistry", () => {
  test("register and get a tool", () => {
    const registry = new ToolRegistry();
    const tool = makeTool("MyTool");
    registry.register(tool);
    expect(registry.get("MyTool")).toBe(tool);
  });

  test("get returns undefined for unregistered tool", () => {
    const registry = new ToolRegistry();
    expect(registry.get("NonExistent")).toBeUndefined();
  });

  test("has returns true for registered tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("X"));
    expect(registry.has("X")).toBe(true);
    expect(registry.has("Y")).toBe(false);
  });

  test("unregister removes a tool", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("X"));
    expect(registry.unregister("X")).toBe(true);
    expect(registry.has("X")).toBe(false);
  });

  test("unregister returns false for non-existent tool", () => {
    const registry = new ToolRegistry();
    expect(registry.unregister("X")).toBe(false);
  });

  test("getAll returns all registered tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("A"));
    registry.register(makeTool("B"));
    registry.register(makeTool("C"));
    expect(registry.getAll()).toHaveLength(3);
  });

  test("names returns tool names", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("A"));
    registry.register(makeTool("B"));
    expect(registry.names()).toEqual(["A", "B"]);
  });

  test("clear removes all tools", () => {
    const registry = new ToolRegistry();
    registry.register(makeTool("A"));
    registry.register(makeTool("B"));
    registry.clear();
    expect(registry.getAll()).toHaveLength(0);
    expect(registry.names()).toEqual([]);
  });

  test("register overwrites existing tool with same name", () => {
    const registry = new ToolRegistry();
    const tool1 = makeTool("X");
    const tool2 = { ...makeTool("X"), description: "updated" };
    registry.register(tool1);
    registry.register(tool2);
    expect(registry.get("X")!.description).toBe("updated");
    expect(registry.getAll()).toHaveLength(1);
  });

  describe("toDefinitionBlock", () => {
    test("generates XML for tools with no arguments", () => {
      const registry = new ToolRegistry();
      registry.register(makeTool("Reload"));
      const block = registry.toDefinitionBlock();
      expect(block).toContain("<tools>");
      expect(block).toContain("</tools>");
      expect(block).toContain('name = "Reload"');
      expect(block).toContain('description = "Reload tool"');
    });

    test("generates XML with arguments", () => {
      const registry = new ToolRegistry();
      registry.register(makeTool("ReadFile", ["path"]));
      const block = registry.toDefinitionBlock();
      expect(block).toContain("arguments");
      expect(block).toContain('"path"');
      expect(block).toContain('"path arg"');
    });

    test("generates XML for multiple tools", () => {
      const registry = new ToolRegistry();
      registry.register(makeTool("A"));
      registry.register(makeTool("B"));
      const block = registry.toDefinitionBlock();
      expect(block).toContain('name = "A"');
      expect(block).toContain('name = "B"');
    });

    test("empty registry generates valid XML", () => {
      const registry = new ToolRegistry();
      const block = registry.toDefinitionBlock();
      expect(block).toBe("<tools>\n\n</tools>");
    });

    test("tool with multiple arguments generates correct JSON", () => {
      const registry = new ToolRegistry();
      registry.register(makeTool("WriteFile", ["path", "content"]));
      const block = registry.toDefinitionBlock();
      // Verify the JSON args object
      expect(block).toContain('"path":"path arg"');
      expect(block).toContain('"content":"content arg"');
    });
  });
});
