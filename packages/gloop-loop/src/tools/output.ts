/**
 * Tool output capping — one policy for every tool, applied by the
 * interpreter at the tool boundary (see `LoopConfig.maxToolOutputChars`).
 */

/** Default cap on a tool result as the model sees it, in characters. */
export const DEFAULT_MAX_TOOL_OUTPUT_CHARS = 50_000;

/**
 * Cap `text` at `max` characters, keeping the head and the tail (errors and
 * summaries tend to sit at the end of command output) with a marker in the
 * middle saying how much was dropped.  `max <= 0` (or a non-finite value)
 * returns `text` unchanged.
 */
export function truncateOutput(text: string, max: number): string {
  if (!(max > 0) || !Number.isFinite(max) || text.length <= max) return text;
  const head = Math.ceil(max / 2);
  const tail = max - head;
  const omitted = text.length - max;
  return (
    text.slice(0, head) +
    `\n… [${omitted} characters omitted — output capped at ${max}; narrow the command or read a range] …\n` +
    (tail > 0 ? text.slice(text.length - tail) : "")
  );
}
