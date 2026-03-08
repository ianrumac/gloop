import type { ToolDefinition } from "./types.ts";
import type { JsonTool } from "../ai/types.ts";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  clear(): void {
    this.tools.clear();
  }

  /** Convert all tool definitions to JSON tool calling format (OpenAI-compatible) */
  toJsonTools(): JsonTool[] {
    return this.getAll().map((tool) => {
      const properties: Record<string, { type: string; description: string }> = {};
      const required: string[] = [];

      for (const arg of tool.arguments) {
        properties[arg.name] = {
          type: "string",
          description: arg.description,
        };
        required.push(arg.name);
      }

      return {
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: {
            type: "object" as const,
            properties,
            ...(required.length > 0 && { required }),
          },
        },
      };
    });
  }
}
