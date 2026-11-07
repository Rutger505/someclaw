// Browser <-> someclaw server protocol over /someclaw/ws. The server (broker) owns the gateway sockets, so turns
// and status survive tab switches, reloads and closed browsers.

/** Raw gateway /ws/chat event (chunk, chunk_reset, message, done, aborted, tool_call, tool_result, error, session_start, ...),
 * plus `user` for a message the broker sent, so a replayed turn shows it. */
export type GatewayEvent = { type: string; [k: string]: unknown };

/** waiting = rate-limited, the broker resumes the turn itself at `resume.at`. */
export type ConvStatus = "idle" | "running" | "error" | "waiting";

export type Resume = {
  at: string;
  /** What `at` is based on: usage window that is full (e.g. seven_day), or why the fixed interval is used. */
  reason: string;
  attempt: number;
};

export type Conversation = {
  id: string;
  name: string | null;
  /** Non-null for channel sessions (e.g. whatsapp.default): read-only here, /ws/chat can't write into them. */
  channel: string | null;
  created_at: string;
  last_activity: string;
  message_count: number;
  status: ConvStatus;
  /** Last error of this conversation, until the next turn starts. */
  error: string | null;
  /** First user message, shown until the auto-title lands. */
  preview: string | null;
  archived: boolean;
  unread: boolean;
  /** Last auto-title failure (e.g. no titler agent); retried after the next turn. */
  titleError: string | null;
  /** Set while status is "waiting". */
  resume: Resume | null;
};

/** A conversation continued from a read-only channel session: its first message carries that thread as context. */
export type ForkRef = { id: string; channel: string; messages: number };

export type HistoryMessage = {
  role: "user" | "assistant" | "tool" | string;
  content: string;
  created_at: string;
  /** User message that continued a channel session (content is then only what the user typed). */
  fork?: ForkRef;
};

/** Tool events of a finished turn, shown before history[at] (its assistant reply). Gateway /ws/chat history has no tools. */
export type ToolLog = { at: number; events: GatewayEvent[] };

export type ClientMsg =
  | { type: "subscribe"; id: string | null }
  /** Idle: starts a turn. Running: steers, i.e. goes into the running turn right away (the gateway folds it in). */
  | { type: "send"; id: string; text: string }
  /** Continue read-only channel session `from` in new conversation `id`: `text` plus that thread as context. */
  | { type: "fork"; from: string; id: string; text: string }
  /** Running: stops the turn. Waiting: cancels the auto-resume. */
  | { type: "abort"; id: string }
  | { type: "archive"; id: string; archived: boolean }
  | { type: "rename"; id: string; name: string }
  /** Reset to here: keep history[0..keep), delete everything after. `seen`: history length the browser showed. */
  | { type: "reset"; id: string; keep: number; seen: number };

export type ServerMsg =
  | { type: "conversations"; list: Conversation[]; listError: string | null }
  /** Sent on subscribe and after each turn: persisted history, tool logs and the events of the running turn so far. */
  | { type: "snapshot"; id: string; history: HistoryMessage[]; tools: ToolLog[]; turn: GatewayEvent[]; historyError: string | null }
  | { type: "event"; id: string; event: GatewayEvent }
  | { type: "error"; message: string }
  | { type: "unauthorized" };

/** The runtime prefixes user messages with the date (gateway: [CURRENT DATE & TIME: ...], channels: [2026-...]); noise in a chat UI. */
export const stripDatePrefix = (s: string) => s.replace(/^\[(CURRENT DATE & TIME: [^\]]*|\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [^\]]*)\]\s*/, "");

/** Sent by the broker to resume a rate-limited turn (the failed message is already in the history). */
export const RESUME_TEXT = "[someclaw] Rate limit reset: continue where you left off.";

// Fork context block, first thing in the forked conversation's first message. The model reads it; the UI hides it.
const FORK_OPEN = (r: ForkRef) => `<continued-from id="${r.id}" channel="${r.channel}" messages="${r.messages}">`;
const FORK_CLOSE = "</continued-from>";
const FORK_RE = /^<continued-from id="([^"]*)" channel="([^"]*)" messages="(\d+)">[\s\S]*?<\/continued-from>\n\n/;

export function forkPrompt(ref: ForkRef, transcript: string, text: string) {
  const intro = `Earlier conversation from the ${ref.channel} channel. The user continues it here, in a web chat: your replies go to this chat, not to ${ref.channel}.`;
  return `${FORK_OPEN(ref)}\n${intro}\n\n${transcript.replaceAll(FORK_CLOSE, "")}\n${FORK_CLOSE}\n\n${text}`;
}

export function parseFork(content: string): { text: string; fork?: ForkRef } {
  const m = FORK_RE.exec(content);
  if (!m) return { text: content };
  return { text: content.slice(m[0].length), fork: { id: m[1]!, channel: m[2]!, messages: Number(m[3]) } };
}
