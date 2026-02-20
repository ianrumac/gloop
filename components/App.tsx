import React, { useState, useCallback, useRef, useEffect } from "react";
import { Box, Static, Text, useStdout } from "ink";
import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { AbortError } from "../src/core/core.ts";
import ToolExecution from "./ToolExecution.tsx";
import type { ToolStatus } from "./ToolExecution.tsx";
import ConfirmDialog from "./ConfirmDialog.tsx";
import AskUserDialog from "./AskUserDialog.tsx";
import InputPrompt from "./InputPrompt.tsx";

const marked = new Marked(markedTerminal());
const renderMd = (s: string) => (marked.parse(s) as string).trimEnd();

function formatError(err: any): string {
  let msg = `Error: ${err.message || err}`;
  if (err.status) msg += `\nStatus: ${err.status}`;
  if (err.error) {
    const body = typeof err.error === "string" ? err.error : JSON.stringify(err.error, null, 2);
    msg += `\nDetails: ${body}`;
  }
  if (err.body) {
    const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body, null, 2);
    msg += `\nBody: ${body}`;
  }
  if (err.cause) msg += `\nCause: ${err.cause}`;
  if (err.code) msg += `\nCode: ${err.code}`;
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

/** UI callbacks that effects need */
export interface AgentUI {
  onStreamChunk(text: string): void;
  onStreamDone(): void;
  onToolStart(name: string, preview: string): void;
  onToolDone(name: string, ok: boolean, output: string): void;
  onConfirmNeeded(command: string): Promise<boolean>;
  onAskUser(question: string): Promise<string>;
  onRemember(content: string): void;
  onForget(content: string): void;
  onSystemPromptRefreshed(): void;
  onTaskComplete(summary: string): void;
}

interface Props {
  model: string;
  rebootReason?: string;
  runAgent: (input: string, ui: AgentUI, signal: AbortSignal) => Promise<void>;
}

// ============================================================================
// COMPONENT
// ============================================================================

let _id = 0;
const uid = () => String(++_id);

