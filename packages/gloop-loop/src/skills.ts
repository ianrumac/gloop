/**
 * Agent Skills (Agent Skills / Claude Code–style) — types and helpers.
 *
 * Skill directories contain `SKILL.md` with optional YAML frontmatter and
 * markdown instructions. The host discovers skills on disk; the loop merges
 * skill **names and descriptions** into the system prompt and resolves
 * `/skill-name` input as a user turn with the skill body (after substitutions).
 * The host may also register **InvokeSkill** so the model can load the same
 * body via a tool call.
 */

import { parse as parseYaml } from "yaml";
import type { ToolDefinition } from "./tools/types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * One discovered skill (directory + parsed `SKILL.md`).
 *
 * - `name` / `description` come from frontmatter (or directory name / first paragraph).
 * - `body` is markdown after frontmatter, for `/name` invocation.
 */
export interface Skill {
  /** Slash name without leading `/`; lowercase letters, numbers, hyphens. */
  name: string;
  /** Short description for the system prompt listing. */
  description: string;
  /** Absolute path to the skill directory (contains `SKILL.md`). */
  dir: string;
  /** Markdown body after frontmatter (no leading `---`). */
  body: string;
}
// ============================================================================
// Parse SKILL.md
// ============================================================================

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

function firstParagraphFromMarkdown(md: string): string {
  const t = md.trim();
  if (!t) return "";
  const block = t.split(/\n\n+/)[0] ?? t;
  return block.replace(/\s+/g, " ").trim().slice(0, 500);
}

function normalizeName(raw: string | undefined, fallbackDirName: string): string {
  const s = (raw ?? fallbackDirName).trim().toLowerCase();
  return s.replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || fallbackDirName;
}

export interface ParsedSkillMarkdown {
  name: string;
  description: string;
  body: string;
}

/**
 * Parse a `SKILL.md` file's text into name, description, and body.
 * `dirName` is the parent directory name (used when `name` is omitted in frontmatter).
 */
export function parseSkillMarkdown(content: string, dirName: string): ParsedSkillMarkdown {
  const m = content.match(FRONTMATTER_RE);
  let body: string;
  let meta: Record<string, unknown> = {};

  if (m) {
    try {
      meta = (parseYaml(m[1] ?? "") as Record<string, unknown>) ?? {};
    } catch {
      meta = {};
    }
    body = m[2] ?? "";
  } else {
    body = content;
  }

  const name = normalizeName(
    typeof meta.name === "string" ? meta.name : undefined,
    dirName,
  );

  let descRaw = "";
  if (typeof meta.description === "string") descRaw = meta.description.trim();
  if (typeof meta.when_to_use === "string") {
    const w = meta.when_to_use.trim();
    descRaw = descRaw ? `${descRaw} ${w}` : w;
  }

  const description =
    descRaw.trim() ||
    firstParagraphFromMarkdown(body) ||
    `Skill "${name}"`;

  return { name, description, body: body.trimEnd() };
}

/**
 * Resolve a skill by user- or model-supplied name (normalized like `SKILL.md` `name:`).
 */
export function findSkill(skills: Skill[], name: string): Skill | undefined {
  const t = name.trim();
  if (!t) return undefined;
  const key = normalizeName(t, t);
  return skills.find((s) => s.name === key);
}

// ============================================================================
// System prompt section
// ============================================================================

/**
 * Append a short listing of available skills so the model knows names and when to use them.
 */
export function mergeSkillsIntoSystem(base: string | undefined, skills: Skill[]): string {
  const prefix = (base ?? "").trimEnd();
  if (!skills.length) return prefix;

  const lines = skills.map(
    (s) => `- /${s.name} — ${s.description}`,
  );
  const block = [
    "",
    "==== AVAILABLE SKILLS ====",
    "Skills can assist you with a specific tasks and provide you with more abilities and informations on certain topics and tasks.",
    "The user may invoke a skill with /skill-name [arguments]. When a user message starts with /, treat it as a skill invocation (unless it is a built-in slash command).",
    "You can load the full skill text yourself by calling the InvokeSkill tool with the same name and optional arguments (equivalent to a slash invocation).",
    "If a skill references a file with a relative path, you can check for its existance in the skill folder",
    "Available project skills:",
    ...lines,
    "",
  ].join("\n");

  return prefix ? `${prefix}${block}` : block.trimStart();
}

/**
 * Text for the `/skills` built-in slash command (list names and descriptions).
 */
