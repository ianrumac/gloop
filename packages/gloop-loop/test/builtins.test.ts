import { describe, it, expect, beforeEach } from "bun:test";
import { ToolRegistry, registerBuiltins, formatShellResult, type BuiltinIO, type ShellResult } from "../src/index.js";

// ---------------------------------------------------------------------------
// Mock IO
// ---------------------------------------------------------------------------

function mockIO(overrides: Partial<BuiltinIO> = {}): BuiltinIO {
  const files = new Map<string, string>();
  return {
    readFile: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`File not found: ${path}`);
      return content;
    },
    fileExists: async (path) => files.has(path),
    writeFile: async (path, content) => { files.set(path, content); },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("registerBuiltins", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerBuiltins(registry, mockIO());
  });

  it("registers all default tools", () => {
    const names = registry.names();
    expect(names).toContain("ReadFile");
    expect(names).toContain("WriteFile");
    expect(names).toContain("Patch_file");
    expect(names).toContain("Bash");
    expect(names).toContain("CompleteTask");
    expect(names).toContain("AskUser");
    expect(names).toContain("Remember");
    expect(names).toContain("Forget");
    expect(names).toContain("ManageContext");
  });

});

describe("ReadFile tool", () => {
  it("reads an existing file", async () => {
    const registry = new ToolRegistry();
    const io = mockIO();
    await io.writeFile("/test.txt", "hello world");
    registerBuiltins(registry, io);

    const result = await registry.get("ReadFile")!.execute({ path: "/test.txt" });
    expect(result).toBe("hello world");
  });

  it("throws on missing file", async () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, mockIO());

    await expect(
      registry.get("ReadFile")!.execute({ path: "/nope.txt" })
    ).rejects.toThrow("File not found");
  });
});

describe("WriteFile tool", () => {
  it("writes a file", async () => {
    const registry = new ToolRegistry();
    const io = mockIO();
    registerBuiltins(registry, io);

    const result = await registry.get("WriteFile")!.execute({
      path: "/out.txt",
      content: "new content",
    });
    expect(result).toContain("11 bytes");
    expect(await io.readFile("/out.txt")).toBe("new content");
  });

  it("refuses suspicious overwrites", async () => {
    const registry = new ToolRegistry();
    const io = mockIO();
    await io.writeFile("/big.ts", "x".repeat(300));
    registerBuiltins(registry, io);

    await expect(
      registry.get("WriteFile")!.execute({ path: "/big.ts", content: "Add a header" })
    ).rejects.toThrow("Refusing to overwrite");
  });
});

describe("Bash tool", () => {
  it("calls exec and formats result", async () => {
    const io = mockIO({
      exec: async (cmd) => ({
        stdout: `ran: ${cmd}`,
        stderr: "",
        exitCode: 0,
      }),
    });
    const registry = new ToolRegistry();
    registerBuiltins(registry, io);

    const result = await registry.get("Bash")!.execute({ command: "echo hi" });
    expect(result).toBe("ran: echo hi");
  });

  it("rejects invalid timeoutMs", async () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, mockIO());

    await expect(
      registry.get("Bash")!.execute({ command: "echo", timeoutMs: "abc" })
    ).rejects.toThrow("Invalid timeoutMs");
  });

  it("askPermission flags rm commands", () => {
    const registry = new ToolRegistry();
    registerBuiltins(registry, mockIO());
    const bash = registry.get("Bash")!;

    expect(bash.askPermission!({ command: "rm -rf /" })).toBeTruthy();
    expect(bash.askPermission!({ command: "echo hello" })).toBeNull();
  });
});

describe("simple tools", () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
    registerBuiltins(registry, mockIO());
  });

  it("CompleteTask returns summary", async () => {
    expect(await registry.get("CompleteTask")!.execute({ summary: "Done!" })).toBe("Done!");
  });

  it("AskUser returns question", async () => {
    expect(await registry.get("AskUser")!.execute({ question: "Why?" })).toBe("Why?");
  });

  it("Remember returns content", async () => {
    expect(await registry.get("Remember")!.execute({ content: "note" })).toBe("note");
  });

  it("Forget returns content", async () => {
    expect(await registry.get("Forget")!.execute({ content: "old note" })).toBe("old note");
  });

  it("ManageContext returns instructions", async () => {
    expect(await registry.get("ManageContext")!.execute({ instructions: "prune" })).toBe("prune");
  });
});

describe("formatShellResult", () => {
  it("formats stdout-only result", () => {
    expect(formatShellResult({ stdout: "hello\n", stderr: "", exitCode: 0 })).toBe("hello");
  });

  it("formats stderr with tag", () => {
    const r = formatShellResult({ stdout: "", stderr: "warn\n", exitCode: 0 });
    expect(r).toContain("[stderr]");
    expect(r).toContain("warn");
  });

  it("shows exit code on failure", () => {
    const r = formatShellResult({ stdout: "out", stderr: "", exitCode: 1 });
    expect(r).toContain("(exit code 1)");
  });

  it("shows timeout indicator", () => {
    const r = formatShellResult({ stdout: "", stderr: "", exitCode: 1, timedOut: true });
    expect(r).toContain("[command timed out]");
  });

  it("shows (no output) for empty success", () => {
    expect(formatShellResult({ stdout: "", stderr: "", exitCode: 0 })).toBe("(no output)");
  });
});
