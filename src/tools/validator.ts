// Re-export from the gloop-loop library
export { requiresConfirmation } from "@anthropic/gloop-loop";

/**
 * Prompt the user for y/n confirmation via stdin.
 * Returns true if the user approves.
 * (gloop-specific — not in the library since it uses browser prompt())
 */
export function promptConfirmation(description: string): boolean {
  const answer = prompt(
    `\n  [!] Dangerous command detected: ${description}\n  Allow execution? (y/n) >`
  );
  return answer?.trim().toLowerCase() === "y";
}
