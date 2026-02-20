import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface Props {
  question: string;
  onAnswer: (answer: string) => void;
}

export default function AskUserDialog({ question, onAnswer }: Props) {
  const [value, setValue] = useState("");

  const handleSubmit = (text: string) => {
    if (!text.trim()) return;
    setValue("");
    onAnswer(text.trim());
  };

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="magenta" bold>
        ? {question}
      </Text>
      <Box>
        <Text color="magenta">&gt; </Text>
        <TextInput value={value} onChange={setValue} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
}
