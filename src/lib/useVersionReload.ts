import { useEffect, useRef } from "react";

/** The server pushes the dist version over SSE (on connect and on every build). Reload once it changed and `idle`. */
export function useVersionReload(idle: boolean) {
  const loaded = useRef<string>(null);
  const pending = useRef(false);
  const idleRef = useRef(idle);
  idleRef.current = idle;

  useEffect(() => {
    let es: EventSource;
    let retry: Timer | undefined;
    const open = () => {
      es = new EventSource("/someclaw/events");
      es.onmessage = (e) => {
        loaded.current ??= e.data;
        if (e.data !== loaded.current) pending.current = true;
        if (pending.current && idleRef.current) location.reload();
      };
      // A reconnect that hits the proxy's 502 mid-restart closes EventSource for good: reopen it ourselves.
      es.onerror = () => {
        if (es.readyState === EventSource.CLOSED) retry = setTimeout(open, 500);
      };
    };
    open();
    return () => { clearTimeout(retry); es.close(); };
  }, []);

  useEffect(() => {
    if (idle && pending.current) location.reload();
  }, [idle]);
}
