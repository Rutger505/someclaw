import { useEffect, useRef } from "react";

/** The server pushes the dist version over SSE (on connect and on every build). Reload once it changed and `idle`. */
export function useVersionReload(idle: boolean) {
  const loaded = useRef<string>(null);
  const pending = useRef(false);
  const idleRef = useRef(idle);
  idleRef.current = idle;

  useEffect(() => {
    const es = new EventSource("/someclaw/events");
    es.onmessage = (e) => {
      loaded.current ??= e.data;
      if (e.data !== loaded.current) pending.current = true;
      if (pending.current && idleRef.current) location.reload();
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    if (idle && pending.current) location.reload();
  }, [idle]);
}
