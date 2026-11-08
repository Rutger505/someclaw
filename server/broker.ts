// Broker: owns one gateway /ws/chat socket per active conversation, so turns and status survive tab switches,
// reloads and closed browsers. Browsers talk to it over /someclaw/ws (shared/protocol.ts).
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { AGENT, api, chatSocket, GatewayError, tokenValid, type GatewaySession } from "./gateway";
import { appendTools, appendTurn, readTools, readTurns, save, state, truncateTools, truncateTurns } from "./state";
import { clearDeadTurns, truncateSession } from "./sessions";
import { generateTitle, TITLE_PREFIX } from "./title";
import { rateLimitReset } from "./usage";
import {
  RESUME_TEXT,
  forkPrompt,
  parseFork,
  plainText,
  stripDatePrefix,
  type ClientMsg,
  type ForkRef,
  type ConvStatus,
  type Conversation,
  type GatewayEvent,
  type HistoryMessage,
  type ServerMsg,
} from "../shared/protocol";

export type Client = { token: string; sub: string | null; ua: string };

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
  /** Turn ended, history loading: still "running" for the UI. */
  finishing?: boolean;
  /** model_provider the open gateway socket was opened with ("" = default). */
  upModel?: string;
  /** done frame of the running turn: its model and tokens are stored on finish. */
  done?: GatewayEvent;
  /** When the running turn started and its done frame arrived: the turn's duration. */
  startedAt?: number;
  doneAt?: number;
  /** Last gateway frame of the running turn (or its start): the silence watchdog's clock. */
  lastFrameAt?: number;
  /** tool_call/approval_request frames still waiting for their result: silence is expected then. */
  pending?: number;
};


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
const session = (id: string) => sessions.find((s) => s.session_id === id);
const viewed = (id: string) => [...clients].some((ws) => ws.data.sub === id);

function conv(id: string): Conv {
  let c = convs.get(id);
  if (!c) convs.set(id, (c = { id, status: "idle", error: null, turn: [], tools: [], titleError: null }));
  return c;
}

// ---------- conversation list ----------

function toConversation(id: string, s: GatewaySession | undefined): Conversation {
  const c = convs.get(id);
  const resume = state.resume[id] ?? null;
  const status: ConvStatus =
    c?.status === "running" || runningElsewhere.has(id) ? "running" : resume ? "waiting" : (c?.status ?? "idle");
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
    preview: state.previews[id] ?? null,
    archived: id in state.archived,
    unread: !!s && status !== "running" && s.last_activity > (state.seen[id] ?? "") && !viewed(id),
    titleError: c?.titleError ?? null,
    resume: status === "waiting" ? resume : null,
  };
}

function conversations(): Conversation[] {
  const list = sessions.map((s) => toConversation(s.session_id, s)).filter((c) => c.message_count || c.status !== "idle");
  // Started here but not listed by the gateway yet.
  for (const c of convs.values())
    if (!session(c.id) && c.status !== "idle") list.push(toConversation(c.id, undefined));
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
      if (runningElsewhere.size) await clearDead(token);
      for (const s of sessions) {
        forgetIfRecreated(s);
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

// Turns the gateway still lists as running after a crash/restart (it doesn't reset them): they never finish, so the
// conversation would look busy forever. Only checked while something runs outside someclaw.
async function clearDead(token: string) {
  try {
    const { daemon_started_at } = await api<{ daemon_started_at: string }>(token, "/api/status");
    const dead = clearDeadTurns(daemon_started_at);
    if (!dead.length) return;
    console.error(`broker: turns killed by a gateway restart (${daemon_started_at}), marked failed: ${dead.join(", ")}`);
    for (const id of dead) {
      runningElsewhere.delete(id);
      const c = conv(id);
      if (c.status !== "running") {
        c.status = "error";
        c.error = `turn died: ZeroClaw restarted at ${daemon_started_at} while it ran (no reply was stored)`;
      }
    }
  } catch (e) {
    console.error("broker: dead-turn check:", msg(e));
  }
}

function forgetIfRecreated(s: GatewaySession) {
  const id = s.session_id;
  const known = state.created[id];
  if (known === s.created_at) return;
  if (known) {
    console.log(`broker: ${id} recreated (created ${known} -> ${s.created_at}): dropping its archive, title and preview state`);
    delete state.archived[id];
    delete state.titled[id];
    delete state.channelTitles[id];
    delete state.previews[id];
  }
  state.created[id] = s.created_at;
  save();
}

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
  return res.messages.map((m) => {
    if (m.role !== "user") return m;
    const { text, fork } = parseFork(stripDatePrefix(m.content));
    return fork ? { ...m, content: text, fork } : { ...m, content: text };
  });
}

async function snapshot(id: string): Promise<ServerMsg> {
  let h: HistoryMessage[] = [];
  let historyError: string | null = null;
  try {
    h = await history(id);
  } catch (e) {
    historyError = msg(e);
  }
  return { type: "snapshot", id, history: h, tools: readTools(id), turns: readTurns(id), turn: convs.get(id)?.turn ?? [], historyError, model: state.models[id] ?? null };
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

/** Gateway socket of a conversation. The model is fixed per socket: a changed choice reopens it between turns. */
function upstream(c: Conv): Promise<WebSocket> {
  clearTimeout(c.idleTimer);
  const model = state.models[c.id] ?? "";
  if (c.upReady && c.upModel !== model && c.status !== "running") dropUpstream(c, "model changed");
  if (c.upReady) return c.upReady;
  if (!state.token) return Promise.reject(new Error("no gateway token: open someclaw in a browser and pair"));
  const up = chatSocket(state.token, c.id, model || undefined);
  c.up = up;
  c.upModel = model;
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
      const m = JSON.parse(String(e.data)) as GatewayEvent;
      if (c.up === up && !QUIET_FRAMES.has(String(m.type))) c.lastFrameAt = Date.now();
      onEvent(c, m);
    } catch (err) {
      console.error(`broker: bad gateway frame for ${c.id}:`, err);
    }
  };
  return c.upReady;
}

