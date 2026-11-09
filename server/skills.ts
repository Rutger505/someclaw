// Pinned skills (shared/protocol.ts, skillBlock): skills rocky read with read_skill in a conversation are sent along
// with the next user message while their current SKILL.md isn't in the history. Pins come from the turns' tool logs
// (so a reset unpins what it deletes), minus skills unpinned by hand since their last read.
import { readdirSync, readFileSync } from "node:fs";
import { skillBlock, type HistoryMessage, type LoadedSkill } from "../shared/protocol";
import { readTools, save, state } from "./state";

const DIR = process.env.SOMECLAW_SKILLS_DIR ?? `${process.env.HOME}/.zeroclaw/agents/rocky/workspace/skills`;
/** Most recently read ones win: caps the tokens a long conversation carries. */
export const MAX_PINNED = 3;

const argName = (args: unknown): string | null => {
  let a = args;
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch {
      return null;
    }
  }
  const n = a && typeof a === "object" ? (a as Record<string, unknown>).name : null;
  return typeof n === "string" && n ? n : null;
};

/** Pinned skill names, oldest read first. */
export function pinnedSkills(id: string): string[] {
  const lastRead = new Map<string, number>();
  for (const log of readTools(id))
    for (const e of log.events)
      if (e.type === "tool_call" && e.name === "read_skill") {
        const name = argName(e.args);
        if (!name) continue;
        lastRead.delete(name); // re-read: moves to the end (most recent)
        lastRead.set(name, log.at);
      }
  const unpinned = state.unpinned[id] ?? {};
  return [...lastRead].filter(([name, at]) => !(name in unpinned) || at >= unpinned[name]!).map(([name]) => name).slice(-MAX_PINNED);
}

/** history: length now; a read after this (reply index >= it) pins the skill again. */
export function unpinSkill(id: string, name: string, history: number) {
  (state.unpinned[id] ??= {})[name] = history;
  save();
}

/** SKILL.md of a skill by its frontmatter name (what read_skill takes), falling back to the directory name. */
function skillFile(name: string): string | null {
  let dirs: string[];
  try {
    dirs = readdirSync(DIR);
  } catch (e) {
    throw new Error(`skills dir ${DIR}: ${(e as Error).message}`);
  }
  let byDir: string | null = null;
  for (const d of dirs) {
    const file = `${DIR}/${d}/SKILL.md`;
    let head: string;
    try {
      head = readFileSync(file, "utf8").slice(0, 500);
    } catch {
      continue;
    }
    const m = /^---\n[\s\S]*?^name:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(head);
    if (m?.[1] === name) return file;
    if (d === name) byDir = file;
  }
  return byDir;
}

const hash = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex").slice(0, 12);

/** Blocks to put before the user's message: pinned skills whose current version isn't in the history yet.
 * history: null when it couldn't be read (everything is sent then: costs tokens, never leaves rocky without the skill). */
export function skillsPrompt(id: string, history: HistoryMessage[] | null): { prefix: string; sent: LoadedSkill[] } {
  const inContext = new Set((history ?? []).flatMap((m) => (m.skills ?? []).map((s) => `${s.name}\n${s.hash}`)));
  let prefix = "";
  const sent: LoadedSkill[] = [];
  for (const name of pinnedSkills(id)) {
    let file: string | null;
    try {
      file = skillFile(name);
    } catch (e) {
      console.error(`skills: ${id}: ${(e as Error).message}`);
      break;
    }
    if (!file) {
      console.warn(`skills: ${id}: pinned skill ${name} not found in ${DIR}, not sent`);
      continue;
    }
    const content = readFileSync(file, "utf8");
    const s = { name, hash: hash(content) };
    if (inContext.has(`${s.name}\n${s.hash}`)) continue;
    prefix += skillBlock(s, content);
    sent.push(s);
  }
  return { prefix, sent };
}
