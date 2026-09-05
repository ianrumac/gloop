/**
 * server.ts — gloop browser daemon.
 *
 * A tiny HTTP server (Node) that owns the Playwright-over-CDP session and
 * executes Browser* actions on behalf of gloop's tools, which run under Bun
 * (Playwright's bundled WebSocket client does not connect under Bun, so the
 * session lives here). Requests are serialised: one browser action at a time.
 *
 *   node /opt/gloop-harness/daemon/server.ts          # listens on 127.0.0.1:7979
 *   POST /call  {"tool": "BrowserClick", "args": {"ref": "e12"}}
 *               -> {"ok": true, "output": "..."} | {"ok": false, "error": "..."}
 *   GET  /health
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { actions } from "./actions.ts";

const PORT = Number.parseInt(process.env.GLOOP_BROWSER_DAEMON_PORT ?? "7979", 10);
const HOST = "127.0.0.1";

let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(json) });
  res.end(json);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/health") {
      reply(res, 200, { ok: true, tools: Object.keys(actions) });
      return;
    }
    if (req.method === "POST" && req.url === "/call") {
      const { tool, args } = JSON.parse((await readBody(req)) || "{}") as { tool?: string; args?: Record<string, string> };
      const action = tool ? actions[tool] : undefined;
      if (!action) {
        reply(res, 404, { ok: false, error: `Unknown browser action: ${tool}` });
        return;
      }
      const started = Date.now();
      try {
        const output = await serialised(() => action(args ?? {}));
        console.log(`[daemon] ${tool} ok ${Date.now() - started}ms`);
        reply(res, 200, { ok: true, output });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`[daemon] ${tool} error ${Date.now() - started}ms: ${message.split("\n")[0]}`);
        reply(res, 200, { ok: false, error: message });
      }
      return;
    }
    reply(res, 404, { ok: false, error: "not found" });
  } catch (err) {
    reply(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[daemon] gloop browser daemon listening on http://${HOST}:${PORT} (CDP ${process.env.CLAWBENCH_BROWSER_CDP_URL ?? "http://127.0.0.1:9222"})`);
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
