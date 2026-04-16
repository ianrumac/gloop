import { parseSkillMarkdown, type Skill } from "@hypen-space/gloop-loop";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";

/**
 * Default skill roots relative to the working directory (later entries override
 * earlier ones when the same skill `name` appears in more than one root).
 */
export const DEFAULT_SKILL_SEARCH_ROOTS: readonly string[] = [
  ".claude/skills",
  ".agent/skills",
  ".gloop/skills",
];

/**
 * Discover `SKILL.md` skills under each root: `<root>/<skill-dir>/SKILL.md`.
 * Missing roots are skipped. Same `name` from a later root replaces an earlier one.
 */
export async function discoverSkills(
  cwd: string,
  roots: readonly string[] = DEFAULT_SKILL_SEARCH_ROOTS,
): Promise<Skill[]> {
  const byName = new Map<string, Skill>();

  for (const rel of roots) {
    const base = join(cwd, rel);
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }

    for (const dirName of entries) {
      const dir = join(base, dirName);
      const skillPath = join(dir, "SKILL.md");
      let raw: string;
      try {
        raw = await readFile(skillPath, "utf8");
      } catch {
        continue;
      }

      const parsed = parseSkillMarkdown(raw, dirName);
      byName.set(parsed.name, {
        name: parsed.name,
        description: parsed.description,
        dir,
        body: parsed.body,
      });
    }
  }

  return [...byName.values()];
}
