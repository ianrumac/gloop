import React from "react";
import { Text, Box } from "ink";

export type ToolStatus = "running" | "success" | "error" | "denied";

interface Props {
  name: string;
  preview: string;
  status: ToolStatus;
  output?: string;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.substring(0, max) + "..." : s;
}

function censor(s: string): string {
  return s.replace(/ianrumac/g, "********");
}

export default function ToolExecution({ name, preview, status, output }: Props) {
  const desc = preview ? censor(truncate(preview, 60)) : "";
  const outputPreview = output ? censor(truncate(output, 120)) : "error";

  switch (status) {
    case "running":
      return (
        <Box>
          <Text dimColor>
            ... {name}{desc ? `: ${desc}` : ""}
          </Text>
        </Box>
      );
    case "success":
      return (
        <Box>
          <Text dimColor>  ✔ {name}{desc ? `: ${desc}` : ""}</Text>
        </Box>
      );
    case "error":
      return (
        <Box>
          <Text color="red" dimColor>  ✖ {name}: {outputPreview}</Text>
        </Box>
      );
    case "denied":
      return (
        <Box>
          <Text color="red" dimColor>  ✖ {name}: denied by user</Text>
        </Box>
      );
  }
}
