// Broker: owns one gateway /ws/chat socket per active conversation, so turns, queues and status survive tab switches,
// reloads and closed browsers. Browsers talk to it over /someclaw/ws (shared/protocol.ts).
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { AGENT, api, chatSocket, GatewayError, tokenValid, type GatewaySession } from "./gateway";
import { appendTools, readTools, save, state } from "./state";
import { generateTitle, TITLE_PREFIX } from "./title";
import {
  stripDatePrefix,
  type ClientMsg,
  type ConvStatus,
  type Conversation,
  type GatewayEvent,
  type HistoryMessage,
  type QueueItem,
  type ServerMsg,
} from "../shared/protocol";

export type Client = { token: string; sub: string | null };

type Conv = {
  id: string;
  status: ConvStatus;
  error: string | null;
  /** Events of the running turn (chunks merged), replayed to browsers that open it mid-turn. */
  turn: GatewayEvent[];
  /** tool_call/tool_result of the running turn, persisted on finish (gateway history has no tools). */
  tools: GatewayEvent[];
  up?: WebSocket;
  upReady?: Promise<WebSocket>;
  idleTimer?: Timer;
  titleError: string | null;
  /** Turn ended, history loading: still "running" for the UI and the queue. */
  finishing?: boolean;
  /** Pending automatic resume of a paused queue (after an error or restart). */
  resumeAt?: number;
  resumeTimer?: Timer;
  /** Consecutive failed turns since the last success; auto-resume gives up after RESUME_BACKOFF_MS runs out. */
  failures: number;
  /** Queue item of this turn not yet handed to the gateway: put back in front if the turn fails before that. */
  unsent?: QueueItem;
  /** The pause came from a user stop: a later successful turn doesn't lift it. */
  stopped?: boolean;
};

// Paused queues resume on their own after an error (backoff per consecutive failure) or a restart.
// A user stop (abort) stays paused: that's an explicit "stop". Out of backoff steps = stays paused until `resume`.
const RESUME_BACKOFF_MS = [10_000, 30_000, 90_000];
const RESUME_AFTER_RESTART_MS = 5_000;

// Gateway allows wss.max_sessions_per_client (8) sockets: close idle ones.
const UPSTREAM_IDLE_MS = 60_000;
const POLL_MS = 5_000;

const convs = new Map<string, Conv>();
const clients = new Set<ServerWebSocket<Client>>();
let sessions: GatewaySession[] = [];
let runningElsewhere = new Set<string>(); // turns started outside someclaw (dashboard, WhatsApp)
let listError: string | null = null;
const titling = new Set<string>();

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const send = (ws: ServerWebSocket<Client>, m: ServerMsg) => ws.send(JSON.stringify(m));
const queue = (id: string) => (state.queues[id] ??= []);
const session = (id: string) => sessions.find((s) => s.session_id === id);
const viewed = (id: string) => [...clients].some((ws) => ws.data.sub === id);

function conv(id: string): Conv {
  let c = convs.get(id);
  if (!c) convs.set(id, (c = { id, status: "idle", error: null, turn: [], tools: [], titleError: null, failures: 0 }));
  return c;
}

function cancelResume(c: Conv) {
  clearTimeout(c.resumeTimer);
  c.resumeTimer = c.resumeAt = undefined;
}

function resume(c: Conv) {
  cancelResume(c);
  c.stopped = false;
  delete state.paused[c.id];
  save();
  broadcastList();
  drain(c);
}

/** Pause the queue; with `delay`, resume it automatically after that. */
function pauseQueue(c: Conv, delay?: number) {
  cancelResume(c);
  state.paused[c.id] = true;
  save();
  if (delay === undefined || !queue(c.id).length) return;
  c.resumeAt = Date.now() + delay;
  c.resumeTimer = setTimeout(() => resume(c), delay);
}

// After a restart the interrupted turns are gone: resume persisted queues shortly (gateway may still be starting;
// a failed turn backs off like any other error).
// Queues already paused before the restart (stop, retries ran out) stay paused; a pause without a queue is dropped.
for (const id of Object.keys(state.paused)) if (!state.queues[id]?.length) delete state.paused[id];
for (const [id, q] of Object.entries(state.queues)) {
  if (state.paused[id]) conv(id).stopped = true;
  else if (q.length) pauseQueue(conv(id), RESUME_AFTER_RESTART_MS);
}

