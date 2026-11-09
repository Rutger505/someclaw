// Serves the built UI (dist/), runs the conversation broker on /someclaw/ws (server/broker.ts) and proxies the gateway's
// REST API on the same origin (the gateway has no CORS; the UI uses it for pairing).
import { watch } from "node:fs";
import { authorize, websocket, type Client } from "./server/broker";
import { tokenValid } from "./server/gateway";
import { upload } from "./server/uploads";
import { flush } from "./server/state";

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
// Restart (deploy): exit right away, but keep the state save that's still in its debounce.
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { flush(); process.exit(0); });

// Keeps proxies/NAT from dropping idle streams; one tiny frame per 30 s.
setInterval(() => { for (const c of listeners) send(c, ": ping\n\n"); }, 30_000);

Bun.serve<Client, never>({
  port: PORT,
  hostname: "0.0.0.0",

  async fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/someclaw/ws") {
      const token = url.searchParams.get("token");
      if (!(await authorize(token))) return new Response("unauthorized: pair again", { status: 401 });
      if (server.upgrade(req, { data: { token: token!, sub: null, ua: req.headers.get("user-agent") ?? "?" } })) return;
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

    // The gateway takes /admin/reload only from loopback (allow_remote_admin is off): relayed from here, so the
    // pairing token is checked here first. Unauthenticated loopback calls would otherwise let anyone reload it.
    if (url.pathname === "/someclaw/reload" && req.method === "POST") {
      const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!token || !(await tokenValid(token))) return new Response("unauthorized: pair again", { status: 401 });
      const res = await fetch(`${GATEWAY}/admin/reload`, { method: "POST", signal: AbortSignal.timeout(30_000) });
      console.log(`reload: gateway answered ${res.status}`);
      return new Response(await res.text(), { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "text/plain" } });
    }

    if (url.pathname === "/someclaw/upload" && req.method === "POST") return upload(req);

    if (url.pathname === "/someclaw/version") {
      return new Response(version, { headers: { "cache-control": "no-store" } });
    }

    if (url.pathname === "/someclaw/events") {
      server.timeout(req, 0); // long-lived stream: no idle timeout
      let ctrl: ReadableStreamDefaultController;
      const body = new ReadableStream({
        start(c) { ctrl = c; listeners.add(c); send(c, `retry: 250\ndata: ${version}\n\n`); },
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

  websocket,
});

console.log(`someclaw on http://0.0.0.0:${PORT} -> ${GATEWAY}`);
