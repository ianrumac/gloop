import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Static, Text, useStdout } from "ink";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import type { AgentLoop, AgentEvent } from "../src/core/core.ts";
import ToolExecution from "./ToolExecution.tsx";
import type { ToolStatus } from "./ToolExecution.tsx";
import ConfirmDialog from "./ConfirmDialog.tsx";
import AskUserDialog from "./AskUserDialog.tsx";
import InputPrompt from "./InputPrompt.tsx";

const marked = new Marked(markedTerminal());
const renderMd = (s: string) => (marked.parse(s) as string).trimEnd();

function formatError(err: Error): string {
  let msg = `Error: ${err.message}`;
  // Common shapes from provider SDKs — defensive but no longer `any`.
  const extras = err as Error & {
    status?: number;
    error?: unknown;
    body?: unknown;
    cause?: unknown;
    code?: string;
  };
  if (extras.status) msg += `\nStatus: ${extras.status}`;
  if (extras.error) {
    const body = typeof extras.error === "string" ? extras.error : JSON.stringify(extras.error, null, 2);
    msg += `\nDetails: ${body}`;
  }
  if (extras.body) {
    const body = typeof extras.body === "string" ? extras.body : JSON.stringify(extras.body, null, 2);
    msg += `\nBody: ${body}`;
  }
  if (extras.cause) msg += `\nCause: ${String(extras.cause)}`;
  if (extras.code) msg += `\nCode: ${extras.code}`;
  return msg;
}

// ============================================================================
// TYPES
// ============================================================================

/** Committed entry — finalized, rendered once via <Static> */
type CommittedEntry =
  | { kind: "header"; id: string; model: string }
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; content: string }
  | { kind: "tool"; id: string; name: string; preview: string; status: ToolStatus; output?: string }
  | { kind: "memory"; id: string; type: "remember" | "forget"; content: string }
  | { kind: "system-refresh"; id: string };

/** Live tool — still running, rendered in the dynamic area */
interface LiveTool {
  id: string;
  name: string;
  preview: string;
}

interface Props {
  model: string;
  rebootReason?: string;
  agent: AgentLoop;
}

// ============================================================================
// COMPONENT
// ============================================================================

let _id = 0;
const uid = () => `ui_${++_id}`;