// ---------- conversation list ----------

function toConversation(id: string, s: GatewaySession | undefined): Conversation {
  const c = convs.get(id);
  const status: ConvStatus = c?.status === "running" || runningElsewhere.has(id) ? "running" : (c?.status ?? "idle");
  const now = new Date().toISOString();
  return {
    id,
    name: s?.name ?? null,
    channel: s?.channel_id ?? null,
    created_at: s?.created_at ?? now,
    last_activity: s?.last_activity ?? now,
    message_count: s?.message_count ?? 0,
    status,
    error: c?.error ?? null,
    queue: state.queues[id] ?? [],
    paused: !!state.paused[id],
    resumeAt: c?.resumeAt ? new Date(c.resumeAt).toISOString() : null,
    preview: state.previews[id] ?? null,
    archived: id in state.archived,
    unread: !!s && status !== "running" && s.last_activity > (state.seen[id] ?? "") && !viewed(id),
    titleError: c?.titleError ?? null,
  };
}

function conversations(): Conversation[] {
  const list = sessions.map((s) => toConversation(s.session_id, s)).filter((c) => c.message_count || c.status !== "idle" || c.queue.length);
  // Started here but not listed by the gateway yet.
  for (const c of convs.values())
    if (!session(c.id) && (c.status !== "idle" || queue(c.id).length)) list.push(toConversation(c.id, undefined));
  // Newest first by creation: stable order, so Ctrl+1-9 don't shift while conversations are active.
  return list.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

let listTimer: Timer | undefined;
function broadcastList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => {
    const m: ServerMsg = { type: "conversations", list: conversations(), listError };
    for (const ws of clients) send(ws, m);
  }, 30);
}

function markSeen(id: string) {
  const s = session(id);
  if (s && state.seen[id] !== s.last_activity) {
    state.seen[id] = s.last_activity;
    save();
  }
}

let refreshing: Promise<void> | null = null;
function refresh() {
  return (refreshing ??= (async () => {
    try {
      const token = state.token;
      if (!token) throw new Error("no gateway token yet: open someclaw in a browser and pair");
      const [all, running] = await Promise.all([
        api<{ sessions: GatewaySession[] }>(token, "/api/sessions"),
        api<{ sessions: { session_id: string }[] }>(token, "/api/sessions/running"),
      ]);
      sessions = all.sessions.filter((s) => s.agent_alias === AGENT && !s.session_id.startsWith(TITLE_PREFIX));
      runningElsewhere = new Set(running.sessions.map((s) => s.session_id).filter((id) => convs.get(id)?.status !== "running"));
      for (const s of sessions) {
        // First sighting counts as seen: only activity after that is unread.
        if (!(s.session_id in state.seen) || viewed(s.session_id)) markSeen(s.session_id);
      }
      backfillPreviews();
      backfillTitles();
      listError = null;
    } catch (e) {
      listError = msg(e);
      if (e instanceof GatewayError && e.status === 401) unauthorized();
    } finally {
      refreshing = null;
    }
    broadcastList();
  })());
}
setInterval(() => clients.size && refresh(), POLL_MS);

// Unnamed sessions started elsewhere (or before someclaw kept previews): first user message as the preview.
const previewing = new Set<string>();
function backfillPreviews() {
  for (const s of sessions) {
    const id = s.session_id;
    if (s.name || state.previews[id] || !s.message_count || previewing.has(id)) continue;
    previewing.add(id);
    history(id)
      .then((h) => {
        const first = h.find((m) => m.role === "user");
        if (!first) return;
        state.previews[id] = first.content.slice(0, 200);
        save();
        broadcastList();
      })
      .catch((e) => console.error(`broker: preview ${id}:`, msg(e)))
      .finally(() => previewing.delete(id));
  }
}

