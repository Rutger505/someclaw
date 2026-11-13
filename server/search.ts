// Full-text search over conversations, read straight from the gateway's session store (its API has no search).
// Only what the UI shows as messages: user messages (hidden blocks stripped) and rocky's replies, no tool calls or
// results. The whole store is a few MB: a LIKE prefilter + JS check per query is milliseconds, no index of our own.
import { Database } from "bun:sqlite";
import { splitAttachments } from "../shared/attachments";
import {
  assistantParts,
  parseCron,
  parseFork,
  parseResent,
  parseResume,
  parseSkills,
  stripDatePrefix,
  type SearchHit,
  type SearchResult,
} from "../shared/protocol";

const DB = process.env.ZEROCLAW_SESSIONS_DB ?? `${process.env.HOME}/.zeroclaw/data/sessions/sessions.db`;
const MAX_HITS = 3; // per conversation, shown under it
const SNIPPET = 140;

let db: Database | null = null;
function open() {
  db ??= new Database(DB, { readonly: true });
  return db;
}

/** Message text as the UI shows it; null = not a message (tool call/result). */
function visible(role: string, content: string): string | null {
  if (role === "user") {
    let t = parseResent(stripDatePrefix(content)).text;
    t = parseFork(parseSkills(t).text).text;
    t = parseResume(t).text;
    const { files, text } = splitAttachments(t);
    return [text, ...files.map((f) => f.name)].filter(Boolean).join(" ") || null;
  }
  if (role === "assistant") return assistantParts(parseCron(content).text).text.trim() || null;
  return null;
}

/** ~SNIPPET chars of single-line text around offset `at`. */
function snippet(flat: string, at: number) {
  const start = Math.max(0, at - 40);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + SNIPPET)}${start + SNIPPET < flat.length ? "…" : ""}`;
}

/** Every term (whitespace-split, case-insensitive) in one message. ids: conversations that may match (the listed ones). */
export function search(q: string, ids: Set<string>): SearchResult[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const longest = terms.reduce((a, b) => (b.length > a.length ? b : a));
  const rows = open()
    .query(
      `SELECT session_key, role, content, at FROM (
         SELECT session_key, role, content, id, ROW_NUMBER() OVER (PARTITION BY session_key ORDER BY id) - 1 AS at FROM sessions
       ) WHERE role IN ('user', 'assistant') AND content LIKE ? ESCAPE '\\' ORDER BY id DESC`,
    )
    .all(`%${longest.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as { session_key: string; role: "user" | "assistant"; content: string; at: number }[];
  const out = new Map<string, SearchResult>();
  for (const r of rows) {
    const id = r.session_key.replace(/^gw_/, "");
    if (!ids.has(id)) continue;
    // markdown emphasis/code/heading marks are noise in a one-line snippet
    const text = visible(r.role, r.content)?.replace(/\*\*|`+|^#{1,6}\s+/gm, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (!terms.every((t) => lower.includes(t))) continue;
    let res = out.get(id);
    if (!res) out.set(id, (res = { id, hits: [], total: 0 }));
    res.total++;
    if (res.hits.length < MAX_HITS) res.hits.push({ at: r.at, role: r.role, snippet: snippet(text, lower.indexOf(terms[0]!)) } satisfies SearchHit);
  }
  return [...out.values()];
}
