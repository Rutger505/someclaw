// Direct writes to the gateway's session store: its API can't truncate a transcript (0.8.7: list, read, append
// assistant, rename, delete). Same table ops as its own rewrite_messages (crates/zeroclaw-infra/src/session_sqlite.rs).
// Open gateway sockets rebuild their history before the next turn when the persisted length changed
// (ws.rs refresh_history_if_advanced); the broker closes its own socket anyway.
import { Database } from "bun:sqlite";

const DB = process.env.ZEROCLAW_SESSIONS_DB ?? `${process.env.HOME}/.zeroclaw/data/sessions/sessions.db`;

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
