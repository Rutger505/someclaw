import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMsg, Conversation, GatewayEvent, ServerMsg, ToolLog, HistoryMessage, TurnModel } from "../../shared/protocol";
import { getToken } from "./gateway";

export type Snapshot = { id: string; history: HistoryMessage[]; tools: ToolLog[]; turns: TurnModel[]; turn: GatewayEvent[]; historyError: string | null; model: string | null };
export type Link = "connecting" | "open" | "closed";

/** One /someclaw/ws socket to the broker: conversation list for the sidebar + the open conversation. */
export function useBroker(openId: string, onUnauthorized: () => void) {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [link, setLink] = useState<Link>("connecting");
  const [errors, setErrors] = useState<{ at: number; message: string }[]>([]);
  const ws = useRef<WebSocket>(null);
  const openRef = useRef(openId);
  openRef.current = openId;

  const send = useCallback((m: ClientMsg) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return setErrors((e) => [...e, { at: Date.now(), message: `not connected (${m.type} dropped)` }]);
    ws.current.send(JSON.stringify(m));
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry: Timer | undefined;
    const connect = () => {
      setLink("connecting");
      const q = new URLSearchParams({ token: getToken() ?? "" });
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/someclaw/ws?${q}`);
      ws.current = sock;
      sock.onopen = () => {
        setLink("open");
        sock.send(JSON.stringify({ type: "subscribe", id: openRef.current } satisfies ClientMsg));
      };
      sock.onclose = async (e) => {
        if (stopped) return;
        setLink("closed");
        // The upgrade's 401 is invisible here: ask over REST.
        const auth = await fetch("/api/status", { headers: { authorization: `Bearer ${getToken()}` } }).catch(() => null);
        if (auth?.status === 401 || e.code === 4001) return onUnauthorized();
        setErrors((x) => [...x, { at: Date.now(), message: `broker socket closed ${e.code} ${e.reason}, reconnecting` }]);
        retry = setTimeout(connect, 2000);
      };
      sock.onmessage = (e) => {
        const m: ServerMsg = JSON.parse(e.data);
        switch (m.type) {
          case "conversations":
            setList(m.list);
            setListError(m.listError);
            break;
          case "snapshot":
            if (m.id === openRef.current) setSnap(m);
            break;
          case "event":
            if (m.id !== openRef.current) break;
            setSnap((s) => {
              if (!s || s.id !== m.id) return s;
              const ev = m.event;
              if (ev.type === "chunk_reset") return { ...s, turn: s.turn.filter((x) => x.type !== "chunk") };
              const last = s.turn.at(-1);
              if (ev.type === "chunk" && last?.type === "chunk")
                return { ...s, turn: [...s.turn.slice(0, -1), { ...last, content: String(last.content ?? "") + String(ev.content ?? "") }] };
              return { ...s, turn: [...s.turn, ev] };
            });
            break;
          case "error":
            setErrors((x) => [...x, { at: Date.now(), message: m.message }]);
            break;
          case "unauthorized":
            stopped = true;
            onUnauthorized();
            break;
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, []);

  useEffect(() => {
    setSnap(null);
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "subscribe", id: openId } satisfies ClientMsg));
  }, [openId]);

  const dismissError = (at: number) => setErrors((x) => x.filter((e) => e.at !== at));
  return { list, listError, snap, link, errors, dismissError, send };
}
