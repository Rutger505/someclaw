// Serves the built UI (dist/) and proxies the gateway on the same origin (the gateway has no CORS).
import { watch } from "node:fs";

const GATEWAY = (process.env.ZEROCLAW_GATEWAY ?? "http://127.0.0.1:42617").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 42618);
const DIST = `${import.meta.dir}/dist`;

// The version is the hash of dist/index.html: it references the content-hashed bundles, so it changes with any UI change.
// Open pages listen on /someclaw/events and reload themselves (when idle) once it changes.
const hashIndex = async () => Bun.hash(await Bun.file(`${DIST}/index.html`).text()).toString(36);
let version = await hashIndex().catch(() => "none");
const listeners = new Set<ReadableStreamDefaultController>();
const send = (c: ReadableStreamDefaultController, chunk: string) => {
  try { c.enqueue(chunk); } catch { listeners.delete(c); }
};
let debounce: Timer | undefined;
// Watch the repo dir, not dist/: build.ts swaps dist/ in by rename.
watch(import.meta.dir, (_, file) => {
  if (file !== "dist") return;
  clearTimeout(debounce);
  debounce = setTimeout(async () => {
    const v = await hashIndex().catch(() => version);
    if (v === version) return;
    version = v;
    for (const c of listeners) send(c, `data: ${v}\n\n`);
  }, 150);
});
// Keeps proxies/NAT from dropping idle streams; one tiny frame per 30 s.
setInterval(() => { for (const c of listeners) send(c, ": ping\n\n"); }, 30_000);

type Data = { target: string; upstream?: WebSocket; queue: string[] };

Bun.serve<Data, never>({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/chat") {
      const target = GATEWAY.replace(/^http/, "ws") + url.pathname + url.search;
      if (server.upgrade(req, { data: { target, queue: [] } })) return;
      return new Response("expected websocket", { status: 400 });
    }

    if (url.pathname.startsWith("/api/") || url.pathname === "/health") {
      const headers = new Headers(req.headers);
      headers.delete("host");
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      return fetch(GATEWAY + url.pathname + url.search, {
        method: req.method,
        headers,
        body: hasBody ? await req.arrayBuffer() : undefined,
        redirect: "manual",
      });
    }

    if (url.pathname === "/someclaw/version") {
      return new Response(version, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/someclaw/events") {
      server.timeout(req, 0); // long-lived stream: no idle timeout
      let ctrl: ReadableStreamDefaultController;
      const body = new ReadableStream({
        start(c) { ctrl = c; listeners.add(c); send(c, `retry: 3000\ndata: ${version}\n\n`); },
        cancel() { listeners.delete(ctrl); },
      });
      return new Response(body, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
      });
    }

    // Static: index.html must revalidate, bundles are content-hashed and immutable.
    const path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!path.includes("..")) {
      const file = Bun.file(DIST + path);
      if (await file.exists()) {
        const cache = path === "/index.html" ? "no-cache" : "public, max-age=31536000, immutable";
        return new Response(file, { headers: { "cache-control": cache } });
      }
    }
    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const up = new WebSocket(ws.data.target, ["zeroclaw.v1"]);
      ws.data.upstream = up;
      up.onopen = () => {
        for (const m of ws.data.queue) up.send(m);
        ws.data.queue = [];
      };
      up.onmessage = (e) => ws.send(e.data);
      up.onclose = (e) => ws.close(e.code === 1005 ? 1000 : e.code, e.reason);
      up.onerror = () => ws.close(1011, "upstream error");
    },
    message(ws, msg) {
      const up = ws.data.upstream;
      if (up?.readyState === WebSocket.OPEN) up.send(msg);
      else ws.data.queue.push(String(msg));
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});

console.log(`someclaw on http://0.0.0.0:${PORT} -> ${GATEWAY}`);
