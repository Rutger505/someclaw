import { useCallback, useEffect, useRef, useState } from "react";
import { getToken } from "./gateway";

export const AGENT = "rocky";

export type Item =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string; live?: boolean }
  | { kind: "tool"; name: string; args: unknown; output?: string }
  | { kind: "meta"; text: string; error?: boolean };

type Status = "connecting" | "open" | "closed";

/** One /ws/chat connection to `sessionId`. Gateway events: chunk, chunk_reset, message, done, tool_call, tool_result, error, session_start. */
export function useChat(sessionId: string, onUnauthorized: () => void) {
  const [items, setItems] = useState<Item[]>([]);
  const [status, setStatus] = useState<Status>("connecting");
  const [busy, setBusy] = useState(false);
  const ws = useRef<WebSocket>(null);

  const push = (item: Item) => setItems((xs) => [...xs, item]);
  /** Replace or append the live agent reply. */
  const setLive = (fn: (text: string) => string, done = false) =>
    setItems((xs) => {
      const last = xs.at(-1);
      if (last?.kind === "agent" && last.live) return [...xs.slice(0, -1), { kind: "agent", text: fn(last.text), live: !done }];
      const text = fn("");
      return text || !done ? [...xs, { kind: "agent", text, live: !done }] : xs;
    });

  useEffect(() => {
    let stopped = false;
    let retry: Timer | undefined;

    const connect = () => {
      setStatus("connecting");
      const q = new URLSearchParams({ token: getToken() ?? "", session_id: sessionId, agent: AGENT });
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/chat?${q}`);
      ws.current = sock;
      sock.onopen = () => setStatus("open");
      sock.onclose = async (e) => {
        if (stopped) return;
        setStatus("closed");
        setBusy(false);
        setItems((xs) => xs.map((x) => (x.kind === "agent" && x.live ? { ...x, live: false } : x)));
        push({ kind: "meta", text: `closed ${e.code} ${e.reason}`, error: true });
        const auth = await fetch("/api/status", { headers: { authorization: `Bearer ${getToken()}` } }).catch(() => null);
        if (auth?.status === 401) return onUnauthorized();
        retry = setTimeout(connect, 2000);
      };
      sock.onmessage = (e) => {
        const m = JSON.parse(e.data);
        switch (m.type) {
          case "chunk":
            setLive((t) => t + (m.content ?? ""));
            break;
          case "chunk_reset":
            setLive(() => "");
            break;
          case "message":
          case "done": {
            const full = (m.full_response ?? m.content ?? "").trim();
            setLive((t) => full || t.trim(), true);
            if (m.type === "done") setBusy(false);
            break;
          }
          case "tool_call":
            if (m.name) push({ kind: "tool", name: m.name, args: m.args ?? {} });
            break;
          case "tool_result":
            if (!m.name) break;
            setItems((xs) => {
              const i = xs.findLastIndex((x) => x.kind === "tool" && x.name === m.name && x.output === undefined);
              if (i < 0) return [...xs, { kind: "tool", name: m.name, args: {}, output: String(m.output ?? "") }];
              const copy = [...xs];
              copy[i] = { ...(copy[i] as Extract<Item, { kind: "tool" }>), output: String(m.output ?? "") };
              return copy;
            });
            break;
          case "error":
            setBusy(false);
            setLive((t) => t, true);
            push({ kind: "meta", text: `error: ${m.message ?? JSON.stringify(m)}`, error: true });
            break;
          case "session_start":
            push({ kind: "meta", text: `session ${m.resumed ? `resumed (${m.message_count} msgs, not shown)` : "new"} · ${AGENT} · ${sessionId}` });
            break;
          case "thinking":
            break;
          default:
            push({ kind: "meta", text: JSON.stringify(m) });
        }
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, [sessionId]);

  const send = useCallback((text: string) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return push({ kind: "meta", text: "not connected", error: true });
    push({ kind: "user", text });
    setBusy(true);
    ws.current.send(JSON.stringify({ type: "message", content: text }));
  }, []);

  return { items, status, busy, send };
}
