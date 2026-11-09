// Browser <-> someclaw server protocol over /someclaw/ws. The server (broker) owns the gateway sockets, so turns
// and status survive tab switches, reloads and closed browsers.

/** Raw gateway /ws/chat event (chunk, chunk_reset, message, done, aborted, tool_call, tool_result, error, session_start,
 * ask_user, ...), plus `user` for a message the broker sent and `ask_user_answered` for an answer it passed on, so a
 * replayed turn shows them. */
export type GatewayEvent = { type: string; [k: string]: unknown };

/** waiting = rate-limited, the broker resumes the turn itself at `resume.at`. */
export type ConvStatus = "idle" | "running" | "error" | "waiting";

export type Resume = {
  at: string;
  /** What `at` is based on: usage window that is full (e.g. seven_day), or why the fixed interval is used. */
  reason: string;
  attempt: number;
  /** Attempts before the broker gives up (absent in waits saved by older versions). */
  max?: number;
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
  /** Resent by the broker after a ZeroClaw restart cut its first try off (content is then only what the user typed). */
  resent?: Resent;
  /** Assistant message the broker posted with a cron job's run result (content is then only the run's output). */
  cron?: CronRun;
  /** Pinned skills the broker sent along with this user message (content is then only what the user typed). */
  skills?: LoadedSkill[];
};

/** A skill's SKILL.md as sent along; hash: of its content, so a changed skill is sent again. */
export type LoadedSkill = { name: string; hash: string };

/** A run of a cron job created in this conversation (server/cron.ts). */
export type CronRun = { job: string; name: string | null; run: number; status: string; at: string };

/** steps: tool calls of the cut-off try passed along as context; restarted: ZeroClaw's new start time. */
export type Resent = { steps: number; restarted: string };

/** Tool events of a finished turn, shown before history[at] (its assistant reply). Gateway /ws/chat history has no tools. */
export type ToolLog = { at: number; events: GatewayEvent[] };

/** Model that answered history[at], from the turn's done frame. provider: serving provider ref (e.g. anthropic.opus).
 * Tokens summed over the turn's model calls (input includes cached); ms: send to done. Absent in turns saved before. */
export type TurnModel = { at: number; provider: string; model: string; input?: number; cached?: number; output?: number; ms?: number };

/** A configured provider profile (providers.models.<family>.<alias>). ref = "<family>.<alias>". */
export type ModelOption = { ref: string; family: string; alias: string; model: string };

export type ClientMsg =
  | { type: "subscribe"; id: string | null }
  /** Idle: starts a turn. Running: steers, i.e. goes into the running turn right away (the gateway folds it in);
   * answers rocky's open ask_user question instead when there is one. */
  | { type: "send"; id: string; text: string }
  /** Answer the running turn's ask_user question (gateway ask_user frame, zeroclaw-patches 0003). */
  | { type: "answer"; id: string; request_id: string; answer: string }
  /** Continue read-only channel session `from` in new conversation `id`: `text` plus that thread as context. */
  | { type: "fork"; from: string; id: string; text: string }
  /** Running: stops the turn. Waiting: cancels the auto-resume. */
  | { type: "abort"; id: string }
  | { type: "archive"; id: string; archived: boolean }
  | { type: "rename"; id: string; name: string }
  /** Model for this conversation's next turns; null = rocky's default. */
  | { type: "model"; id: string; ref: string | null }
  /** Stop sending a pinned skill along (pinned again when rocky reads it again). */
  | { type: "unpin"; id: string; name: string }
  /** Reset to here: keep history[0..keep), delete everything after. `seen`: history length the browser showed. */
  | { type: "reset"; id: string; keep: number; seen: number };

export type ServerMsg =
  | { type: "conversations"; list: Conversation[]; listError: string | null }
  /** Sent on subscribe and after each turn: persisted history, tool logs and the events of the running turn so far. */
  | { type: "snapshot"; id: string; history: HistoryMessage[]; tools: ToolLog[]; turns: TurnModel[]; turn: GatewayEvent[]; historyError: string | null;
      /** Chosen model provider ref; null = rocky's default (agents.rocky.model_provider). */
      model: string | null;
      /** Skills pinned in this conversation (read_skill earlier on), sent along with the next message when not in context. */
      skills: string[] }
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

