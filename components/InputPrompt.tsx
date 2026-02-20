import React, { useState } from "react";
import { Box, Text, useInput } from "ink";

interface Props {
  onSubmit: (value: string) => void;
  onEscape?: () => void;
  isActive?: boolean;
}

export default function InputPrompt({ onSubmit, onEscape, isActive = true }: Props) {
  const [value, setValue] = useState("");

  useInput((input, key) => {
    if (key.escape) {
      onEscape?.();
      return;
    }

    if (key.return) {
      const trimmed = value.trim();
      if (!trimmed) return;
      setValue("");
      onSubmit(trimmed);
      return;
    }

    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return;
    }

    // Ignore control keys that aren't printable
    if (key.ctrl || key.meta) return;
    if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
    if (key.tab) return;

    // Append printable input (handles paste — all chars arrive as `input` string)
    if (input) {
      // Replace newlines from paste with spaces
      const cleaned = input.replace(/\r?\n/g, " ");
      setValue((v) => v + cleaned);
    }
  }, { isActive });

  return (
    <Box marginTop={1}>
      <Text bold color="green">&gt; </Text>
      <Text>{value}</Text>
    </Box>
  );
}