function unauthorized() {
  state.token = null;
  save();
  for (const ws of clients) {
    send(ws, { type: "unauthorized" });
    ws.close(4001, "unauthorized");
  }
}

// ---------- history ----------

async function history(id: string): Promise<HistoryMessage[]> {
  if (!state.token) throw new Error("no gateway token");
  const res = await api<{ messages: HistoryMessage[] }>(state.token, `/api/sessions/${encodeURIComponent(id)}/messages`);
  return res.messages.map((m) => (m.role === "user" ? { ...m, content: stripDatePrefix(m.content) } : m));
}

async function snapshot(id: string): Promise<ServerMsg> {
  let h: HistoryMessage[] = [];
  let historyError: string | null = null;
  try {
    h = await history(id);
  } catch (e) {
    historyError = msg(e);
  }
  return { type: "snapshot", id, history: h, tools: readTools(id), turn: convs.get(id)?.turn ?? [], historyError };
}

async function pushSnapshot(id: string) {
  const subs = [...clients].filter((ws) => ws.data.sub === id);
  if (!subs.length) return;
  const m = await snapshot(id);
  for (const ws of subs) if (ws.data.sub === id) send(ws, m);
}

// ---------- turns ----------

function emit(id: string, event: GatewayEvent) {
  for (const ws of clients) if (ws.data.sub === id) send(ws, { type: "event", id, event });
}

function record(c: Conv, event: GatewayEvent) {
  const last = c.turn.at(-1);
  if (event.type === "chunk" && last?.type === "chunk") last.content = String(last.content ?? "") + String(event.content ?? "");
  else c.turn.push({ ...event });
  emit(c.id, event);
}

function upstream(c: Conv): Promise<WebSocket> {
  clearTimeout(c.idleTimer);
  if (c.upReady) return c.upReady;
  if (!state.token) return Promise.reject(new Error("no gateway token: open someclaw in a browser and pair"));
  const up = chatSocket(state.token, c.id);
  c.up = up;
  c.upReady = new Promise((resolve, reject) => {
    up.onopen = () => resolve(up);
    up.onclose = (e) => {
      reject(new Error(`gateway socket closed ${e.code} ${e.reason || "(no reason: bad token, unknown agent or wss.max_sessions_per_client)"}`));
      if (c.up !== up) return;
      c.up = c.upReady = undefined;
      if (c.status === "running") finish(c, "error", `gateway socket closed mid-turn: ${e.code} ${e.reason}`);
    };
  });
  c.upReady.catch(() => {});
  up.onmessage = (e) => {
    try {
      onEvent(c, JSON.parse(String(e.data)));
    } catch (err) {
      console.error(`broker: bad gateway frame for ${c.id}:`, err);
    }
  };
  return c.upReady;
}

function closeWhenIdle(c: Conv) {
  clearTimeout(c.idleTimer);
  c.idleTimer = setTimeout(() => {
    if (c.status !== "running") c.up?.close(1000, "idle");
  }, UPSTREAM_IDLE_MS);
}

function onEvent(c: Conv, m: GatewayEvent) {
  if (m.type === "session_start" || m.type === "thinking") return;
  if (c.status !== "running" || c.finishing) return console.warn(`broker: ${m.type} for idle ${c.id}, dropped`);
  if (m.type === "chunk_reset") {
    c.turn = c.turn.filter((e) => e.type !== "chunk");
    return emit(c.id, m);
  }
  record(c, m);
  if (m.type === "tool_call" || m.type === "tool_result") c.tools.push(m);
  if (m.type === "done") finish(c, "idle");
  else if (m.type === "aborted") finish(c, "idle", null, true);
  else if (m.type === "error") finish(c, "error", String(m.message ?? JSON.stringify(m)));
}

