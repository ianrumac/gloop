import { test, expect, describe } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { projectGraph, linkedLogs } from "@hypen-space/gloop-loop";
import { buildDemoEvents, buildStaticViewer } from "./build-static.ts";

describe("static viewer build", () => {
  test("the demo log is a real multi-agent graph with a spawned child", async () => {
    const events = await buildDemoEvents();
    const g = projectGraph(events);
    expect(g.agents.sort()).toEqual(["coder", "coder/task-9f2c", "planner", "writer"]);
    expect(g.roots).toEqual(["planner:msg_1"]);
    const edges = g.edges.map((e) => `${e.from}→${e.to}:${e.causeType}`).sort();
    expect(edges).toEqual([
      "coder:msg_1→coder/task-9f2c:msg_1:spawn_start",
      "planner:msg_1→coder:msg_1:task_complete",
      "planner:msg_1→writer:msg_1:task_complete",
    ]);
    // Denied confirmation and a retry-free error-free run are both represented.
    expect(events.some((e) => e.type === "confirm_response" && !(e as { ok: boolean }).ok)).toBe(true);
    expect(linkedLogs(events).map((l) => l.direction).sort()).toEqual(["child", "parent"]);
  });

  test("buildStaticViewer writes index.html with the demo embedded and no session data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "gloop-viewer-"));
    try {
      const out = await buildStaticViewer(join(dir, "viewer"));
      expect(out.endsWith(join("viewer", "index.html"))).toBe(true);
      const html = await Bun.file(out).text();
      expect(html).toContain("window.__GLOOP_DEMO__=");
      expect(html).toContain("window.__GLOOP_EVENTS__=[]");
      expect(html).not.toContain("<!--DEMO-->");
      expect(html).not.toContain("<!--APP-->");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
