#!/usr/bin/env bun
/**
 * gloop launcher — spawns the agent as a child process and handles restarts.
 *
 * When the child exits with code 75 (reboot), it respawns automatically.
 * Any other exit code is propagated to the parent.
 */

import { parseTaskCliArgs, runTaskSubagent } from "../src/core/task-mode.ts";
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
  --debug              Enable debug logs to .gloop/debug.log.
  --help, -h           Show this help and exit.
  --version, -v        Show the installed version and exit.

ENVIRONMENT
  OPENROUTER_API_KEY   Required.  Your OpenRouter API key.

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

  # Debug logging
  gloop --debug

INTERACTIVE SESSION
  Enter          Submit message
  Esc            Interrupt the current turn (loop stays alive)
  Ctrl+C         Exit

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
  const result = await runTaskSubagent(taskRequest, { cwd: process.cwd() });
  if (result.success) {
    console.log(result.summary);
    process.exit(0);
  }

  console.error(`Task mode failed: ${result.summary}`);
  if (result.stderr) console.error(result.stderr);
  if (result.stdout) console.error(result.stdout);
  process.exit(result.exitCode === 0 ? 1 : result.exitCode);
}

async function spawn(): Promise<number> {
  const child = Bun.spawn(["bun", entryPoint, ...args], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
    cwd: process.cwd(),
  });

  const code = await child.exited;
  return code;
}

if (localEntry) {
  console.log(`Using local fork: ${localEntry}`);
}

// Main loop
while (true) {
  const code = await spawn();

  if (code === REBOOT_EXIT_CODE) {
    console.log("Rebooting...");
    await Bun.sleep(100);
    continue;
  }

  process.exit(code);
}
