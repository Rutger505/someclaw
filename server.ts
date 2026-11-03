// Serves index.html and proxies the gateway on the same origin (the gateway has no CORS).
const GATEWAY = (process.env.ZEROCLAW_GATEWAY ?? "http://127.0.0.1:42617").replace(/\/+$/, "");
const PORT = Number(process.env.PORT ?? 42618);
const html = Bun.file(new URL("./index.html", import.meta.url));

type Data = { target: string; upstream?: WebSocket; queue: (string | Buffer)[] };

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

    if (url.pathname === "/") return new Response(html, { headers: { "content-type": "text/html" } });
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
      else ws.data.queue.push(msg);
    },
    close(ws) {
      ws.data.upstream?.close();
    },
  },
});

console.log(`someclaw on http://0.0.0.0:${PORT} -> ${GATEWAY}`);
