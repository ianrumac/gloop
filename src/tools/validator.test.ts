import { test, expect, describe } from "bun:test";
import { requiresConfirmation } from "./validator.ts";
import type { ToolCall } from "./types.ts";

describe("requiresConfirmation", () => {
  test("returns null for non-Bash tools", () => {
    const call: ToolCall = { name: "ReadFile", rawArgs: ["./foo.ts"] };
    expect(requiresConfirmation(call)).toBeNull();
  });

  test("returns null for safe Bash commands", () => {
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["ls -la"] })
    ).toBeNull();
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["cat README.md"] })
    ).toBeNull();
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["echo hello"] })
    ).toBeNull();
  });

  test("flags rm commands", () => {
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["rm foo.txt"] })
    ).not.toBeNull();
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["rm -rf /tmp/stuff"] })
    ).not.toBeNull();
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["rm -fr /tmp/stuff"] })
    ).not.toBeNull();
  });

  test("flags rmdir commands", () => {
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["rmdir mydir"] })
    ).not.toBeNull();
  });

  test("does not flag words containing rm", () => {
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["echo inform"] })
    ).toBeNull();
  });

  test("returns the command string when dangerous", () => {
    const result = requiresConfirmation({ name: "Bash", rawArgs: ["rm -rf /tmp"] });
    expect(result).toBe("rm -rf /tmp");
  });

  test("handles empty rawArgs", () => {
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: [] })
    ).toBeNull();
  });

  test("rm in a pipe still flags", () => {
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["find . | xargs rm -f"] })
    ).not.toBeNull();
  });

  test("rm at end of command", () => {
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["sudo rm file.txt"] })
    ).not.toBeNull();
  });

  test("rmdir with path", () => {
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["rmdir -p a/b/c"] })
    ).not.toBeNull();
  });

  test("git rm is flagged (contains word rm)", () => {
    // git rm contains \brm\b so it triggers
    expect(
      requiresConfirmation({ name: "Bash", rawArgs: ["git rm file.txt"] })
    ).not.toBeNull();
  });
});
