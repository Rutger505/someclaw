// Browser <-> someclaw server protocol over /someclaw/ws. The server (broker) owns the gateway sockets, so turns,
// queues and status survive tab switches, reloads and closed browsers.

/** Raw gateway /ws/chat event (chunk, chunk_reset, message, done, aborted, tool_call, tool_result, error, session_start, ...),
 * plus `user` for a message the broker sent, so a replayed turn shows it. */
export type GatewayEvent = { type: string; [k: string]: unknown };

export type QueueItem = { qid: string; text: string };

export type ConvStatus = "idle" | "running" | "error";

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
  queue: QueueItem[];
  /** Queue stopped after an error, abort or restart (direct sends still go through). */
  paused: boolean;
  /** When a paused queue resumes on its own (after an error or restart); null = waits for `resume` (after a stop,
   * or when error retries ran out). */
  resumeAt: string | null;
  /** First user message, shown until the auto-title lands. */
  preview: string | null;
  archived: boolean;
  unread: boolean;
  /** Last auto-title failure (e.g. no titler agent); retried after the next turn. */
  titleError: string | null;
};

export type HistoryMessage = { role: "user" | "assistant" | "tool" | string; content: string; created_at: string };

/** Tool events of a finished turn, shown before history[at] (its assistant reply). Gateway /ws/chat history has no tools. */
export type ToolLog = { at: number; events: GatewayEvent[] };

export type ClientMsg =
  | { type: "subscribe"; id: string | null }
  | { type: "send"; id: string; text: string }
  /** Into the running turn right away (the gateway injects it, like OpenClaw's steer): a queued item (qid) or new text.
   * Idle conversation: starts a turn. */
  | { type: "steer"; id: string; qid?: string; text?: string }
  | { type: "unqueue"; id: string; qid: string }
  | { type: "resume"; id: string }
  /** Pause the queue and cancel a pending automatic resume. */
  | { type: "pause"; id: string }
  | { type: "abort"; id: string }
  | { type: "archive"; id: string; archived: boolean }
  | { type: "rename"; id: string; name: string };

export type ServerMsg =
  | { type: "conversations"; list: Conversation[]; listError: string | null }
  /** Sent on subscribe and after each turn: persisted history, tool logs and the events of the running turn so far. */
  | { type: "snapshot"; id: string; history: HistoryMessage[]; tools: ToolLog[]; turn: GatewayEvent[]; historyError: string | null }
  | { type: "event"; id: string; event: GatewayEvent }
  | { type: "error"; message: string }
  | { type: "unauthorized" };

/** The runtime prefixes user messages with the date (gateway: [CURRENT DATE & TIME: ...], channels: [2026-...]); noise in a chat UI. */
export const stripDatePrefix = (s: string) => s.replace(/^\[(CURRENT DATE & TIME: [^\]]*|\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [^\]]*)\]\s*/, "");