function dropUpstream(c: Conv, reason: string) {
  clearTimeout(c.idleTimer);
  c.up?.close(1000, reason);
  c.up = c.upReady = undefined;
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
  if (m.type === "tool_call" || m.type === "approval_request") c.pending = (c.pending ?? 0) + 1;
  if (m.type === "tool_result" || m.type === "sop_approval_result") c.pending = Math.max(0, (c.pending ?? 0) - 1);
  if (m.type === "done") {
    c.done = m;
    c.doneAt = Date.now();
    resumeAttempts.delete(c.id);
    finish(c, "idle");
  }
  else if (m.type === "aborted") finish(c, "idle", null, true);
  else if (m.type === "error") {
    // raw frame, so rate-limit/quota errors can be matched on later (journalctl --user -u someclaw | grep gateway-error)
    console.error(`broker: gateway-error ${c.id}: ${JSON.stringify(m)}`);
    const error = String(m.message ?? JSON.stringify(m));
    finish(c, "error", error).then(() => {
      if (/rate.?limit/i.test(`${m.code ?? ""} ${error}`)) scheduleResume(c.id);
    });
  }
}

async function finish(c: Conv, status: ConvStatus, error: string | null = null, aborted = false) {
  if (c.status !== "running" || c.finishing) return;
  c.finishing = true;
  const failed = aborted || status === "error";
  const tools = c.tools;
  c.tools = [];
  const done = c.done;
  c.done = undefined;
  let h: HistoryMessage[] | null = null;
  for (let i = 0; i < 3 && !h; i++) {
    try {
      h = await history(c.id);
      // the reply may land in the store a moment after `done`
      if (!failed && h.at(-1)?.role !== "assistant" && i < 2) h = null;
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
  if (done && h?.at(-1)?.role === "assistant") {
    // configured ref the turn started on; served ref/model differ on a fallback
    const ran = String(done.provider ?? "");
    const provider = String(done.last_serving_provider_ref ?? done.provider_ref ?? ran);
    const model = String(done.last_serving_model ?? done.model ?? "");
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    const usage = Array.isArray(done.usage_by_provider) ? (done.usage_by_provider as Record<string, unknown>[]) : [];
    const cached = usage.reduce<number | undefined>((sum, u) => (num(u.cached_input_tokens) === undefined ? sum : (sum ?? 0) + num(u.cached_input_tokens)!), undefined);
    const ms = c.startedAt && c.doneAt ? c.doneAt - c.startedAt : undefined;
    appendTurn(c.id, { at: h.length - 1, provider, model, input: num(done.input_tokens), cached, output: num(done.output_tokens), ms });
    const asked = c.upModel;
    if (asked && ran && ran !== asked) {
      status = "error";
      error = `model: asked for ${asked}, ZeroClaw ran ${ran}. The gateway ignored model_provider on /ws/chat (needs the per-conversation model patch).`;
    }
  }
  c.status = status;
  c.finishing = false;
  c.error = error;
  c.turn = [];
  save();
  await refresh();
  await pushSnapshot(c.id);
  if (h && !failed) autoTitle(c, h);
  closeWhenIdle(c);
}

/** `fork`: first turn of a conversation continuing a channel session; `context` is that session's transcript. */
async function startTurn(c: Conv, text: string, fork?: { ref: ForkRef; context: string }) {
  c.status = "running";
  c.error = null;
  c.turn = [];
  c.tools = [];
  c.lastFrameAt = c.startedAt = Date.now();
  c.doneAt = undefined;
  c.pending = 0;
  if (!session(c.id)?.message_count) state.previews[c.id] ??= text.slice(0, 200);
  save();
  record(c, fork ? { type: "user", content: text, fork: fork.ref } : { type: "user", content: text });
  broadcastList();
  try {
    const up = await upstream(c);
    up.send(JSON.stringify({ type: "message", content: fork ? forkPrompt(fork.ref, fork.context, text) : text }));
  } catch (e) {
    record(c, { type: "error", message: msg(e) });
    finish(c, "error", msg(e));
  }
}

// ---------- silence watchdog ----------
// A turn whose gateway goes quiet (no text, no tool call, no thinking) for SILENCE_MS is stuck: seen as conversations
// that looked busy forever. Aborted and marked failed. Not while a tool runs or waits for approval (tools have their
// own timeouts). Generous: one long reply (e.g. writing a big file) streams nothing until its tool call arrives.

const SILENCE_MS = Number(process.env.SOMECLAW_SILENCE_MS) || 10 * 60_000;
// Socket/handshake frames: not a sign the turn is alive.
const QUIET_FRAMES = new Set(["session_start", "connected", "connect"]);

setInterval(() => {
  const now = Date.now();
  for (const c of convs.values())
    if (c.status === "running" && !c.finishing && !c.pending && now - (c.lastFrameAt ?? now) > SILENCE_MS) stalled(c);
}, Math.min(15_000, SILENCE_MS / 2));

async function stalled(c: Conv) {
  const after = SILENCE_MS >= 120_000 ? `${Math.round(SILENCE_MS / 60_000)} min` : `${Math.round(SILENCE_MS / 1000)} s`;
  const error = `no response from the gateway for ${after} (no text, no tool calls): turn aborted by someclaw`;
  console.error(`broker: ${c.id}: ${error}`);
  record(c, { type: "error", message: error });
  // Fresh socket for the next turn; the closed one's onclose ignores it (c.up already replaced).
  dropUpstream(c, "stalled");
  finish(c, "error", error);
  if (state.token)
    await api(state.token, `/api/sessions/${encodeURIComponent(c.id)}/abort`, { method: "POST" }).catch((e) =>
      console.error(`broker: abort stalled ${c.id}:`, msg(e)),
    );
}

// ---------- auto-resume after rate limits ----------
// ZeroClaw gives up on a 429 within seconds and drops the reset headers; the reset time comes from Anthropic's
// usage endpoint (server/usage.ts). No reset from Anthropic: short fixed retry. Hard cap on attempts either way,
// we don't keep hammering on our own guesses. Waits survive restarts (state.resume).

const RESUME_MARGIN_MS = 60_000; // after the reported reset
const FALLBACK_RETRY_MS = 5 * 60_000; // no reset time from Anthropic (short limit, or usage endpoint failed)
const MAX_RESUME_ATTEMPTS = 3;
const MAX_TIMER_MS = 2 ** 31 - 1;
const resumeTimers = new Map<string, Timer>();
const resumeAttempts = new Map<string, number>();

async function scheduleResume(id: string) {
  const attempt = (resumeAttempts.get(id) ?? 0) + 1;
  if (attempt > MAX_RESUME_ATTEMPTS) {
    console.error(`broker: resume ${id}: still rate-limited after ${MAX_RESUME_ATTEMPTS} attempts, giving up`);
    resumeAttempts.delete(id);
    const c = convs.get(id);
    if (c && c.status === "error") {
      c.error = `${c.error ?? "rate limited"} (auto-resume gave up after ${MAX_RESUME_ATTEMPTS} attempts)`;
      broadcastList();
    }
    return;
  }
  resumeAttempts.set(id, attempt);
  let at: number;
  let reason: string;
  try {
    const reset = await rateLimitReset();
    if (reset) {
      at = Math.max(Date.parse(reset.at), Date.now()) + RESUME_MARGIN_MS;
      reason = `${reset.window} usage at 100%, resets ${reset.at}`;
    } else {
      at = Date.now() + FALLBACK_RETRY_MS;
      reason = "no usage window full (short rate limit): retry in 5 min";
    }
  } catch (e) {
    at = Date.now() + FALLBACK_RETRY_MS;
    reason = `reset time unknown (${msg(e)}): retry in 5 min`;
  }
  if (convs.get(id)?.status === "running") return; // user started a new turn meanwhile
  state.resume[id] = { at: new Date(at).toISOString(), reason, attempt, max: MAX_RESUME_ATTEMPTS };
  save();
  console.log(`broker: resume ${id} at ${state.resume[id].at} (attempt ${attempt}/${MAX_RESUME_ATTEMPTS}): ${reason}`);
  armResume(id);
  broadcastList();
}

function armResume(id: string) {
  clearTimeout(resumeTimers.get(id));
  const r = state.resume[id];
  if (!r) return;
  const delay = Math.max(0, Date.parse(r.at) - Date.now());
  resumeTimers.set(
    id,
    setTimeout(() => (delay > MAX_TIMER_MS ? armResume(id) : resumeNow(id)), Math.min(delay, MAX_TIMER_MS)),
  );
}

function resumeNow(id: string) {
  resumeTimers.delete(id);
  if (!state.resume[id]) return;
  resumeAttempts.set(id, Math.max(resumeAttempts.get(id) ?? 0, state.resume[id].attempt));
  delete state.resume[id];
  save();
  const c = conv(id);
  if (c.status === "running") return;
  console.log(`broker: resuming ${id}`);
  startTurn(c, RESUME_TEXT);
}

function cancelResume(id: string) {
  clearTimeout(resumeTimers.get(id));
  resumeTimers.delete(id);
  resumeAttempts.delete(id);
  if (!state.resume[id]) return false;
  delete state.resume[id];
  save();
  return true;
}

for (const id of Object.keys(state.resume)) armResume(id);

// Failed titles retry after TITLE_RETRY_MS (e.g. titler agent missing until zeroclaw-config is merged), not every poll.
const TITLE_RETRY_MS = 10 * 60_000;
const titleFailedAt = new Map<string, number>();

// Untitled conversations that won't get a new turn soon (older ones, failed titles): one at a time, sockets are scarce.
function backfillTitles() {
  if (titling.size || !state.token) return;
  const next = sessions.find(
    (s) =>
      s.message_count >= 2 &&
      !state.titled[s.session_id] &&
      (s.channel_id ? channelNeedsTitle(s) : !s.name) &&
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

// Channel sessions: one thread per contact, so the title follows the latest topic. Retitled once activity settled.
// Kept: renamed here (titled) or in the official dashboard after our last title. A name from before we tracked it is replaced.
const CHANNEL_SETTLE_MS = 2 * 60_000;
function channelNeedsTitle(s: GatewaySession) {
  const t = state.channelTitles[s.session_id];
  if (t && s.name && s.name !== t.name) return false;
  return t?.at !== s.last_activity && Date.now() - Date.parse(s.last_activity.replace(/(\.\d{3})\d+/, "$1")) > CHANNEL_SETTLE_MS;
}

async function autoTitle(c: Conv, h: HistoryMessage[]) {
  const s = session(c.id);
  const channel = !!s?.channel_id;
  if (state.titled[c.id] || (s?.name && !channel) || (channel && !channelNeedsTitle(s!)) || titling.has(c.id) || !state.token) return;
  titling.add(c.id);
  try {
    const name = await generateTitle(state.token, c.id, h, channel);
    await api(state.token, `/api/sessions/${encodeURIComponent(c.id)}`, { method: "PUT", body: JSON.stringify({ name }) });
    if (channel) state.channelTitles[c.id] = { at: s!.last_activity, name };
    else state.titled[c.id] = true;
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

// ---------- forks ----------

// Context for a fork: the channel thread's latest messages, oldest dropped first to stay under the caps.
const FORK_MAX_MESSAGES = 60;
const FORK_MAX_CHARS = 40_000;
const FORK_MAX_MESSAGE_CHARS = 4_000;

function transcript(h: HistoryMessage[]) {
  const lines: string[] = [];
  let chars = 0;
  for (const m of h.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool").reverse()) {
    const text = plainText(m);
    if (!text) continue;
    const content = text.length > FORK_MAX_MESSAGE_CHARS ? `${text.slice(0, FORK_MAX_MESSAGE_CHARS)} [...]` : text;
    const line = `${m.role === "user" ? "User" : m.role === "tool" ? "Tool" : "Assistant"} (${m.created_at}): ${content}`;
    if (lines.length >= FORK_MAX_MESSAGES || chars + line.length > FORK_MAX_CHARS) break;
    lines.unshift(line);
    chars += line.length;
  }
  return { text: lines.join("\n\n"), messages: lines.length };
}

// ---------- browser messages ----------

function readOnly(id: string) {
  const ch = session(id)?.channel_id;
  return ch ? `${ch} conversation: read-only here (/ws/chat can't write into channel sessions); send it as a fork instead` : null;
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

    // No queue: a message while rocky works goes straight into the running turn (steer, the gateway folds it in).
    case "send": {
      const text = m.text.trim();
      if (!text) return;
      const ro = readOnly(m.id);
      if (ro) return fail(ro);
      const c = conv(m.id);
      // Turn just ended (loading history): injecting now would land after `done`. Wait it out, then start a turn.
      for (let i = 0; c.finishing && i < 100; i++) await Bun.sleep(100);
      if (c.status !== "running") {
        cancelResume(m.id); // a new message replaces the pending resume
        return startTurn(c, text);
      }
      try {
        const up = await upstream(c);
        record(c, { type: "user", content: text, steer: true });
        up.send(JSON.stringify({ type: "message", content: text }));
      } catch (e) {
        fail(`steer: ${msg(e)}`);
      }
      return broadcastList();
    }

    case "fork": {
      const text = m.text.trim();
      if (!text) return;
      const src = session(m.from);
      if (!src?.channel_id) return fail(`fork: ${m.from} is not a channel conversation`);
      if (session(m.id) || convs.get(m.id)?.status === "running") return fail(`fork: conversation ${m.id} already exists`);
      const context = transcript(await history(m.from));
      return startTurn(conv(m.id), text, { ref: { id: m.from, channel: src.channel_id, messages: context.messages }, context: context.text });
    }

    case "abort":
      if (cancelResume(m.id)) return broadcastList();
      try {
        await api(ws.data.token, `/api/sessions/${encodeURIComponent(m.id)}/abort`, { method: "POST" });
      } catch (e) {
        fail(`abort: ${msg(e)}`);
      }
      return;

    case "archive":
      console.log(`broker: ${m.archived ? "archive" : "unarchive"} ${m.id} (${ws.data.ua})`);
      if (m.archived) state.archived[m.id] = new Date().toISOString();
      else delete state.archived[m.id];
      save();
      return broadcastList();

    // Reset to here: history after history[keep - 1] is deleted, the model's context included.
    case "reset": {
      const ro = readOnly(m.id);
      if (ro) return fail(`reset: ${ro}`);
      await refresh();
      const c = conv(m.id);
      if (c.status === "running" || c.finishing || runningElsewhere.has(m.id)) return fail("reset: a turn is running, stop it first");
      cancelResume(m.id);
      // Fresh gateway socket for the next turn: it seeds from the truncated transcript.
      dropUpstream(c, "reset");
      try {
        const deleted = truncateSession(m.id, m.keep, m.seen);
        truncateTools(m.id, m.keep);
        truncateTurns(m.id, m.keep);
        console.log(`broker: reset ${m.id} to ${m.keep} messages, ${deleted} deleted (${ws.data.ua})`);
      } catch (e) {
        fail(`reset: ${msg(e)}`);
      }
      c.error = null;
      await refresh();
      return pushSnapshot(m.id);
    }

    case "model": {
      if (m.ref !== null && !/^[\w-]+\.[\w-]+$/.test(m.ref)) return fail(`model: bad provider ref ${JSON.stringify(m.ref)}`);
      if (readOnly(m.id)) return fail(`model: ${readOnly(m.id)}`);
      if (m.ref) state.models[m.id] = m.ref;
      else delete state.models[m.id];
      save();
      console.log(`broker: model ${m.id} -> ${m.ref ?? "default"} (${ws.data.ua})`);
      // Idle: reopen now-ish (next turn). Running: the turn keeps its model, upstream() reopens before the next one.
      const c = convs.get(m.id);
      if (c?.up && c.status !== "running") dropUpstream(c, "model changed");
      return pushSnapshot(m.id);
    }

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

/** Validates the browser's pairing token; the broker keeps the latest valid one to finish turns with no browser open. */
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