export default function App({ model, rebootReason, runAgent }: Props) {
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;

  // Header is the first Static entry — rendered once, scrolls up naturally
  const [committed, setCommitted] = useState<CommittedEntry[]>([
    { kind: "header", id: uid(), model },
  ]);
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [streaming, setStreaming] = useState("");
  const [confirm, setConfirm] = useState<{ cmd: string; resolve: (ok: boolean) => void } | null>(null);
  const [askUser, setAskUser] = useState<{ q: string; resolve: (a: string) => void } | null>(null);
  const [busy, setBusy] = useState(false);
  const didResume = useRef(false);
  const streamBuf = useRef("");
  const abortRef = useRef<AbortController | null>(null);
  const queueRef = useRef<string[]>([]);
  const processingRef = useRef(false);

  // Core processing — constructs UI callbacks and runs the agent
  const processInput = useCallback(async (input: string) => {
    processingRef.current = true;
    setBusy(true);
    setStreaming("");
    streamBuf.current = "";

    const abort = new AbortController();
    abortRef.current = abort;

    const ui: AgentUI = {
      onStreamChunk(text) {
        streamBuf.current += text;
        setStreaming(streamBuf.current);
      },
      onStreamDone() {
        const final = streamBuf.current.trim();
        if (final) {
          setCommitted(t => [...t, { kind: "assistant", id: uid(), content: final }]);
        }
        setStreaming("");
        streamBuf.current = "";
      },
      onToolStart(name, preview) {
        const id = uid();
        setLiveTools(prev => [...prev, { id, name, preview }]);
      },
      onToolDone(name, ok, output) {
        setLiveTools(prev => {
          const idx = prev.findIndex(t => t.name === name);
          if (idx === -1) return prev;
          const tool = prev[idx]!;
          const status: ToolStatus = ok ? "success" : output === "denied by user" ? "denied" : "error";
          setCommitted(c => [...c, { kind: "tool", id: tool.id, name: tool.name, preview: tool.preview, status, output }]);
          return [...prev.slice(0, idx), ...prev.slice(idx + 1)];
        });
      },
      onConfirmNeeded: (cmd) => new Promise(resolve => setConfirm({ cmd, resolve })),
      onAskUser: (q) => new Promise(resolve => setAskUser({ q, resolve })),
      onRemember(content) {
        setCommitted(t => [...t, { kind: "memory", id: uid(), type: "remember", content }]);
      },
      onForget(content) {
        setCommitted(t => [...t, { kind: "memory", id: uid(), type: "forget", content }]);
      },
      onSystemPromptRefreshed() {
        setCommitted(t => [...t, { kind: "system-refresh", id: uid() }]);
      },
      onTaskComplete(summary) {
        setCommitted(t => [...t, { kind: "assistant", id: uid(), content: summary }]);
      },
    };

    try {
      await runAgent(input, ui, abort.signal);
    } catch (err: any) {
      if (err instanceof AbortError) {
        setStreaming("");
        streamBuf.current = "";
        // Move any still-running tools to committed as interrupted
        setLiveTools(prev => {
          if (prev.length > 0) {
            setCommitted(c => [
              ...c,
              ...prev.map(t => ({
                kind: "tool" as const,
                id: t.id,
                name: t.name,
                preview: t.preview,
                status: "error" as ToolStatus,
                output: "interrupted",
              })),
            ]);
          }
          return [];
        });
        setCommitted(t => [...t, { kind: "assistant", id: uid(), content: "[Interrupted]" }]);
      } else {
        const details = formatError(err);
        setCommitted(t => [...t, { kind: "assistant", id: uid(), content: details }]);
      }
    }

    abortRef.current = null;
    setConfirm(null);
    setAskUser(null);

    // Process next queued input if any
    // (user entry was already committed by handleSubmit — don't re-commit)
    const next = queueRef.current.shift();
    if (next) {
      await processInput(next);
    } else {
      processingRef.current = false;
      setBusy(false);
    }
  }, [runAgent]);

  // Submit handler — queues if busy
  const handleSubmit = useCallback(async (input: string) => {
    // Always commit the user entry immediately
    setCommitted(t => [...t, { kind: "user", id: uid(), content: input }]);

    if (processingRef.current) {
      queueRef.current.push(input);
    } else {
      processInput(input);
    }
  }, [processInput]);

  // Escape handler — abort current run and clear queue
  const handleEscape = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      queueRef.current = [];
    }
  }, []);

  // Auto-resume after reboot
  useEffect(() => {
    if (rebootReason && !didResume.current) {
      didResume.current = true;
      handleSubmit(`[System: Rebooted successfully. Reason: ${rebootReason}. Fresh code is now loaded. Continue where you left off.]`);
    }
  }, [rebootReason, handleSubmit]);

  const handleConfirm = useCallback((ok: boolean) => {
    confirm?.resolve(ok);
    setConfirm(null);
  }, [confirm]);

  const handleAnswer = useCallback((a: string) => {
    askUser?.resolve(a);
    setAskUser(null);
  }, [askUser]);

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
      {liveTools.map(tool => (
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
      {!streaming && busy && !confirm && !askUser ? (
        <Box><Text dimColor>Thinking...</Text></Box>
      ) : null}

      {/* Queued items indicator — shown in dynamic area at the bottom */}
      {queueRef.current.length > 0 ? (
        <Box>
          <Text dimColor>[{queueRef.current.length} queued]</Text>
        </Box>
      ) : null}

      {/* Confirm / AskUser dialogs */}
      {confirm ? <ConfirmDialog command={confirm.cmd} onResolve={handleConfirm} /> : null}
      {askUser ? <AskUserDialog question={askUser.q} onAnswer={handleAnswer} /> : null}

      {/* Input — always visible; inactive when a dialog needs input */}
      <InputPrompt
        onSubmit={handleSubmit}
        onEscape={handleEscape}
        isActive={!confirm && !askUser}
      />
    </Box>
  );
}