async function finish(c: Conv, status: ConvStatus, error: string | null = null, aborted = false) {
  if (c.status !== "running" || c.finishing) return;
  c.finishing = true;
  const pause = aborted || status === "error";
  if (c.unsent) {
    queue(c.id).unshift(c.unsent);
    c.unsent = undefined;
  }
  if (aborted) {
    pauseQueue(c);
    c.stopped = true;
  } else if (status === "error") {
    if (queue(c.id).length) pauseQueue(c, RESUME_BACKOFF_MS[c.failures++]);
    else pauseQueue(c); // nothing to resume; a later successful turn lifts it
  } else {
    c.failures = 0;
    // a turn went through (e.g. a direct send while paused): an error pause has served its purpose
    if (state.paused[c.id] && !c.stopped) {
      cancelResume(c);
      delete state.paused[c.id];
    }
  }
  const tools = c.tools;
  c.tools = [];
  let h: HistoryMessage[] | null = null;
  for (let i = 0; i < 3 && !h; i++) {
    try {
      h = await history(c.id);
      // the reply may land in the store a moment after `done`
      if (status === "idle" && !pause && h.at(-1)?.role !== "assistant" && i < 2) h = null;
    } catch (e) {
      console.error(`broker: history ${c.id}:`, msg(e));
    }
    if (!h) await Bun.sleep(400);
  }
  if (tools.length) {
    // before this turn's reply (aborts store one too: "[interrupted by user]"), else at the end
    const at = h?.at(-1)?.role === "assistant" ? h.length - 1 : (h?.length ?? 0);
    appendTools(c.id, { at, events: tools });
  }
  c.status = status;
  c.finishing = false;
  c.error = error;
  c.turn = [];
  save();
  await refresh();
  await pushSnapshot(c.id);
  if (h && !pause) autoTitle(c, h);
  drain(c);
}

function drain(c: Conv) {
  if (c.status === "running" || state.paused[c.id]) return closeWhenIdle(c);
  const next = queue(c.id).shift();
  if (!next) return closeWhenIdle(c);
  save();
  startTurn(c, next.text, next);
}

async function startTurn(c: Conv, text: string, from?: QueueItem) {
  c.status = "running";
  c.unsent = from;
  c.error = null;
  c.turn = [];
  c.tools = [];
  if (!session(c.id)?.message_count) state.previews[c.id] ??= text.slice(0, 200);
  save();
  record(c, { type: "user", content: text });
  broadcastList();
  try {
    const up = await upstream(c);
    up.send(JSON.stringify({ type: "message", content: text }));
    c.unsent = undefined;
  } catch (e) {
    record(c, { type: "error", message: msg(e) });
    finish(c, "error", msg(e));
  }
}

// Failed titles retry after TITLE_RETRY_MS (e.g. titler agent missing until zeroclaw-config is merged), not every poll.
const TITLE_RETRY_MS = 10 * 60_000;
const titleFailedAt = new Map<string, number>();

// Untitled conversations that won't get a new turn soon (older ones, failed titles): one at a time, sockets are scarce.
function backfillTitles() {
  if (titling.size || !state.token) return;
  const next = sessions.find(
    (s) =>
      s.message_count >= 2 &&
      !s.name &&
      !s.channel_id &&
      !state.titled[s.session_id] &&
      convs.get(s.session_id)?.status !== "running" &&
      !runningElsewhere.has(s.session_id) &&
      Date.now() - (titleFailedAt.get(s.session_id) ?? 0) > TITLE_RETRY_MS,
  );
  if (!next) return;
  history(next.session_id)
    .then((h) => (h.some((m) => m.role === "assistant") ? autoTitle(conv(next.session_id), h) : undefined))
    .catch((e) => {
      titleFailedAt.set(next.session_id, Date.now());
      console.error(`broker: title backfill ${next.session_id}:`, msg(e));
    });
}

async function autoTitle(c: Conv, h: HistoryMessage[]) {
  const s = session(c.id);
  if (state.titled[c.id] || s?.name || s?.channel_id || titling.has(c.id) || !state.token) return;
  titling.add(c.id);
  try {
    const name = await generateTitle(state.token, c.id, h);
    await api(state.token, `/api/sessions/${encodeURIComponent(c.id)}`, { method: "PUT", body: JSON.stringify({ name }) });
    state.titled[c.id] = true;
    c.titleError = null;
    save();
  } catch (e) {
    c.titleError = msg(e);
    titleFailedAt.set(c.id, Date.now());
    console.error(`broker: auto-title ${c.id}:`, c.titleError);
  } finally {
    titling.delete(c.id);
    refresh();
  }
}

