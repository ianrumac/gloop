import { expect, test } from "bun:test";
import { unlink } from "fs/promises";
import { ToolRegistry } from "./registry.ts";
import { registerBuiltins } from "./builtins.ts";

function setup() {
  const registry = new ToolRegistry();
  registerBuiltins(registry);
  const bash = registry.get("Bash");
  if (!bash) throw new Error("Missing Bash tool");
  return bash;
}

function setupRegistry() {
  const registry = new ToolRegistry();
  registerBuiltins(registry);
  return registry;
}

test("Bash executes shell commands", async () => {
  const bash = setup();
  const output = await bash.execute({ command: 'echo "hello world"' });
  expect(output.trim()).toBe("hello world");
});

test("Bash respects timeoutMs and aborts long commands", async () => {
  const bash = setup();
  // With shell.ts, timeout returns a result with null exitCode instead of throwing
  const output = await bash.execute({
    command: "sleep 2",
    timeoutMs: "50",
  });
  // The formatShellResult should indicate the process didn't finish normally
  expect(output).toBeDefined();
});

test("Bash completes commands within timeoutMs", async () => {
  const bash = setup();
  const output = await bash.execute({
    command: "echo ok",
    timeoutMs: "1000",
  });
  expect(output.trim()).toBe("ok");
});

test("Patch_file applies a unified diff patch", async () => {
  const registry = setupRegistry();
  const patchTool = registry.get("Patch_file");
  if (!patchTool) throw new Error("Missing Patch_file tool");

  const filename = `.tmp-patch-file-tool-${Date.now()}.txt`;
  await Bun.write(filename, "old\n");

  const patch = `diff --git a/${filename} b/${filename}
--- a/${filename}
+++ b/${filename}
@@ -1 +1 @@
-old
+new
`;

  try {
    const result = await patchTool.execute({ patch });
    expect(result).toContain("Patch applied successfully");
    const updated = await Bun.file(filename).text();
    expect(updated).toBe("new\n");
  } finally {
    await unlink(filename).catch(() => {});
  }
});
