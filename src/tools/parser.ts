import type { ToolCall, ParsedResponse } from "./types.ts";

/**
 * Parse model response text for tool calls, remember/forget blocks.
 *
 * Handles:
 *  - <tools>...<tool>...</tool>...</tools>  — gloop XML format
 *  - <|tool_calls_section_begin|>...<|tool_calls_section_end|> — Kimi K2 format
 *  - <remember>...</remember>               — memory addition
 *  - <forget>...</forget>                   — memory removal
 */
export function parseResponse(text: string): ParsedResponse {
  const toolCalls: ToolCall[] = [];
  const remembers: string[] = [];
  const forgets: string[] = [];

  let remaining = text;

  // Parse gloop XML format: <tools>...</tools>
  remaining = remaining.replace(
    /<tools>([\s\S]*?)<\/?tools>/g,
    (_, content: string) => {
      parseInnerBlocks(content, toolCalls, remembers, forgets);
      return "";
    }
  );

  // Parse Kimi K2 format: <|tool_calls_section_begin|>...<|tool_calls_section_end|>
  remaining = remaining.replace(
    /<\|tool_calls_section_begin\|>([\s\S]*?)<\|tool_calls_section_end\|>/g,
    (_, content: string) => {
      parseKimiToolCalls(content, toolCalls);
      return "";
    }
  );

  // Top-level <remember> / <forget> (outside any <tools> block)
  remaining = remaining.replace(
    /<remember>([\s\S]*?)<\/remember>/g,
    (_, content: string) => { remembers.push(content.trim()); return ""; }
  );
  remaining = remaining.replace(
    /<forget>([\s\S]*?)<\/forget>/g,
    (_, content: string) => { forgets.push(content.trim()); return ""; }
  );

  // Bare <tool>...</tool> outside a <tools> wrapper
  remaining = remaining.replace(
    /<tool>([\s\S]*?)<\/tool>/g,
    (_, content: string) => {
      const call = parseToolCall(content.trim());
      if (call) toolCalls.push(call);
      return "";
    }
  );

  return {
    toolCalls,
    remembers,
    forgets,
    cleanText: remaining.trim(),
  };
}

/**
 * Parse Kimi K2 tool calls:
 *   <|tool_call_begin|>functions.Name:0<|tool_call_argument_begin|>{"arg":"val"}<|tool_call_end|>
 */
function parseKimiToolCalls(content: string, toolCalls: ToolCall[]): void {
  const callRe = /<\|tool_call_begin\|>([\s\S]*?)<\|tool_call_end\|>/g;
  let match: RegExpExecArray | null;

  while ((match = callRe.exec(content)) !== null) {
    const body = match[1].trim();

    // Split on <|tool_call_argument_begin|>
    const sepIdx = body.indexOf("<|tool_call_argument_begin|>");
    if (sepIdx === -1) continue;

    const header = body.substring(0, sepIdx).trim();
    const argsJson = body.substring(sepIdx + "<|tool_call_argument_begin|>".length).trim();

    // Header format: "functions.Name:idx" or just "Name"
    let name = header;
    const funcMatch = header.match(/^functions\.(\w+)/);
    if (funcMatch) name = funcMatch[1];

    // Parse JSON arguments into positional rawArgs (values in key order)
    const rawArgs: string[] = [];
    if (argsJson) {
      try {
        const parsed = JSON.parse(argsJson);
        if (typeof parsed === "object" && parsed !== null) {
          for (const value of Object.values(parsed)) {
            rawArgs.push(String(value));
          }
        } else {
          rawArgs.push(String(parsed));
        }
      } catch {
        // If not valid JSON, treat as a single string arg
        rawArgs.push(argsJson);
      }
    }

    toolCalls.push({ name, rawArgs });
  }
}

/** Extract tool calls, remembers, and forgets from inside a <tools> block */
function parseInnerBlocks(
  content: string,
  toolCalls: ToolCall[],
  remembers: string[],
  forgets: string[]
): void {
  let match: RegExpExecArray | null;

  const toolRe = /<tool>([\s\S]*?)<\/tool>/g;
  while ((match = toolRe.exec(content)) !== null) {
    const call = parseToolCall(match[1].trim());
    if (call) toolCalls.push(call);
  }

  const rememberRe = /<remember>([\s\S]*?)<\/remember>/g;
  while ((match = rememberRe.exec(content)) !== null) {
    remembers.push(match[1].trim());
  }

  const forgetRe = /<forget>([\s\S]*?)<\/forget>/g;
  while ((match = forgetRe.exec(content)) !== null) {
    forgets.push(match[1].trim());
  }
}

/**
 * Parse a tool call string like `ReadFile("./README.md")` into a ToolCall.
 * Returns null if the format is unrecognised.
 */
export function parseToolCall(text: string): ToolCall | null {
  // Match: Name( ... )
  const match = text.match(/^(\w+)\(([\s\S]*)\)$/);
  if (!match) return null;

  const name = match[1];
  const argsStr = match[2].trim();

  if (!argsStr) {
    return { name, rawArgs: [] };
  }

  const args = parseArguments(argsStr);
  return { name, rawArgs: args };
}

/**
 * Parse a comma-separated list of quoted string arguments.
 * Supports both positional args and named kwargs (name=value).
 * Supports double quotes, single quotes, and backticks.
 * Handles backslash escapes inside quoted strings.
 */
export function parseArguments(argsStr: string): string[] {
  const args: string[] = [];
  let i = 0;

  while (i < argsStr.length) {
    // Skip whitespace
    while (i < argsStr.length && /\s/.test(argsStr[i])) i++;
    if (i >= argsStr.length) break;

    // Skip kwarg name= or name: prefix (e.g. path="...", command: "...")
    const kwargMatch = argsStr.slice(i).match(/^(\w+)\s*[=:]\s*/);
    if (kwargMatch) {
      i += kwargMatch[0].length;
    }

    // Skip whitespace after =
    while (i < argsStr.length && /\s/.test(argsStr[i])) i++;
    if (i >= argsStr.length) break;

    const quote = argsStr[i];
    if (quote === '"' || quote === "'" || quote === "`") {
      i++; // skip opening quote
      let value = "";
      while (i < argsStr.length && argsStr[i] !== quote) {
        if (argsStr[i] === "\\" && i + 1 < argsStr.length) {
          i++;
          switch (argsStr[i]) {
            case "n":
              value += "\n";
              break;
            case "t":
              value += "\t";
              break;
            case "\\":
              value += "\\";
              break;
            default:
              // For the matching quote or any other char, emit literally
              value += argsStr[i];
              break;
          }
        } else {
          value += argsStr[i];
        }
        i++;
      }
      i++; // skip closing quote
      args.push(value);

      // Skip whitespace and comma separator
      while (i < argsStr.length && /[\s,]/.test(argsStr[i])) i++;
    } else {
      // Unquoted argument — read until comma or end
      let value = "";
      while (i < argsStr.length && argsStr[i] !== ",") {
        value += argsStr[i];
        i++;
      }
      args.push(value.trim());
      if (i < argsStr.length) i++; // skip comma
    }
  }

  return args;
}
