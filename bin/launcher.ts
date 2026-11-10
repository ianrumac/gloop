#!/usr/bin/env bun
/**
 * gloop launcher — spawns the agent as a child process and handles restarts.
 *
 * When the child exits with code 75 (reboot), it respawns automatically.
 * Any other exit code is propagated to the parent.  SIGINT / SIGTERM /
 * SIGHUP are forwarded to the child (which shuts down cleanly) and the
 * launcher waits for it, so it never outlives or orphans the agent.
 */

import { parseTaskCliArgs, runTaskCli } from "../src/core/task-mode.ts";
import { existsSync } from "fs";
import { join } from "path";

const REBOOT_EXIT_CODE = 75;
const scriptDir = import.meta.dirname;
const args = process.argv.slice(2);

// ---------------------------------------------------------------------------
// --help / --version — handled here so they work even if the agent can't
// start (e.g. missing API key, broken local fork).
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`\
gloop — A recursive, self-modifying AI agent for the terminal.

USAGE
  gloop [model] [options]
  gloop --task "<task>" [model] [options]
  gloop graph [log.jsonl] [--json | --html [out.html]]
  gloop --help
  gloop --version

ARGUMENTS
  model                OpenRouter model id (e.g. anthropic/claude-sonnet-4.5).
                       Defaults to x-ai/grok-4.1-fast.

OPTIONS
  --task "<task>"      Run one task non-interactively and exit with the
                       agent's summary on stdout.  When set, the agent
                       auto-completes on the first CompleteTask and does
                       not open the interactive TUI.
  --provider <name>    OpenRouter provider routing (e.g. anthropic, openai).
                       Pins the request to a single upstream provider.
  --clone              Self-replicate: copy the agent's own source into
                       .gloop/src/ and run from there.  Enables the Reboot
                       tool and lets the agent modify its own code.
  --resume [path]      Continue a previous session from its event log
                       (.gloop/sessions/<timestamp>.jsonl).  Without a
                       path, resumes the most recent session.  A turn that
                       was cut off mid-way is rolled back and re-run.
  --debug              Enable debug logs to .gloop/debug.log.
  --help, -h           Show this help and exit.
  --version, -v        Show the installed version and exit.

SAFETY OPTIONS (also settable in .gloop/config.json; flags win)
  --max-iterations <n> Model calls per turn before it is stopped.
                       Default 200 (100 for --task).  0 = unlimited.
  --retries <n>        Attempts per model call, with backoff.  Default 3.
                       1 = no retry.
  --max-tool-output <n>
                       Characters of each tool result the model sees
                       (head + tail kept).  Default 50000.  0 = unlimited.
  --compact-at <x>     When to compact the context automatically: a
                       fraction of the model's context window (0.85), a
                       token count (150000), or a range target-trigger
                       (0.6-0.85, 90000-150000; also ..) — compact at the
                       top, down toward the bottom.  Default 0.85.
                       0 = never.
  --context-window <n> The model's context window in tokens.  Default:
                       looked up from the OpenRouter models list (cached
                       a day in .gloop/models-cache.json), else 128000.
  --compaction <mode>  How automatic compaction trims: fold (default; old
                       turns folded into short notes, no model call) or
                       llm (a model summarises).
  --task-timeout <ms>  Kill a --task subagent after this long.  Default
                       1800000 (30 min).  0 = no limit.

SUBCOMMANDS
  graph [log]          Show a session log as a graph: Mermaid by default,
                       --json for the raw turn graph, --html for a
                       self-contained interactive viewer (turn graph, event
                       causality, state scrubber).  Linked subagent logs
                       are followed.  See "gloop graph --help".

CONFIG FILE
  .gloop/config.json   Optional, per project.  Keys: maxIterations, retries,
                       maxToolOutput, compactAt, contextWindow, compaction,
                       keepTurns, taskTimeoutMs, maxTokens, llmIdleTimeoutMs.
                       e.g. { "compactAt": [0.6, 0.85], "maxTokens": 16000 }

ENVIRONMENT
  OPENROUTER_API_KEY   Required (unless OPENROUTER_BASE_URL is set).
  OPENROUTER_BASE_URL  Optional.  Any OpenAI-compatible API root (a local
                       model, a proxy) — requests go to <url>/chat/completions.

EXAMPLES
  # Interactive session with the default model
  gloop

  # Interactive session with a specific model
  gloop anthropic/claude-sonnet-4.5

  # Pin to a specific OpenRouter provider
  gloop --provider anthropic anthropic/claude-sonnet-4.5

  # Run a single task non-interactively
  gloop --task "read package.json and list the dependencies"

  # Self-modifying mode (enables Reboot tool)
  gloop --clone

  # Pick up where the last session left off
  gloop --resume

  # Open the last session as an interactive graph
  gloop graph --html && open .gloop/sessions/*.html

  # Debug logging
  gloop --debug

  # Tighter limits for an unattended task
  gloop --task "update the lockfile" --max-iterations 30 --task-timeout 600000

INTERACTIVE SESSION
  Enter          Submit message
  Esc            Interrupt the current turn (loop stays alive)
  Ctrl+C         Exit (stops the running turn and its processes;
                 press again to force quit)

MORE
  Library docs:  https://www.npmjs.com/package/@hypen-space/gloop-loop
  Source:        https://github.com/ianrumac/gloop
`);
}

