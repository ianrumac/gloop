import { test, expect, describe } from "bun:test";
import { requiresConfirmation } from "../src/tools/validator.js";
import type { ToolCall } from "../src/tools/types.js";

describe("requiresConfirmation", () => {
  test("returns null for non-Bash tools", () => {
    const call: ToolCall = { name: "ReadFile", args: { path: "./foo.ts" } };
    expect(requiresConfirmation(call)).toBeNull();
  });

  test("returns null for safe Bash commands", () => {
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "ls -la" } })
    ).toBeNull();
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "cat README.md" } })
    ).toBeNull();
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "echo hello" } })
    ).toBeNull();
  });

  test("flags rm commands", () => {
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "rm foo.txt" } })
    ).not.toBeNull();
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "rm -rf /tmp/stuff" } })
    ).not.toBeNull();
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "rm -fr /tmp/stuff" } })
    ).not.toBeNull();
  });

  test("flags rmdir commands", () => {
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "rmdir mydir" } })
    ).not.toBeNull();
  });

  test("does not flag words containing rm", () => {
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "echo inform" } })
    ).toBeNull();
  });

  test("returns the command string when dangerous", () => {
    const result = requiresConfirmation({ name: "Bash", args: { command: "rm -rf /tmp" } });
    expect(result).toBe("rm -rf /tmp");
  });

  test("handles missing command arg", () => {
    expect(
      requiresConfirmation({ name: "Bash", args: {} })
    ).toBeNull();
  });

  test("rm in a pipe still flags", () => {
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "find . | xargs rm -f" } })
    ).not.toBeNull();
  });

  test("rm at end of command", () => {
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "sudo rm file.txt" } })
    ).not.toBeNull();
  });

  test("rmdir with path", () => {
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "rmdir -p a/b/c" } })
    ).not.toBeNull();
  });

  test("git rm is flagged (contains word rm)", () => {
    // git rm contains \brm\b so it triggers
    expect(
      requiresConfirmation({ name: "Bash", args: { command: "git rm file.txt" } })
    ).not.toBeNull();
  });
});