// ---------- browser messages ----------

function readOnly(id: string) {
  const ch = session(id)?.channel_id;
  return ch ? `${ch} conversation: read-only here, /ws/chat can't write into channel sessions` : null;
}

async function handle(ws: ServerWebSocket<Client>, m: ClientMsg) {
  const fail = (message: string) => send(ws, { type: "error", message });
  switch (m.type) {
    case "subscribe":
      ws.data.sub = m.id;
      if (!m.id) return;
      markSeen(m.id);
      broadcastList();
      return send(ws, await snapshot(m.id));

    case "send": {
      const text = m.text.trim();
      if (!text) return;
      const ro = readOnly(m.id);
      if (ro) return fail(ro);
      const c = conv(m.id);
      if (c.status === "running") {
        queue(m.id).push({ qid: crypto.randomUUID(), text });
        save();
        return broadcastList();
      }
      if (queue(m.id).length && !state.paused[m.id]) {
        // idle with a live queue (between turns): keep the order
        queue(m.id).push({ qid: crypto.randomUUID(), text });
        save();
        broadcastList();
        return drain(c);
      }
      return startTurn(c, text); // a paused queue stays paused until `resume`
    }

    case "steer": {
      const ro = readOnly(m.id);
      if (ro) return fail(ro);
      const c = conv(m.id);
      let text = m.text?.trim();
      if (m.qid) {
        const q = queue(m.id);
        const i = q.findIndex((x) => x.qid === m.qid);
        if (i < 0) return fail("queued message not found (already sent?)");
        text = q.splice(i, 1)[0]!.text;
        save();
      }
      if (!text) return;
      if (c.status !== "running") return startTurn(c, text);
      try {
        const up = await upstream(c);
        record(c, { type: "user", content: text, steer: true });
        up.send(JSON.stringify({ type: "message", content: text }));
      } catch (e) {
        fail(`steer: ${msg(e)}`);
      }
      return broadcastList();
    }

    case "unqueue":
      state.queues[m.id] = queue(m.id).filter((x) => x.qid !== m.qid);
      save();
      return broadcastList();

    case "resume":
      conv(m.id).failures = 0;
      return resume(conv(m.id));

    case "pause":
      pauseQueue(conv(m.id));
      conv(m.id).stopped = true;
      return broadcastList();

    case "abort":
      try {
        await api(ws.data.token, `/api/sessions/${encodeURIComponent(m.id)}/abort`, { method: "POST" });
      } catch (e) {
        fail(`abort: ${msg(e)}`);
      }
      return;

    case "archive":
      if (m.archived) state.archived[m.id] = new Date().toISOString();
      else delete state.archived[m.id];
      save();
      return broadcastList();

    case "rename":
      try {
        await api(ws.data.token, `/api/sessions/${encodeURIComponent(m.id)}`, { method: "PUT", body: JSON.stringify({ name: m.name.trim() }) });
        state.titled[m.id] = true;
        save();
        await refresh();
      } catch (e) {
        fail(`rename: ${msg(e)}`);
      }
      return;
  }
}

// ---------- Bun websocket glue ----------

/** Validates the browser's pairing token; the broker keeps the latest valid one to run queues with no browser open. */
export async function authorize(token: string | null) {
  if (!token || !(await tokenValid(token).catch(() => false))) return false;
  if (state.token !== token) {
    state.token = token;
    save();
  }
  return true;
}

export const websocket: WebSocketHandler<Client> = {
  open(ws: ServerWebSocket<Client>) {
    clients.add(ws);
    refresh();
  },
  message(ws: ServerWebSocket<Client>, raw: string | Buffer) {
    let m: ClientMsg;
    try {
      m = JSON.parse(String(raw));
    } catch {
      send(ws, { type: "error", message: `bad message: ${String(raw).slice(0, 100)}` });
      return;
    }
    handle(ws, m).catch((e) => send(ws, { type: "error", message: `${m.type}: ${msg(e)}` }));
  },
  close(ws: ServerWebSocket<Client>) {
    clients.delete(ws);
  },
};
