// someclaw's own state (the gateway has no archive/queue/tool history). JSON files in SOMECLAW_STATE_DIR, written atomically.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { QueueItem, ToolLog } from "../shared/protocol";

const DIR = process.env.SOMECLAW_STATE_DIR ?? `${process.env.HOME}/.local/state/someclaw`;
mkdirSync(`${DIR}/tools`, { recursive: true, mode: 0o700 });

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
  titled: Record<string, true>; // auto-title done
  queues: Record<string, QueueItem[]>;
  paused: Record<string, true>; // queue paused after an error, until resumed or a new send
  previews: Record<string, string>; // first message of conversations started here
  /** Latest valid gateway token a browser connected with: lets the broker run queues with no browser open.
   * Same trust level as the browser's localStorage; file is 0600. */
  token: string | null;
};

const FILE = `${DIR}/state.json`;
export const state: State = { archived: {}, seen: {}, titled: {}, queues: {}, paused: {}, previews: {}, token: null, ...read(FILE, {}) };

let timer: Timer | undefined;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => write(FILE, JSON.stringify(state, null, 1)), 200);
}

// Tool logs per conversation, one file each (outputs can be large).
const toolFile = (id: string) => `${DIR}/tools/${encodeURIComponent(id)}.json`;
export const readTools = (id: string): ToolLog[] => read(toolFile(id), []);
export function appendTools(id: string, log: ToolLog) {
  if (!log.events.length) return;
  write(toolFile(id), JSON.stringify([...readTools(id), log]));
}
