import { test, expect, describe } from "bun:test";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { ToolDefinition } from "../src/tools/types.ts";

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

  describe("toJsonTools", () => {
    test("converts tools to JSON format", () => {
      const registry = new ToolRegistry();
      registry.register(makeTool("ReadFile", ["path"]));
      const jsonTools = registry.toJsonTools();

      expect(jsonTools).toHaveLength(1);
      expect(jsonTools[0].type).toBe("function");
      expect(jsonTools[0].function.name).toBe("ReadFile");
      expect(jsonTools[0].function.description).toBe("ReadFile tool");
      expect(jsonTools[0].function.parameters.type).toBe("object");
      expect(jsonTools[0].function.parameters.properties.path.type).toBe("string");
      expect(jsonTools[0].function.parameters.required).toEqual(["path"]);
    });

    test("tool with no arguments has empty properties", () => {
      const registry = new ToolRegistry();
      registry.register(makeTool("Reload"));
      const jsonTools = registry.toJsonTools();

      expect(jsonTools).toHaveLength(1);
      expect(jsonTools[0].function.parameters.properties).toEqual({});
      expect(jsonTools[0].function.parameters.required).toBeUndefined();
    });

    test("multiple tools", () => {
      const registry = new ToolRegistry();
      registry.register(makeTool("A"));
      registry.register(makeTool("B", ["x"]));
      const jsonTools = registry.toJsonTools();

      expect(jsonTools).toHaveLength(2);
      expect(jsonTools[0].function.name).toBe("A");
      expect(jsonTools[1].function.name).toBe("B");
    });

    test("empty registry returns empty array", () => {
      const registry = new ToolRegistry();
      expect(registry.toJsonTools()).toEqual([]);
    });

    test("tool with multiple arguments", () => {
      const registry = new ToolRegistry();
      registry.register(makeTool("WriteFile", ["path", "content"]));
      const jsonTools = registry.toJsonTools();

      expect(jsonTools[0].function.parameters.properties).toHaveProperty("path");
      expect(jsonTools[0].function.parameters.properties).toHaveProperty("content");
      expect(jsonTools[0].function.parameters.required).toEqual(["path", "content"]);
    });
  });
});
