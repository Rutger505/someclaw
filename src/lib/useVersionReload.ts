import { useEffect, useRef } from "react";

/** Resolves once the new page and every bundle it references load, so a reload never lands in a restart gap. */
async function ready() {
  // A server deploy restarts someclaw right after the build that announced the new version: let that pass first.
  await new Promise((r) => setTimeout(r, 1000));
  for (;;) {
    try {
      const res = await fetch("/", { cache: "no-store" });
      if (res.ok) {
        const doc = new DOMParser().parseFromString(await res.text(), "text/html");
        const urls = [...doc.querySelectorAll<HTMLElement>("script[src], link[rel=stylesheet]")].map(
          (el) => el.getAttribute("src") ?? el.getAttribute("href")!,
        );
        const ok = await Promise.all(urls.map((u) => fetch(u).then((r) => r.ok, () => false)));
        if (ok.every(Boolean)) return;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The server pushes the dist version over SSE (on connect and on every build). Reload once it changed and `idle`. */
export function useVersionReload(idle: boolean) {
  const loaded = useRef<string>(null);
  const pending = useRef(false);
  const reloading = useRef(false);
  const idleRef = useRef(idle);
  idleRef.current = idle;

  const reload = () => {
    if (reloading.current) return;
    reloading.current = true;
    ready().then(() => (idleRef.current ? location.reload() : (reloading.current = false)));
  };

  useEffect(() => {
    let es: EventSource;
    let retry: Timer | undefined;
    const open = () => {
      es = new EventSource("/someclaw/events");
      es.onmessage = (e) => {
        loaded.current ??= e.data;
        if (e.data !== loaded.current) pending.current = true;
        if (pending.current && idleRef.current) reload();
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
    if (idle && pending.current) reload();
  }, [idle]);
}
