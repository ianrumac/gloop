/**
 * client.ts — Bun-side client for the browser daemon (daemon/server.ts).
 *
 * gloop's Browser* tools import this by absolute path
 * (/opt/gloop-harness/lib/client.ts inside the container). If the daemon
 * is not running yet (e.g. a tool called from a `gloop --task` sub-agent
 * before run-gloop.sh started it), it is spawned on demand.
 */

const PORT = Number.parseInt(process.env.GLOOP_BROWSER_DAEMON_PORT ?? "7979", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const NODE_BIN = process.env.GLOOP_NODE_BIN ?? "/usr/local/bin/node";
const DAEMON = process.env.GLOOP_BROWSER_DAEMON ?? "/opt/gloop-harness/daemon/server.ts";

async function healthy(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1_000) });
    return res.ok;
  } catch {
    return false;
  }
}

let starting: Promise<void> | null = null;

async function ensureDaemon(): Promise<void> {
  if (await healthy()) return;
  if (!starting) {
    starting = (async () => {
      const proc = Bun.spawn([NODE_BIN, DAEMON], {
        stdout: "ignore",
        stderr: "ignore",
        env: process.env,
      });
      proc.unref();
      for (let i = 0; i < 40; i++) {
        await Bun.sleep(250);
        if (await healthy()) return;
      }
      throw new Error(`browser daemon did not start (${NODE_BIN} ${DAEMON})`);
    })().finally(() => {
      starting = null;
    });
  }
  await starting;
}

export async function callDaemon(tool: string, args: Record<string, string>): Promise<string> {
  await ensureDaemon();
  const res = await fetch(`${BASE}/call`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tool, args }),
    // Generous: a navigation can legitimately take a while.
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json()) as { ok: boolean; output?: string; error?: string };
  if (!body.ok) throw new Error(body.error ?? `browser daemon error (${res.status})`);
  return body.output ?? "";
}
