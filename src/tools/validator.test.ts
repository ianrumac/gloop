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
});
