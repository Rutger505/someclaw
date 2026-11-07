// Direct writes to the gateway's session store: its API can't truncate a transcript (0.8.7: list, read, append
// assistant, rename, delete). Same table ops as its own rewrite_messages (crates/zeroclaw-infra/src/session_sqlite.rs).
// Open gateway sockets rebuild their history before the next turn when the persisted length changed
// (ws.rs refresh_history_if_advanced); the broker closes its own socket anyway.
import { Database } from "bun:sqlite";

const DB = process.env.ZEROCLAW_SESSIONS_DB ?? `${process.env.HOME}/.zeroclaw/data/sessions/sessions.db`;

// Gateway timestamps carry nanoseconds; Date.parse wants at most milliseconds.
export const parseTime = (s: string) => Date.parse(s.replace(/(\.\d{3})\d+/, "$1"));

/** Gateway 0.8.7 never resets turn state on startup (list_stuck_sessions exists, unused): turns killed by a crash or
 * restart stay "running" in /api/sessions/running forever, and abort says no_active_response. Marks running turns that
 * started before the daemon did as failed, like its own error path (set_session_state "error"). Returns the session ids. */
export function clearDeadTurns(daemonStartedAt: string): string[] {
  const started = parseTime(daemonStartedAt);
  if (!Number.isFinite(started)) throw new Error(`bad daemon_started_at ${JSON.stringify(daemonStartedAt)}`);
  const db = new Database(DB, { readwrite: true, create: false });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return db.transaction(() => {
      const rows = db.query("SELECT session_key, turn_id, turn_started_at FROM session_metadata WHERE state = 'running'").all() as {
        session_key: string;
        turn_id: string | null;
        turn_started_at: string | null;
      }[];
      const dead = rows.filter((r) => !r.turn_started_at || parseTime(r.turn_started_at) < started);
      for (const r of dead)
        db.run("UPDATE session_metadata SET state = 'error', turn_started_at = NULL WHERE session_key = ? AND state = 'running' AND turn_id IS ?", [
          r.session_key,
          r.turn_id,
        ]);
      return dead.map((r) => r.session_key.replace(/^gw_/, ""));
    }).immediate();
  } finally {
    db.close();
  }
}

/** Keeps the first `keep` messages of session `id`, deletes the rest. `seen`: history length the user saw, so a
 * transcript that moved meanwhile isn't cut at the wrong place. Returns how many messages were deleted. */
export function truncateSession(id: string, keep: number, seen: number): number {
  if (!Number.isInteger(keep) || keep < 1 || keep > seen) throw new Error(`bad reset point: keep ${keep} of ${seen}`);
  const db = new Database(DB, { readwrite: true, create: false });
  try {
    db.run("PRAGMA busy_timeout = 5000");
    return db.transaction(() => {
      const exists = (k: string) => !!db.query("SELECT 1 FROM session_metadata WHERE session_key = ?").get(k);
      const key = exists(id) ? id : exists(`gw_${id}`) ? `gw_${id}` : null;
      if (!key) throw new Error(`session ${id} not found in ${DB}`);
      const ids = (db.query("SELECT id FROM sessions WHERE session_key = ? ORDER BY id ASC").all(key) as { id: number }[]).map((r) => r.id);
      if (ids.length !== seen) throw new Error(`history changed meanwhile (${ids.length} messages stored, ${seen} shown): reload and retry`);
      const deleted = db.run("DELETE FROM sessions WHERE session_key = ? AND id > ?", [key, ids[keep - 1]!]).changes;
      db.run("UPDATE session_metadata SET message_count = ? WHERE session_key = ?", [keep, key]);
      return deleted;
    }).immediate();
  } finally {
    db.close();
  }
}