function printVersion(): void {
  // Root package.json has no version; fall back to the gloop-loop
  // package version, which is the one that actually gets published.
  const candidates = [
    join(scriptDir, "..", "package.json"),
    join(scriptDir, "..", "packages", "gloop-loop", "package.json"),
  ];
  for (const path of candidates) {
    try {
      const pkg = JSON.parse(require("fs").readFileSync(path, "utf-8"));
      if (pkg.version) {
        console.log(`gloop ${pkg.version}`);
        return;
      }
    } catch { /* try next */ }
  }
  console.log("gloop unknown");
}

if (args.includes("--help") || args.includes("-h")) {
  printHelp();
  process.exit(0);
}
if (args.includes("--version") || args.includes("-v")) {
  printVersion();
  process.exit(0);
}

// `gloop graph …` — read-only log tooling, never needs the agent.
if (args[0] === "graph") {
  const { runGraphCommand } = await import("../src/core/graph-command.ts");
  process.exit(await runGraphCommand(args.slice(1)));
}

// Prefer local .gloop/src fork if it exists (from --clone self-replication).
// Support both the new layout and legacy pre-reorg layout.
const localEntryNew = join(process.cwd(), ".gloop", "src", "bin", "index.ts");
const localEntryLegacy = join(process.cwd(), ".gloop", "src", "index.ts");
const localEntry = existsSync(localEntryNew)
  ? localEntryNew
  : existsSync(localEntryLegacy)
    ? localEntryLegacy
    : null;
const entryPoint = localEntry ?? `${scriptDir}/index.ts`;

const taskRequest = parseTaskCliArgs(args);
if (taskRequest) {
  process.exit(await runTaskCli(taskRequest));
}

// The running child.  Signals are forwarded to it and we keep waiting for
// it to exit: the agent does its own clean shutdown (a terminal also sends
// SIGINT/SIGHUP to it directly; it treats the duplicate as one request).
let child: ReturnType<typeof Bun.spawn> | null = null;
let stopping = false;
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(sig, () => {
    stopping = true;
    if (child && child.exitCode === null) child.kill(sig);
  });
}

async function spawn(): Promise<number> {
  child = Bun.spawn(["bun", entryPoint, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
    cwd: process.cwd(),
  });

  return await child.exited;
}

if (localEntry) {
  console.log(`Using local fork: ${localEntry}`);
}

// Main loop
while (true) {
  const code = await spawn();

  // A reboot is only a reboot if we weren't asked to stop.
  if (code === REBOOT_EXIT_CODE && !stopping) {
    console.log("Rebooting...");
    await Bun.sleep(100);
    continue;
  }

  process.exit(code);
}
