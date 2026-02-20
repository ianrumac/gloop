/**
 * install-tool.ts — Shared tool installation logic.
 *
 * Fetch a tool from a URL or local path, write it to .gloop/tools/,
 * and reload the registry.
 */

import { join, basename } from "path";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import type { ToolRegistry } from "../src/tools/registry.ts";

export async function installTool(source: string, registry: ToolRegistry): Promise<string> {
  const TOOLS_DIR = join(process.cwd(), ".gloop", "tools");
  await mkdir(TOOLS_DIR, { recursive: true });

  let content: string;
  let filename: string;

  if (source.startsWith("http://") || source.startsWith("https://")) {
    const resp = await fetch(source);
    if (!resp.ok) return `Failed to fetch ${source}: ${resp.status} ${resp.statusText}`;
    content = await resp.text();
    const urlPath = new URL(source).pathname;
    filename = basename(urlPath);
    if (!filename.endsWith(".ts")) filename += ".ts";
  } else {
    const resolved = source.startsWith("/") ? source : join(process.cwd(), source);
    if (!existsSync(resolved)) return `File not found: ${resolved}`;
    content = await Bun.file(resolved).text();
    filename = basename(resolved);
    if (!filename.endsWith(".ts")) filename += ".ts";
  }

  await Bun.write(join(TOOLS_DIR, filename), content);
  const reloadTool = registry.get("Reload");
  const reloadResult = reloadTool ? await reloadTool.execute({}) : "";
  return `Installed ${filename} to .gloop/tools/\n${reloadResult}`;
}
