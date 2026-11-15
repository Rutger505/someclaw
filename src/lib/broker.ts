import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMsg, Delivered, Conversation, GatewayEvent, ServerMsg, ToolLog, HistoryMessage, TurnModel, Usage, SearchResult } from "../../shared/protocol";
import { getToken } from "./gateway";
import { cacheGet, cachePut } from "./cache";
import { onAway } from "./away";

/** stale: from the page-load cache (src/lib/cache.ts), the broker's fresh one hasn't arrived yet. */
export type Snapshot = { stale?: true } & { id: string; history: HistoryMessage[]; tools: ToolLog[]; turns: TurnModel[]; turn: GatewayEvent[]; historyError: string | null; model: string | null; skills: string[] };
export type Link = "connecting" | "open" | "closed";
export type Search = { q: string; results: SearchResult[]; error: string | null; loading: boolean };

const ACK_MS = 8000;

/** One /someclaw/ws socket to the broker: conversation list for the sidebar + the open conversation. */
export function useBroker(openId: string, onUnauthorized: () => void) {
  const [list, setList] = useState<Conversation[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [link, setLink] = useState<Link>("connecting");
  const [usage, setUsage] = useState<Usage | null>(null);
  const [found, setFound] = useState<Search | null>(null);
  const seq = useRef(0);
  const [errors, setErrors] = useState<{ at: number; message: string; link?: true }[]>([]);
  const ws = useRef<WebSocket>(null);
  const openRef = useRef(openId);
  openRef.current = openId;

  const send = useCallback((m: ClientMsg) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return setErrors((e) => [...e, { at: Date.now(), message: `not connected (${m.type} dropped)` }]);
    ws.current.send(JSON.stringify(m));
  }, []);

  // Composer messages until the broker acks them. A phone that slept or switched networks can keep a dead socket
  // that still reads OPEN: no ack in ACK_MS closes it, which rejects everything unacked (and reconnects).
  const kill = useRef<(sock: WebSocket) => void>(() => {});
  const unacked = useRef(new Map<string, { resolve: () => void; reject: (e: Error) => void }>());
  const lose = (why: string) => {
    for (const p of unacked.current.values()) p.reject(new Error(why));
    unacked.current.clear();
  };
  /** Sends a composer message; resolves once the broker has it, rejects (error shown) when it may not have. */
  const deliver = useCallback((m: ClientMsg & Delivered): Promise<void> => {
    const sock = ws.current;
    const fail = (why: string) => {
      setErrors((e) => [...e, { at: Date.now(), message: `${m.type} not sent (${why}): put back in the composer` }]);
      return Promise.reject(new Error(why));
    };
    if (sock?.readyState !== WebSocket.OPEN) return fail("not connected");
    const nonce = crypto.randomUUID();
    const acked = new Promise<void>((resolve, reject) => unacked.current.set(nonce, { resolve, reject }));
    const timer = setTimeout(() => unacked.current.has(nonce) && kill.current(sock), ACK_MS);
    sock.send(JSON.stringify({ ...m, nonce }));
    return acked.then(
      () => clearTimeout(timer),
      (e: Error) => (clearTimeout(timer), fail(e.message)),
    );
  }, []);

  useEffect(() => {
    let stopped = false;
    let retry: Timer | undefined;
    // someclaw restarts in ~70 ms (deploy): retry fast at first, back off if it stays down.
    let attempt = 0;
    const connect = () => {
      setLink("connecting");
      const q = new URLSearchParams({ token: getToken() ?? "" });
      const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/someclaw/ws?${q}`);
      ws.current = sock;
      sock.onopen = () => {
        setLink("open");
        attempt = 0;
        // Reconnected (e.g. someclaw deploy restart): the close errors are resolved.
        setErrors((x) => x.filter((e) => !e.link));
        sock.send(JSON.stringify({ type: "subscribe", id: openRef.current } satisfies ClientMsg));
      };
      sock.onclose = (e) => closed(e.code, e.reason);
      // Silent socket: a dead one's close handshake can hang for minutes, so drop it now and reconnect. Its late
      // messages (an ack included) are ignored: what was rejected stays rejected.
      kill.current = (s) => {
        if (s !== sock) return;
        sock.onmessage = sock.onclose = null;
        sock.close(4000, "no ack");
        closed(4000, "no ack");
      };
      const closed = async (code: number, reason: string) => {
        if (stopped || ws.current !== sock) return;
        lose(code === 4000 ? `no reply in ${ACK_MS / 1000} s` : `socket closed ${code}`);
        setLink("closed");
        // The upgrade's 401 is invisible here: ask over REST.
        const auth = await fetch("/api/status", { headers: { authorization: `Bearer ${getToken()}` } }).catch(() => null);
        if (auth?.status === 401 || code === 4001) return onUnauthorized();
        // One link error per outage, not one per fast retry.
        setErrors((x) => [...x.filter((y) => !y.link), { at: Date.now(), message: `broker socket closed ${code} ${reason}, reconnecting`, link: true }]);
        retry = setTimeout(connect, attempt++ < 40 ? 250 : 2000);
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
          case "usage":
            setUsage(m.usage);
            break;
          case "search":
            if (m.seq === seq.current) setFound({ q: m.q, results: m.results, error: m.error, loading: false });
            break;
          case "ack":
            unacked.current.get(m.nonce)?.resolve();
            unacked.current.delete(m.nonce);
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
    // Back/forward cache (lib/away.ts): no socket while leaving; back: reconnect, fresh subscribe + snapshot.
    const off = onAway({
      leave: () => {
        clearTimeout(retry);
        const sock = ws.current;
        ws.current = null;
        if (!sock) return;
        sock.onmessage = sock.onclose = null;
        const closed = sock.readyState === WebSocket.CLOSED ? undefined : new Promise((r) => sock.addEventListener("close", r, { once: true }));
        sock.close(1000, "leaving page");
        lose("page left");
        return closed;
      },
      back: () => !stopped && !ws.current && connect(),
    });
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      off();
      ws.current?.close();
    };
  }, []);

  // Page-load cache: show the last list + snapshot right away, the broker's fresh ones replace them.
  useEffect(() => {
    cacheGet<Conversation[]>("list").then((l) => l && setList((x) => x ?? l));
  }, []);
  useEffect(() => {
    setSnap(null);
    cacheGet<Snapshot>(`snap:${openId}`).then((c) => c && openRef.current === openId && setSnap((x) => x ?? { ...c, stale: true }));
    if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "subscribe", id: openId } satisfies ClientMsg));
  }, [openId]);

  // Message search (server/search.ts); titles are matched in the browser. Debounced, latest query wins.
  const searchTimer = useRef<Timer>(undefined);
  const search = useCallback((q: string) => {
    clearTimeout(searchTimer.current);
    const n = ++seq.current;
    if (q.trim().length < 2) return setFound(null);
    setFound((f) => ({ q, results: f?.results ?? [], error: null, loading: true }));
    searchTimer.current = setTimeout(() => {
      if (n !== seq.current) return;
      if (ws.current?.readyState !== WebSocket.OPEN) return setFound({ q, results: [], error: "not connected", loading: false });
      ws.current.send(JSON.stringify({ type: "search", q: q.trim(), seq: n } satisfies ClientMsg));
    }, 150);
  }, []);

  // Written once things settle (a streaming turn changes snap per chunk), pending writes also when the page is left
  // (before navigating: a write still running keeps the page out of the back/forward cache).
  const dirty = useRef<{ list?: Conversation[]; snap?: Snapshot }>({});
  const flush = useCallback(() => {
    const { list, snap } = dirty.current;
    dirty.current = {};
    return Promise.all([list && cachePut("list", list), snap && cachePut(`snap:${snap.id}`, snap)]);
  }, []);
  useEffect(() => {
    if (list) dirty.current.list = list;
    if (snap && !snap.stale) dirty.current.snap = snap;
    const t = setTimeout(flush, 1000);
    return () => clearTimeout(t);
  }, [list, snap]);
  useEffect(() => onAway({ leave: flush, back: () => {} }), []);

  const dismissError = (at: number) => setErrors((x) => x.filter((e) => e.at !== at));
  return { list, listError, snap, link, errors, dismissError, send, deliver, usage, found, search };
}
