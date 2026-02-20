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
