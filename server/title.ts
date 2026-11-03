// Auto-titles (like OpenClaw): one turn of a small, tool-less agent in a throwaway session, then PUT the name.
// The agent is defined in zeroclaw-config (agents.titler, cheap model); without it titling fails and the preview stays.
import { api, chatSocket } from "./gateway";
import { stripDatePrefix, type HistoryMessage } from "../shared/protocol";

export const TITLE_PREFIX = "someclaw-title-";
const TITLE_AGENT = process.env.SOMECLAW_TITLE_AGENT ?? "titler";

function ask(token: string, sessionId: string, prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = chatSocket(token, sessionId, TITLE_AGENT);
    const timer = setTimeout(() => { sock.close(); reject(new Error("title: timeout after 60 s")); }, 60_000);
    const end = (fn: () => void) => { clearTimeout(timer); sock.close(); fn(); };
    sock.onopen = () => sock.send(JSON.stringify({ type: "message", content: prompt }));
    sock.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "done") end(() => resolve(String(m.full_response ?? "")));
      if (m.type === "error") end(() => reject(new Error(`title: ${m.message ?? JSON.stringify(m)}`)));
    };
    sock.onclose = (e) => end(() => reject(new Error(`title: socket closed ${e.code} ${e.reason || `(is agent "${TITLE_AGENT}" configured?)`}`)));
  });
}

export function clean(raw: string) {
  const line = raw.trim().split("\n")[0] ?? "";
  return line.replace(/^(title:\s*)/i, "").replace(/^["'`*#\s]+|["'`*.\s]+$/g, "").slice(0, 60);
}

export async function generateTitle(token: string, id: string, history: HistoryMessage[]) {
  const user = history.find((m) => m.role === "user");
  const reply = history.find((m) => m.role === "assistant");
  if (!user) throw new Error("title: no user message yet");
  const prompt = [
    "Write a title for this chat: 2-6 words, same language as the user, no quotes, no trailing punctuation. Reply with only the title.",
    "",
    `User: ${stripDatePrefix(user.content).slice(0, 1500)}`,
    reply ? `Assistant: ${reply.content.slice(0, 1500)}` : "",
  ].join("\n");
  const session = TITLE_PREFIX + id;
  try {
    const title = clean(await ask(token, session, prompt));
    if (!title) throw new Error("title: empty reply");
    return title;
  } finally {
    api(token, `/api/sessions/${encodeURIComponent(session)}`, { method: "DELETE" }).catch(() => {});
  }
}
