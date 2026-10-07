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

describe("Patch_file tool", () => {
  const original = "a\nb\nc\n";
  const patchFor = (oldName: string, newName: string) =>
    `--- ${oldName}\n+++ ${newName}\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`;

  async function withFile(path: string) {
    const files = new Map<string, string>([[path, original]]);
    const io = mockIO({
      readFile: async (p) => { const c = files.get(p); if (c === undefined) throw new Error(`File not found: ${p}`); return c; },
      fileExists: async (p) => files.has(p),
      writeFile: async (p, c) => { files.set(p, c); },
    });
    const registry = new ToolRegistry();
    registerBuiltins(registry, io);
    return { files, patch: registry.get("Patch_file")! };
  }

  it("applies a plain relative path", async () => {
    const { files, patch } = await withFile("src/x.ts");
    await patch.execute({ patch: patchFor("src/x.ts", "src/x.ts") });
    expect(files.get("src/x.ts")).toBe("a\nB\nc\n");
  });

  it("applies git-style a/ b/ prefixes on a relative path", async () => {
    const { files, patch } = await withFile("src/x.ts");
    await patch.execute({ patch: patchFor("a/src/x.ts", "b/src/x.ts") });
    expect(files.get("src/x.ts")).toBe("a\nB\nc\n");
  });

  it("applies git-style prefixes on an ABSOLUTE path (a/home/u/x.ts → /home/u/x.ts)", async () => {
    const { files, patch } = await withFile("/home/u/x.ts");
    const result = await patch.execute({ patch: patchFor("a/home/u/x.ts", "b/home/u/x.ts") });
    expect(files.get("/home/u/x.ts")).toBe("a\nB\nc\n");
    expect(result).toContain("/home/u/x.ts");
  });

  it("prefers the path as written when both exist", async () => {
    const { files, patch } = await withFile("home/u/x.ts");
    files.set("/home/u/x.ts", original);
    await patch.execute({ patch: patchFor("a/home/u/x.ts", "b/home/u/x.ts") });
    expect(files.get("home/u/x.ts")).toBe("a\nB\nc\n");
    expect(files.get("/home/u/x.ts")).toBe(original);
  });

  it("says why it failed: missing file vs mismatched context", async () => {
    const { patch } = await withFile("/home/u/x.ts");
    await expect(patch.execute({ patch: patchFor("a/nope.ts", "b/nope.ts") })).rejects.toThrow(/file not found/);
    const wrong = `--- a/home/u/x.ts\n+++ b/home/u/x.ts\n@@ -1,3 +1,3 @@\n a\n-ZZZ\n+B\n c\n`;
    await expect(patch.execute({ patch: wrong })).rejects.toThrow(/context did not match/);
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
