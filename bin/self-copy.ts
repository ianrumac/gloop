/**
 * self-copy.ts — Copy gloop source code into .gloop/ for self-modification
 *
 * Uses recursive filtered copy instead of a hardcoded file list.
 */

import { existsSync, readdirSync, symlinkSync } from "fs";
import { join, resolve } from "path";
import { mkdir } from "fs/promises";

const EXCLUDE_DIRS = new Set(["node_modules", ".git", "test", "benchmarks", ".gloop", "bun.lock"]);
const EXCLUDE_PATTERNS = [/\.test\.tsx?$/];

function shouldExclude(name: string, isDir: boolean): boolean {
  if (isDir) return EXCLUDE_DIRS.has(name);
  return EXCLUDE_PATTERNS.some(p => p.test(name));
}

async function copyDirFiltered(src: string, dest: string): Promise<number> {
  await mkdir(dest, { recursive: true });
  let count = 0;

  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (shouldExclude(entry.name, entry.isDirectory())) continue;

    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);

    if (entry.isDirectory()) {
      count += await copyDirFiltered(srcPath, destPath);
    } else if (entry.isFile()) {
      const content = await Bun.file(srcPath).text();
      await Bun.write(destPath, content);
      count++;
    }
  }
  return count;
}

export async function ensureSelfCopy() {
  const srcDir = join(process.cwd(), ".gloop", "src");
  if (existsSync(srcDir)) return;

  const sourceDir = resolve(import.meta.dirname, "..");
  console.log("Copying gloop source into .gloop/src/ for self-modification...");
  const copied = await copyDirFiltered(sourceDir, srcDir);

  // Symlink node_modules so the fork shares the same React/Ink instances
  const sourceModules = resolve(sourceDir, "node_modules");
  const destModules = join(srcDir, "node_modules");
  if (existsSync(sourceModules) && !existsSync(destModules)) {
    symlinkSync(sourceModules, destModules, "dir");
  }

  console.log(`Copied ${copied} files to .gloop/src/`);
  console.log("Use Reboot to reload changes.");
}