export function formatSkillsListing(skills: Skill[] | undefined): string {
  if (!skills?.length) {
    return "No skills are loaded. The host configures which skill directories to scan.";
  }
  const lines = skills.map((s) => `  /${s.name} — ${s.description}`);
  return [
    "Project skills:",
    ...lines,
    "",
    "Use /skill-name, /skill <name>, or InvokeSkill to load full instructions.",
  ].join("\n");
}

// ============================================================================
// Slash invocation + substitution
// ============================================================================

/** Shell-style split respecting double quotes. */
export function splitSkillArguments(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && /\s/.test(c)) {
      if (cur.length) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += c;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * Apply Claude-style `$ARGUMENTS`, `$N`, `$ARGUMENTS[n]` substitutions.
 * Does not run shell commands (`!`...`); gloop does not inject shell output here.
 */
export function applySkillSubstitutions(body: string, args: string): string {
  const parts = splitSkillArguments(args);
  const full = args.trim();

  let s = body;
  for (let i = 0; i < parts.length; i++) {
    const reN = new RegExp(`\\$${i}\\b`, "g");
    const reBracket = new RegExp(`\\$ARGUMENTS\\[${i}\\]`, "g");
    s = s.replace(reN, parts[i]!).replace(reBracket, parts[i]!);
  }
  s = s.replace(/\$ARGUMENTS\b/g, full);

  const hasAnyArgPlaceholder =
    /\$ARGUMENTS\b/.test(body) ||
    /\$ARGUMENTS\[\d+\]/.test(body) ||
    /\$\d+\b/.test(body);

  if (!hasAnyArgPlaceholder && full.trim()) {
    s = `${s.trimEnd()}\n\nARGUMENTS: ${full}`;
  }
  return s;
}

export interface SkillSlashMatch {
  skill: Skill;
  /** Raw argument string after the command (after first split). */
  args: string;
}

/**
 * If `input` is `/skill-name ...` and matches a skill, return it; otherwise `null`.
 * `cmd` must be the first token including leading `/`, e.g. `/deploy`.
 */
export function matchSkillSlash(input: string, skills: Skill[] | undefined): SkillSlashMatch | null {
  if (!skills?.length) return null;
  const t = input.trim();
  if (!t.startsWith("/")) return null;

  const space = t.search(/\s/);
  const cmd = space === -1 ? t : t.slice(0, space);
  const rest = space === -1 ? "" : t.slice(space + 1).trim();

  const name = cmd.slice(1);
  if (!name) return null;

  const skill = findSkill(skills, name);
  if (!skill) return null;

  return { skill, args: rest };
}

/**
 * Build the Think input for a skill slash invocation.
 */
export function skillInvocationToThinkInput(match: SkillSlashMatch): string {
  return applySkillSubstitutions(match.skill.body, match.args);
}

/**
 * `/skill <name> [arguments]` — same body as `/<name> [arguments]`.
 * `rest` is the text after the `/skill` token (name + optional args).
 * Returns `null` if the skill is not found or no skills are loaded.
 */
export function thinkInputFromSkillSubcommand(rest: string, skills: Skill[] | undefined): string | null {
  if (!skills?.length) return null;
  const t = rest.trim();
  if (!t) return null;
  const sp = t.search(/\s/);
  const name = (sp === -1 ? t : t.slice(0, sp)).trim();
  const args = sp === -1 ? "" : t.slice(sp + 1).trim();
  if (!name) return null;
  const skill = findSkill(skills, name);
  if (!skill) return null;
  return applySkillSubstitutions(skill.body, args);
}

/**
 * Tool for the model to load a skill's full body (same rendering as `/skill-name`).
 * Returns `null` when there are no skills — the host should not register it.
 */
export function createInvokeSkillTool(skills: Skill[]): ToolDefinition | null {
  if (!skills.length) return null;

  return {
    name: "InvokeSkill",
    description:
      "Load a project skill by name and return its full instructions (the SKILL.md body after frontmatter). Use when the task matches a skill under AVAILABLE SKILLS or you need that playbook. Same content as /skill-name, /skill <name>, or InvokeSkill with the same arguments.",
    arguments: [
      {
        name: "name",
        description: "Skill name without slash (must match AVAILABLE SKILLS), e.g. deploy",
      },
      {
        name: "arguments",
        description:
          "Optional argument string for $ARGUMENTS, $0, $1, etc. (same as text after /skill-name).",
      },
    ],
    execute: async (args) => {
      const skill = findSkill(skills, args.name ?? "");
      if (!skill) {
        const list = skills.map((s) => s.name).join(", ");
        return `Unknown skill "${(args.name ?? "").trim()}". Available: ${list}`;
      }
      return applySkillSubstitutions(skill.body, args.arguments ?? "");
    },
  };
}
