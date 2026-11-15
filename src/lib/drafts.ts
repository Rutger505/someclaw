// Composer drafts, kept on the server (shared by phone and PC) with a localStorage copy for reloads and outages.
// Last write wins: a local edit stays `dirty` until the broker acked it; while dirty, drafts from other browsers are
// ignored for that conversation (ours overwrites them once it lands).
import type { Attachment } from "../../shared/attachments";
import type { Draft } from "../../shared/protocol";

type Local = Draft & { dirty?: true };

const KEY = "drafts";
const EMPTY: Draft = { text: "", files: [] };
const DEBOUNCE_MS = 400;

function load(): Record<string, Local> {
  let all: Record<string, Local> = {};
  try {
    all = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {}
  // Drafts of older versions (draft.<id>, text only, never on the server).
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith("draft.")) continue;
    const text = localStorage.getItem(k) ?? "";
    if (text.trim()) all[k.slice(6)] ??= { text, files: [], dirty: true };
    localStorage.removeItem(k);
  }
  return all;
}
let all = load();
const persist = () => localStorage.setItem(KEY, JSON.stringify(all));

const empty = (d: Draft) => !d.text.trim() && !d.files.length;
const same = (a: Draft, b: Draft) => a.text === b.text && a.files.length === b.files.length && a.files.every((f, i) => f.path === b.files[i]!.path);

const listeners = new Map<string, Set<(d: Draft) => void>>();
const notify = (id: string) => listeners.get(id)?.forEach((f) => f(getDraft(id)));

/** Sends one draft; resolves once the broker has it. Set by useBroker while connected. */
let push: ((id: string, d: Draft) => Promise<void>) | null = null;
const timers = new Map<string, Timer>();

export const getDraft = (id: string): Draft => all[id] ?? EMPTY;

/** Typed here: saved locally right away, to the server debounced (clearing goes out at once). */
export function editDraft(id: string, text: string, files: Attachment[]) {
  if (!id) return;
  const d = { text, files };
  if (same(getDraft(id), d)) return;
  all[id] = { ...d, dirty: true };
  persist();
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => sync(id), empty(d) ? 0 : DEBOUNCE_MS));
}

/** Changed from outside this conversation's composer (e.g. a failed send given back after switching): composer updates too. */
export function editDraftElsewhere(id: string, text: string, files: Attachment[]) {
  editDraft(id, text, files);
  notify(id);
}

function sync(id: string) {
  timers.delete(id);
  const d = all[id];
  if (!d?.dirty || !push) return; // not connected: sent on reconnect (setDrafts)
  push(id, { text: d.text, files: d.files }).then(
    () => {
      if (all[id] !== d) return; // edited meanwhile: that edit syncs itself
      if (empty(d)) delete all[id];
      else all[id] = { text: d.text, files: d.files };
      persist();
    },
    () => {}, // socket dropped: still dirty, sent again on reconnect
  );
}

/** Conversation `id`'s draft changed in another browser (or on the server): applied unless edited here unsynced. */
export function onDraft(id: string, f: (d: Draft) => void) {
  let set = listeners.get(id);
  if (!set) listeners.set(id, (set = new Set()));
  set.add(f);
  return () => void set.delete(f);
}

export function remoteDraft(id: string, d: Draft | null) {
  if (all[id]?.dirty) return;
  if (d && !empty(d)) all[id] = d;
  else if (all[id]) delete all[id];
  else return;
  persist();
  notify(id);
}

/** Connected: the server's drafts replace the clean local ones, unsynced local edits go out. */
export function setDrafts(server: Record<string, Draft>, sender: (id: string, d: Draft) => Promise<void>) {
  push = sender;
  const changed: string[] = [];
  for (const id of new Set([...Object.keys(all), ...Object.keys(server)])) {
    const local = all[id];
    if (local?.dirty) continue;
    const d = server[id];
    if (local && d && same(local, d)) continue;
    if (d) all[id] = d;
    else delete all[id];
    changed.push(id);
  }
  persist();
  changed.forEach(notify);
  for (const [id, d] of Object.entries(all)) if (d.dirty) sync(id);
}

export const disconnectDrafts = () => void (push = null);