/** Channel sessions store tool-using turns natively, as JSON in content:
 * assistant {content, reasoning_content?, tool_calls: [{id, name, arguments}]}, tool {content, tool_call_id}. */
export type NativeCall = { id: string; name: string; args: unknown };

const json = (s: string): Record<string, unknown> | null => {
  if (!s.startsWith("{")) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
};

/** Assistant content: plain text, or a native tool-call turn (reasoning dropped, it's an opaque signature). */
export function assistantParts(content: string): { text: string; calls: NativeCall[] } {
  const v = json(content);
  if (!v || !("tool_calls" in v || "reasoning_content" in v)) return { text: content, calls: [] };
  const calls = (Array.isArray(v.tool_calls) ? v.tool_calls : []).map((c: Record<string, unknown>) => {
    const raw = c.arguments;
    let args: unknown = raw ?? {};
    if (typeof raw === "string") args = json(raw) ?? raw;
    return { id: String(c.id ?? ""), name: String(c.name ?? "?"), args };
  });
  return { text: typeof v.content === "string" ? v.content : "", calls };
}

/** Tool message content: native result, or null when it isn't one. */
export function toolResult(content: string): { id: string; output: string } | null {
  const v = json(content);
  if (!v || !("tool_call_id" in v)) return null;
  return { id: String(v.tool_call_id), output: typeof v.content === "string" ? v.content : JSON.stringify(v.content) };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)} [...]` : s);

/** One history message as transcript text (fork context, titles); null = nothing worth showing. */
export function plainText(m: HistoryMessage, tools = true): string | null {
  if (m.role === "assistant") {
    const { text, calls } = assistantParts(m.content);
    const parts = [text.trim(), ...(tools ? calls.map((c) => `[tool ${c.name}: ${clip(typeof c.args === "string" ? c.args : JSON.stringify(c.args), 300)}]`) : [])];
    return parts.filter(Boolean).join("\n") || null;
  }
  if (m.role === "tool") {
    if (!tools) return null;
    const r = toolResult(m.content);
    return `[result: ${clip((r?.output ?? m.content).trim(), 500)}]`;
  }
  return m.content;
}

// ---------- resend after a ZeroClaw restart ----------
// A restart kills the running turn and the gateway stores nothing of it (not even the prompt). The broker resends the
// prompt once, with the steps the cut-off try already ran, so it continues instead of redoing them. The UI hides the block.

const CUT_RE = /^<cut-off-turn steps="(\d+)" restarted="([^"]*)">[\s\S]*?<\/cut-off-turn>\n\n/;
const CUT_CLOSE = "</cut-off-turn>";
const RESEND_MAX_ARG = 1_500;
const RESEND_MAX_OUTPUT = 2_000;
const RESEND_MAX_CHARS = 40_000;

export function resendPrompt(sent: string, events: GatewayEvent[], restarted: string): { content: string; steps: number } {
  const lines: string[] = [];
  let steps = 0;
  for (const e of events) {
    if (e.type === "tool_call") {
      steps++;
      const args = typeof e.args === "string" ? e.args : JSON.stringify(e.args ?? {});
      lines.push(`Tool call ${String(e.name ?? "?")}: ${clip(args, RESEND_MAX_ARG)}`);
    } else if (e.type === "tool_result") lines.push(`Result: ${clip(String(e.output ?? "").trim(), RESEND_MAX_OUTPUT)}`);
    else if (e.type === "user") lines.push(`User, mid-turn: ${String(e.content ?? "")}`);
  }
  // oldest dropped first
  let kept = lines;
  let chars = lines.reduce((n, l) => n + l.length + 1, 0);
  while (kept.length && chars > RESEND_MAX_CHARS) chars -= kept.shift()!.length + 1;
  const dropped = lines.length - kept.length;
  const intro = steps
    ? `[someclaw] Your previous try at the message below was cut off: ZeroClaw restarted (${restarted}) while it ran, and nothing of it was stored. These steps already ran (outputs shortened). Don't redo them blindly: check what's done if unsure, then continue and finish the reply. A tool call without a result was cut off mid-run: check whether it took effect.`
    : `[someclaw] Your previous try at the message below was cut off: ZeroClaw restarted (${restarted}) before it ran any tool. Answer it now.`;
  const body = [intro, ...(dropped ? [`[${dropped} earlier lines omitted]`] : []), ...kept].join("\n\n").replaceAll(CUT_CLOSE, "");
  return { content: `<cut-off-turn steps="${steps}" restarted="${restarted}">\n${body}\n${CUT_CLOSE}\n\n${sent}`, steps };
}

export function parseResent(content: string): { text: string; resent?: Resent } {
  const m = CUT_RE.exec(content);
  if (!m) return { text: content };
  return { text: content.slice(m[0].length), resent: { steps: Number(m[1]), restarted: m[2]! } };
}

// ---------- cron results ----------
// The gateway delivers cron output only to channels (WhatsApp, ...), never back to a /ws/chat conversation. The broker
// posts each run of a job created in a conversation into it as an assistant message, so the model sees it too.

const CRON_RE = /^<cron-run job="([^"]*)" name="([^"]*)" run="(\d+)" status="([^"]*)" at="([^"]*)">\n(?:\[someclaw\][^\n]*\n\n)?([\s\S]*)\n<\/cron-run>$/;
const attr = (s: string) => s.replace(/[<>"\n]/g, " ");

export function cronMessage(r: CronRun, output: string) {
  // The transcript has no tool calls: without this line the model doesn't know it created the job.
  const intro = `[someclaw] Run result of cron job ${r.name ? `"${r.name}" ` : ""}(${r.job}), which you created earlier in this conversation. Posted here by someclaw when it ran; not written by you.`;
  return `<cron-run job="${attr(r.job)}" name="${attr(r.name ?? "")}" run="${r.run}" status="${attr(r.status)}" at="${attr(r.at)}">\n${intro.replaceAll("\n", " ")}\n\n${output.replaceAll("</cron-run>", "</cron_run>")}\n</cron-run>`;
}

export function parseCron(content: string): { text: string; cron?: CronRun } {
  const m = CRON_RE.exec(content);
  if (!m) return { text: content };
  return { text: m[6]!, cron: { job: m[1]!, name: m[2] || null, run: Number(m[3]), status: m[4]!, at: m[5]! } };
}

// ---------- pinned skills ----------
// ZeroClaw's /ws/chat history keeps no tool results: a SKILL.md rocky read with read_skill is gone the next turn, so it
// reads it again every turn. The broker sends the skills read in a conversation along with the next user message, once
// (it stays in the history), and again only when the skill changed or the block is gone (reset). The UI hides the block.

const SKILL_RE = /^<loaded-skill name="([^"]*)" hash="([^"]*)">[\s\S]*?<\/loaded-skill>\n\n/;
const SKILL_CLOSE = "</loaded-skill>";

export function skillBlock(s: LoadedSkill, content: string) {
  const intro = `[someclaw] Full SKILL.md of skill "${s.name}", which you read earlier in this conversation (read_skill results don't stay in the history). Sent along by someclaw, current version: no need to read_skill it again.`;
  return `<loaded-skill name="${attr(s.name)}" hash="${attr(s.hash)}">\n${intro}\n\n${content.replaceAll(SKILL_CLOSE, "</loaded_skill>").trim()}\n${SKILL_CLOSE}\n\n`;
}

export function parseSkills(content: string): { text: string; skills?: LoadedSkill[] } {
  const skills: LoadedSkill[] = [];
  let text = content;
  for (let m = SKILL_RE.exec(text); m; m = SKILL_RE.exec(text)) {
    skills.push({ name: m[1]!, hash: m[2]! });
    text = text.slice(m[0].length);
  }
  return skills.length ? { text, skills } : { text };
}
