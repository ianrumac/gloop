import { test, expect, describe } from "bun:test";
import { StreamFilter, type ToolParsedInfo } from "./ui.ts";

// Helper: collect all emitted text from a StreamFilter
function filterText(input: string, onToolParsed?: (info: ToolParsedInfo) => void): string {
  let out = "";
  const filter = new StreamFilter((text) => { out += text; }, onToolParsed);
  filter.write(input);
  filter.flush();
  return out;
}

// Helper: feed input character-by-character (simulates chunked streaming)
function filterCharByChar(input: string, onToolParsed?: (info: ToolParsedInfo) => void): string {
  let out = "";
  const filter = new StreamFilter((text) => { out += text; }, onToolParsed);
  for (const ch of input) {
    filter.write(ch);
  }
  filter.flush();
  return out;
}

describe("StreamFilter", () => {
  describe("normal text passthrough", () => {
    test("passes plain text through unchanged", () => {
      expect(filterText("Hello, world!")).toBe("Hello, world!");
    });

    test("passes text with regular HTML tags through", () => {
      expect(filterText("Use <b>bold</b> here")).toBe("Use <b>bold</b> here");
    });

    test("passes empty string", () => {
      expect(filterText("")).toBe("");
    });

    test("passes text with angle brackets that are not tags", () => {
      expect(filterText("a < b and b > c")).toBe("a < b and b > c");
    });
  });

  describe("<tools> suppression", () => {
    test("suppresses simple <tools> block", () => {
      const input = 'Let me do that. <tools><tool>ReadFile("./README.md")</tool></tools>';
      expect(filterText(input)).toBe("Let me do that. ");
    });

    test("suppresses <tools> block with text before and after", () => {
      const input = 'Before. <tools><tool>Bash("ls")</tool></tools> After.';
      expect(filterText(input)).toBe("Before.  After.");
    });

    test("suppresses multiline <tools> block", () => {
      const input = `Here:
<tools>
  <tool>ReadFile("a.ts")</tool>
  <tool>Bash("ls")</tool>
</tools>
Done.`;
      expect(filterText(input)).toBe("Here:\n\nDone.");
    });

    test("handles chunked streaming of <tools> block", () => {
      const input = 'Text <tools><tool>ReadFile("x")</tool></tools>';
      expect(filterCharByChar(input)).toBe("Text ");
    });
  });

  describe("<remember> suppression", () => {
    test("suppresses <remember> block", () => {
      const input = "Sure! <remember>The answer is 42</remember> Done.";
      expect(filterText(input)).toBe("Sure!  Done.");
    });

    test("suppresses multiline <remember>", () => {
      const input = "OK. <remember>Line 1\nLine 2\nLine 3</remember> Noted.";
      expect(filterText(input)).toBe("OK.  Noted.");
    });
  });

  describe("<forget> suppression", () => {
    test("suppresses <forget> block", () => {
      const input = "OK. <forget>old fact</forget> Forgotten.";
      expect(filterText(input)).toBe("OK.  Forgotten.");
    });
  });

  describe("Kimi K2 format suppression", () => {
    test("suppresses Kimi tool call block", () => {
      const input = 'Let me check. <|tool_calls_section_begin|><|tool_call_begin|>functions.ReadFile:0<|tool_call_argument_begin|>{"path":"./README.md"}<|tool_call_end|><|tool_calls_section_end|>';
      expect(filterText(input)).toBe("Let me check. ");
    });

    test("suppresses Kimi block char-by-char", () => {
      const input = 'Text <|tool_calls_section_begin|>content<|tool_calls_section_end|> more';
      expect(filterCharByChar(input)).toBe("Text  more");
    });
  });

  describe("nesting handling", () => {
    test("handles nested <tools> in content (WriteFile writing system prompt)", () => {
      // When the agent writes a file containing <tools>...</tools>,
      // the outer tools block must not close prematurely at the inner </tools>
      const inner = '<tools>\n<tool name="X">\n</tools>';
      const input = `<tools><tool>WriteFile("sys.txt", "${inner}")</tool></tools>`;
      expect(filterText(input)).toBe("");
    });
  });

  describe("onToolParsed callback", () => {
    test("fires for each completed <tool> inside <tools>", () => {
      const parsed: ToolParsedInfo[] = [];
      const input = '<tools><tool>ReadFile("./a.ts")</tool><tool>Bash("ls")</tool></tools>';
      filterText(input, (info) => parsed.push(info));

      expect(parsed).toHaveLength(2);
      expect(parsed[0].name).toBe("ReadFile");
      expect(parsed[1].name).toBe("Bash");
    });

    test("includes preview in callback", () => {
      const parsed: ToolParsedInfo[] = [];
      const input = '<tools><tool>ReadFile("./very/long/path/to/file.ts")</tool></tools>';
      filterText(input, (info) => parsed.push(info));

      expect(parsed).toHaveLength(1);
      expect(parsed[0].preview).toContain("./very/long/path");
    });

    test("fires during streaming (before block closes)", () => {
      const parsed: ToolParsedInfo[] = [];
      const filter = new StreamFilter(() => {}, (info) => parsed.push(info));

      filter.write('<tools><tool>ReadFile("x")</tool>');
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("ReadFile");

      filter.write('<tool>Bash("ls")</tool></tools>');
      expect(parsed).toHaveLength(2);
      filter.flush();
    });

    test("does not fire for bare <tool> tags outside <tools>", () => {
      const parsed: ToolParsedInfo[] = [];
      const input = '<tool>ReadFile("x")</tool>';
      filterText(input, (info) => parsed.push(info));
      // Bare <tool> is not in OPENING_TAGS, so it passes through and onToolParsed is never called
      expect(parsed).toHaveLength(0);
    });
  });

  describe("flush behavior", () => {
    test("flushes incomplete buffering state as text", () => {
      let out = "";
      const filter = new StreamFilter((text) => { out += text; });
      filter.write("Hello <");
      filter.flush();
      expect(out).toBe("Hello <");
    });

    test("resets state after flush", () => {
      let out = "";
      const filter = new StreamFilter((text) => { out += text; });
      filter.write("A <tools><tool>X()</tool></tools> B");
      out = ""; // reset
      filter.flush();
      // After suppression + flush, state should be clean
      filter.write("C");
      expect(out).toBe("C");
    });
  });

  describe("edge cases", () => {
    test("multiple <tools> blocks in one response", () => {
      const input = 'First <tools><tool>A()</tool></tools> mid <tools><tool>B()</tool></tools> end';
      expect(filterText(input)).toBe("First  mid  end");
    });

    test("mixed <tools> and <remember> blocks", () => {
      const input = 'Text <tools><tool>X()</tool></tools> <remember>note</remember> end';
      expect(filterText(input)).toBe("Text   end");
    });

    test("tag-like content that isn't a known tag passes through", () => {
      expect(filterText("Use <div>html</div> here")).toBe("Use <div>html</div> here");
    });

    test("partial tag prefix followed by non-tag chars", () => {
      // "<to" is a prefix of "<tools>" but "<toaster>" is not
      expect(filterText("I like <toaster>s")).toBe("I like <toaster>s");
    });

    test("handles < at end of input", () => {
      let out = "";
      const filter = new StreamFilter((text) => { out += text; });
      filter.write("end <");
      filter.flush();
      expect(out).toBe("end <");
    });
  });
});
