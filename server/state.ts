// someclaw's own state (the gateway has no archive/tool history). JSON files in SOMECLAW_STATE_DIR, written atomically.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { ForkRef, GatewayEvent, Resume, ToolLog, TurnModel } from "../shared/protocol";

const DIR = process.env.SOMECLAW_STATE_DIR ?? `${process.env.HOME}/.local/state/someclaw`;
mkdirSync(`${DIR}/tools`, { recursive: true, mode: 0o700 });
mkdirSync(`${DIR}/turns`, { recursive: true, mode: 0o700 });
mkdirSync(`${DIR}/inflight`, { recursive: true, mode: 0o700 });

function read<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`state: ${file} unreadable, ignoring:`, e);
    return fallback;
  }
}

function write(file: string, data: string) {
  try {
    writeFileSync(`${file}.tmp`, data, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.error(`state: writing ${file} failed:`, e);
  }
}

export type State = {
  archived: Record<string, string>; // id -> archived at
  seen: Record<string, string>; // id -> last_activity the user has seen
  titled: Record<string, true>; // auto-title done, or renamed by hand: never auto-titled again
  /** Channel sessions are one long thread per contact: retitled on new activity. id -> last_activity + name at titling. */
  channelTitles: Record<string, { at: string; name: string }>;
  previews: Record<string, string>; // first message of conversations started here
  resume: Record<string, Resume>; // rate-limited conversations the broker resumes itself
  /** Session created_at at first sighting. Channel session ids are fixed per contact and come back after a delete:
   * a changed created_at means a new conversation, so its archive/title/preview state is dropped. */
  created: Record<string, string>;
  /** Per-conversation model: provider ref (e.g. anthropic.opus) passed to /ws/chat. Absent = rocky's configured default. */
  models: Record<string, string>;
  /** Latest valid gateway token a browser connected with: lets the broker run turns with no browser open.
   * Same trust level as the browser's localStorage; file is 0600. */
  token: string | null;
};

const FILE = `${DIR}/state.json`;
export const state: State = { archived: {}, seen: {}, titled: {}, channelTitles: {}, previews: {}, created: {}, resume: {}, models: {}, token: null, ...read(FILE, {}) };
// Dropped features' keys in old state files.
for (const k of ["queues", "paused"]) delete (state as Record<string, unknown>)[k];

let timer: Timer | undefined;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => write(FILE, JSON.stringify(state, null, 1)), 200);
}

// Tool logs per conversation, one file each (outputs can be large).
const toolFile = (id: string) => `${DIR}/tools/${encodeURIComponent(id)}.json`;
export const readTools = (id: string): ToolLog[] => read(toolFile(id), []);
/** Reset to here: drops the tool logs of the deleted turns (shown before history[at], so the kept ones are at < keep). */
export function truncateTools(id: string, keep: number) {
  const logs = readTools(id);
  const kept = logs.filter((l) => l.at < keep);
  if (kept.length !== logs.length) write(toolFile(id), JSON.stringify(kept));
}
export function appendTools(id: string, log: ToolLog) {
  if (!log.events.length) return;
  write(toolFile(id), JSON.stringify([...readTools(id), log]));
}

// Model of each finished turn, from its done frame (gateway history doesn't keep it). at: history index of the reply.
const turnFile = (id: string) => `${DIR}/turns/${encodeURIComponent(id)}.json`;
export const readTurns = (id: string): TurnModel[] => read(turnFile(id), []);
export function appendTurn(id: string, t: TurnModel) {
  write(turnFile(id), JSON.stringify([...readTurns(id).filter((x) => x.at !== t.at), t]));
}
export function truncateTurns(id: string, keep: number) {
  const turns = readTurns(id);
  const kept = turns.filter((t) => t.at < keep);
  if (kept.length !== turns.length) write(turnFile(id), JSON.stringify(kept));
}

/** Running turn started here, written as its steps come in: survives a someclaw restart (reattach) and a ZeroClaw
 * restart (resend). Deleted when the turn finishes. */
export type Inflight = {
  id: string;
  /** What the user typed (shown) and what went to the gateway (fork context included). */
  text: string;
  sent: string;
  fork?: ForkRef;
  /** ms epoch the gateway turn started (the resend's, once resent). */
  startedAt: number;
  /** tool_call, tool_result and steer messages so far. */
  events: GatewayEvent[];
  /** Already resent once after a restart: a second cut-off isn't resent. */
  resent: boolean;
};
const inflightFile = (id: string) => `${DIR}/inflight/${encodeURIComponent(id)}.json`;
export const readInflight = (): Inflight[] =>
  readdirSync(`${DIR}/inflight`)
    .filter((f) => f.endsWith(".json"))
    .map((f) => read<Inflight | null>(`${DIR}/inflight/${f}`, null))
    .filter((r): r is Inflight => !!r?.id);
export const writeInflight = (r: Inflight) => write(inflightFile(r.id), JSON.stringify(r));
export const dropInflight = (id: string) => rmSync(inflightFile(id), { force: true });
