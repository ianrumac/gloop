// ---- Streaming tag filter ----
//
// Suppresses <tool>, <tools>, <remember>, <forget> blocks during streaming
// so the user only sees clean prose.  The raw text is still accumulated
// separately for the parser.
//
// When a complete <tool>...</tool> block is detected inside <tools>,
// the onToolParsed callback fires immediately so the UI can show a spinner
// before the full response finishes streaming.
//
// Nesting depth is tracked so that literal </tools> inside tool arguments
// (e.g. WriteFile writing system prompt text) doesn't prematurely end
// suppression.

const OPENING_TAGS = ["<tools>", "<remember>", "<forget>", "<|tool_calls_section_begin|>"];

const CLOSING_FOR: Record<string, string[]> = {
  "<tools>": ["</tools>"],
  "<remember>": ["</remember>"],
  "<forget>": ["</forget>"],
  "<|tool_calls_section_begin|>": ["<|tool_calls_section_end|>"],
};

// Tags whose suppressed content should be scanned for individual <tool> blocks
const TOOL_CONTAINERS = new Set(["<tools>", "<|tool_calls_section_begin|>"]);

type State = "normal" | "buffering" | "suppressing";

export interface ToolParsedInfo {
  name: string;
  preview: string;
}

export class StreamFilter {
  private state: State = "normal";
  private buffer = "";
  private closingTags: string[] = [];
  private currentOpeningTag = "";
  private nestingDepth = 0;
  private emit: (text: string) => void;
  private onToolParsed?: (info: ToolParsedInfo) => void;
  private isToolContainer = false;
  private processedToolCount = 0;

  constructor(emit: (text: string) => void, onToolParsed?: (info: ToolParsedInfo) => void) {
    this.emit = emit;
    this.onToolParsed = onToolParsed;
  }

  write(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;

      switch (this.state) {
        case "normal":
          if (ch === "<") {
            this.buffer = "<";
            this.state = "buffering";
          } else {
            this.emit(ch);
          }
          break;

        case "buffering":
          this.buffer += ch;
          // Check if the buffer exactly matches a known opening tag
          const exactMatch = OPENING_TAGS.find((t) => t === this.buffer);
          if (exactMatch) {
            // Enter suppressing mode
            this.closingTags = CLOSING_FOR[exactMatch]!;
            this.currentOpeningTag = exactMatch;
            this.nestingDepth = 0;
            this.isToolContainer = TOOL_CONTAINERS.has(exactMatch);
            this.processedToolCount = 0;
            this.buffer = "";
            this.state = "suppressing";
            break;
          }
          // Check if the buffer is still a valid prefix of any known tag
          const isPrefix = OPENING_TAGS.some((t) => t.startsWith(this.buffer));
          if (!isPrefix) {
            // Not a tag we care about — flush buffer as normal text
            this.emit(this.buffer);
            this.buffer = "";
            this.state = "normal";
          }
          break;

        case "suppressing":
          this.buffer += ch;

          // Track nesting: if tool content contains a literal opening tag
          // (e.g. WriteFile writing system prompt that mentions <tools>),
          // increment depth so the matching </tools> doesn't exit suppression early.
          if (this.currentOpeningTag && this.buffer.endsWith(this.currentOpeningTag)) {
            this.nestingDepth++;
          }

          // Detect individual <tool>...</tool> completions for early UI feedback
          if (this.isToolContainer && this.onToolParsed && this.buffer.endsWith("</tool>")) {
            this.emitNewTools();
          }

          // Check if the buffer ends with any of the expected closing tags
          const closed = this.closingTags.some((ct) =>
            this.buffer.endsWith(ct)
          );
          if (closed) {
            if (this.nestingDepth > 0) {
              // This closing tag matches a nested opening tag inside content — skip it
              this.nestingDepth--;
            } else {
              // Real closing tag — exit suppression
              if (this.isToolContainer && this.onToolParsed) {
                this.emitNewTools();
              }
              this.buffer = "";
              this.closingTags = [];
              this.currentOpeningTag = "";
              this.nestingDepth = 0;
              this.isToolContainer = false;
              this.processedToolCount = 0;
              this.state = "normal";
            }
          }
          break;
      }
    }
  }

  /** Scan the suppression buffer for newly completed <tool> blocks and emit them. */
  private emitNewTools(): void {
    const toolRe = /<tool>([\s\S]*?)<\/tool>/g;
    let match: RegExpExecArray | null;
    let count = 0;

    while ((match = toolRe.exec(this.buffer)) !== null) {
      count++;
      if (count <= this.processedToolCount) continue;

      const body = match[1]!.trim();
      // Parse "ToolName(args...)" — extract name and a short arg preview
      const nameMatch = body.match(/^(\w+)\(/);
      if (nameMatch) {
        const name = nameMatch[1]!;
        const argsStart = name.length + 1;
        const argsEnd = body.lastIndexOf(")");
        const rawArgs = argsEnd > argsStart ? body.substring(argsStart, argsEnd) : "";
        // Build a short preview from the first argument
        const preview = rawArgs.substring(0, 60) + (rawArgs.length > 60 ? "..." : "");
        this.onToolParsed!({ name, preview });
      }
    }

    this.processedToolCount = count;
  }

  /** Flush any remaining buffered text (e.g. a `<` that never became a tag) */
  flush(): void {
    if (this.buffer && this.state === "buffering") {
      this.emit(this.buffer);
    }
    this.buffer = "";
    this.closingTags = [];
    this.currentOpeningTag = "";
    this.nestingDepth = 0;
    this.isToolContainer = false;
    this.processedToolCount = 0;
    this.state = "normal";
  }
}
