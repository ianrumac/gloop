import React from "react";
import { Text, Box, useInput } from "ink";

interface Props {
  command: string;
  onResolve: (approved: boolean) => void;
}

export default function ConfirmDialog({ command, onResolve }: Props) {
  useInput((input) => {
    if (input.toLowerCase() === "y") {
      onResolve(true);
    } else if (input.toLowerCase() === "n") {
      onResolve(false);
    }
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="yellow" bold>
        ⚠ Dangerous command: {command}
      </Text>
      <Text color="yellow">  Allow execution? (y/n)</Text>
    </Box>
  );
}
