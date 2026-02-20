import type { ToolDefinition } from "./types.ts";

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

  /** Generate tool definitions in the XML format for the system prompt */
  toDefinitionBlock(): string {
    const lines: string[] = [];
    for (const tool of this.tools.values()) {
      const argsObj: Record<string, string> = {};
      for (const arg of tool.arguments) {
        argsObj[arg.name] = arg.description;
      }
      const argsJson = JSON.stringify(argsObj);
      lines.push(
        `<tool name = "${tool.name}" description = "${tool.description}"${tool.arguments.length ? `, arguments = ${argsJson}` : ""}>`
      );
    }
    return `<tools>\n${lines.join("\n")}\n</tools>`;
  }
}