export default function App({ model, rebootReason, agent }: Props) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  // Committed timeline — written once to stdout via <Static>.
  const [committed, setCommitted] = useState<CommittedEntry[]>([
    { kind: "header", id: uid(), model },
  ]);
  // Live (running) tools — shown with spinners in the dynamic area.
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  // Streaming assistant text for the current turn.
  const [streaming, setStreaming] = useState("");
  // Pending confirm / ask dialogs.
  const [confirmReq, setConfirmReq] = useState<{ id: string; command: string } | null>(null);
  const [askReq, setAskReq] = useState<{ id: string; question: string } | null>(null);
  // Busy = actor is actively processing a turn.
  const [busy, setBusy] = useState(false);
  // Inbox size (kept in state so the indicator re-renders).
  const [queueSize, setQueueSize] = useState(0);

  // Refs — used as mutation-safe accumulators, never read from JSX.
  const streamBufRef = useRef("");
  const liveToolsRef = useRef<LiveTool[]>([]);
  const didResume = useRef(false);

  // ============================================================================
  // EVENT SUBSCRIPTION
  // ============================================================================

  useEffect(() => {
    const listener = (event: AgentEvent) => {
      switch (event.type) {
        case "busy":
          setBusy(true);
          break;

        case "idle":
          setBusy(false);
          break;

        case "queue_changed":
          setQueueSize(event.pending);
          break;

        case "turn_start":
          // Reset per-turn accumulators.
          streamBufRef.current = "";
          setStreaming("");
          break;

        case "turn_end":
          // Any still-live tools become "interrupted" committed entries.
          if (liveToolsRef.current.length > 0) {
            const drained = liveToolsRef.current;
            liveToolsRef.current = [];
            setLiveTools([]);
            setCommitted((c) => [
              ...c,
              ...drained.map((t) => ({
                kind: "tool" as const,
                id: t.id,
                name: t.name,
                preview: t.preview,
                status: "error" as ToolStatus,
                output: "interrupted",
              })),
            ]);
          }
          break;

        case "stream_chunk":
          streamBufRef.current += event.text;
          setStreaming(streamBufRef.current);
          break;

        case "stream_done": {
          const final = streamBufRef.current.trim();
          streamBufRef.current = "";
          setStreaming("");
          if (final) {
            setCommitted((c) => [...c, { kind: "assistant", id: uid(), content: final }]);
          }
          break;
        }

        case "tool_start": {
          const tool: LiveTool = { id: event.id, name: event.name, preview: event.preview };
          liveToolsRef.current = [...liveToolsRef.current, tool];
          setLiveTools(liveToolsRef.current);
          break;
        }

        case "tool_done": {
          const tool = liveToolsRef.current.find((t) => t.id === event.id);
          if (!tool) break;
          liveToolsRef.current = liveToolsRef.current.filter((t) => t.id !== event.id);
          setLiveTools(liveToolsRef.current);
          const status: ToolStatus = event.ok
            ? "success"
            : event.output === "denied by user"
              ? "denied"
              : "error";
          setCommitted((c) => [
            ...c,
            {
              kind: "tool",
              id: event.id,
              name: event.name,
              preview: tool.preview,
              status,
              output: event.output,
            },
          ]);
          break;
        }

        case "memory":
          setCommitted((c) => [
            ...c,
            { kind: "memory", id: uid(), type: event.op, content: event.content },
          ]);
          break;

        case "system_refreshed":
          setCommitted((c) => [...c, { kind: "system-refresh", id: uid() }]);
          break;

        case "task_complete":
          // The assistant's final summary — render as an assistant message.
          if (event.summary.trim()) {
            setCommitted((c) => [
              ...c,
              { kind: "assistant", id: uid(), content: event.summary },
            ]);
          }
          break;

        case "interrupted":
          streamBufRef.current = "";
          setStreaming("");
          setCommitted((c) => [...c, { kind: "assistant", id: uid(), content: "[Interrupted]" }]);
          break;

        case "error":
          // RebootError / fatal errors are handled via wireRebootHandler in
          // bin/index.ts — they never fire as `error` events.
          streamBufRef.current = "";
          setStreaming("");
          setCommitted((c) => [
            ...c,
            { kind: "assistant", id: uid(), content: formatError(event.error) },
          ]);
          break;

        case "fatal":
          // Silently drop — the reboot handler will unmount us momentarily.
          break;

        case "confirm_request":
          setConfirmReq({ id: event.id, command: event.command });
          break;

        case "ask_request":
          setAskReq({ id: event.id, question: event.question });
          break;
      }
    };
    agent.onEvent(listener);

    // Start the actor once the subscription is in place.
    agent.start();

    return () => {
      agent.offEvent(listener);
    };
  }, [agent]);

  // ============================================================================
  // INPUT HANDLERS
  // ============================================================================

  const handleSubmit = useCallback(
    (input: string) => {
      // Commit the user entry immediately — feels responsive.
      setCommitted((c) => [...c, { kind: "user", id: uid(), content: input }]);
      agent.send(input);
    },
    [agent],
  );

  const handleEscape = useCallback(() => {
    agent.interrupt();
  }, [agent]);

  const handleConfirm = useCallback(
    (ok: boolean) => {
      if (confirmReq) {
        agent.respondToConfirm(confirmReq.id, ok);
        setConfirmReq(null);
      }
    },
    [agent, confirmReq],
  );

  const handleAnswer = useCallback(
    (answer: string) => {
      if (askReq) {
        agent.respondToAsk(askReq.id, answer);
        setAskReq(null);
      }
    },
    [agent, askReq],
  );

  // Auto-resume after reboot: once on mount.
  useEffect(() => {
    if (rebootReason && !didResume.current) {
      didResume.current = true;
      handleSubmit(
        `[System: Rebooted successfully. Reason: ${rebootReason}. Fresh code is now loaded. Continue where you left off.]`,
      );
    }
  }, [rebootReason, handleSubmit]);

  // ============================================================================
  // RENDER
  // ============================================================================

  return (
    <Box flexDirection="column">
      {/* Committed entries — written once to stdout, scroll naturally */}
      <Static items={committed}>
        {(entry) => {
          switch (entry.kind) {
            case "header":
              return (
                <Box key={entry.id} marginBottom={1}>
                  <Text bold color="cyan">gloop</Text>
                  <Text dimColor> — {entry.model} (ctrl+c to exit, esc to interrupt)</Text>
                </Box>
              );
            case "user":
              return (
                <Box key={entry.id} marginBottom={1} width={cols} paddingX={1} paddingY={0} backgroundColor="#2a2a2a">
                  <Text><Text bold color="green">&gt; </Text>{entry.content}</Text>
                </Box>
              );
            case "assistant":
              return (
                <Box key={entry.id} marginBottom={1}>
                  <Text>{renderMd(entry.content)}</Text>
                </Box>
              );
            case "tool":
              return (
                <ToolExecution
                  key={entry.id}
                  name={entry.name}
                  preview={entry.preview}
                  status={entry.status}
                  output={entry.output}
                />
              );
            case "memory":
              return (
                <Box key={entry.id}>
                  <Text color="yellow">
                    {entry.type === "remember" ? "  ● remembered" : "  ○ forgot"}:{" "}
                    {entry.content.substring(0, 60)}
                    {entry.content.length > 60 ? "..." : ""}
                  </Text>
                </Box>
              );
            case "system-refresh":
              return (
                <Box key={entry.id}>
                  <Text color="yellow">  ● system prompt refreshed</Text>
                </Box>
              );
          }
        }}
      </Static>

      {/* Dynamic area — re-rendered each frame, stays at bottom */}

      {/* Running tools (spinners) */}
      {liveTools.map((tool) => (
        <ToolExecution
          key={tool.id}
          name={tool.name}
          preview={tool.preview}
          status="running"
        />
      ))}

      {/* Current streaming text */}
      {streaming ? (
        <Box><Text>{renderMd(streaming)}</Text></Box>
      ) : null}
      {!streaming && busy && !confirmReq && !askReq ? (
        <Box><Text dimColor>Thinking...</Text></Box>
      ) : null}

      {/* Queued items indicator — now reactive, because queueSize is state */}
      {queueSize > 0 ? (
        <Box>
          <Text dimColor>[{queueSize} queued]</Text>
        </Box>
      ) : null}

      {/* Confirm / AskUser dialogs */}
      {confirmReq ? <ConfirmDialog command={confirmReq.command} onResolve={handleConfirm} /> : null}
      {askReq ? <AskUserDialog question={askReq.question} onAnswer={handleAnswer} /> : null}

      {/* Input — always visible; inactive when a dialog needs input */}
      <InputPrompt
        onSubmit={handleSubmit}
        onEscape={handleEscape}
        isActive={!confirmReq && !askReq}
      />
    </Box>
  );
}
