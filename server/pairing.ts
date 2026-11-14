// Pairing by approval, for when there's no shell at hand to run `zeroclaw gateway get-paircode --new`: an unpaired
// browser asks for a request and shows its 6-digit code; Rutger tells rocky (WhatsApp) "approve <code>", rocky runs
// bin/pair on the VM, which calls the loopback-only approve endpoint. Only then does the server mint a pairing code
// (CLI, it holds the gateway's admin token) and hand it to that browser alone (it polls with its secret id), which
// pairs as usual. The code never goes through chat; the 6 digits are not a secret, they only say which browser.
import { randomInt } from "node:crypto";

const TTL_MS = 10 * 60_000;
const MAX_PENDING = 5; // anyone who reaches the page can ask: keep it small

type PairRequest = {
  id: string; // secret, browser only
  code: string; // shown in the browser, told to rocky
  ip: string;
  ua: string;
  created: number;
  status: "pending" | "approved" | "denied";
  pairingCode?: string;
};

const requests = new Map<string, PairRequest>(); // by id

function sweep() {
  const now = Date.now();
  for (const [id, r] of requests) if (now - r.created > TTL_MS) requests.delete(id);
}

const byCode = (code: string) => [...requests.values()].find((r) => r.code === code);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

/** POST /someclaw/pair/request: new request for this browser. */
export function create(ip: string, ua: string) {
  sweep();
  if ([...requests.values()].filter((r) => r.status === "pending").length >= MAX_PENDING)
    return json({ error: `already ${MAX_PENDING} pending pairing requests, try again in a few minutes` }, 429);
  let code: string;
  do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  while (byCode(code));
  const r: PairRequest = { id: crypto.randomUUID(), code, ip, ua, created: Date.now(), status: "pending" };
  requests.set(r.id, r);
  console.log(`pair: request ${code} from ${ip} (${ua})`);
  return json({ id: r.id, code, expires_at: new Date(r.created + TTL_MS).toISOString() });
}

/** GET /someclaw/pair/request/<id>: the browser polls; the pairing code is handed out once. */
export function poll(id: string) {
  sweep();
  const r = requests.get(id);
  if (!r) return json({ status: "expired" });
  if (r.status === "approved") {
    requests.delete(id);
    return json({ status: "approved", pairing_code: r.pairingCode });
  }
  if (r.status === "denied") requests.delete(id);
  return json({ status: r.status });
}

const describe = (r: PairRequest) =>
  `${r.code}  ${r.status}  ${Math.round((Date.now() - r.created) / 1000)}s ago  ${r.ip}  ${r.ua}`;

/** Loopback only (bin/pair). GET list, POST approve/<code>, POST deny/<code>. Plain text for the CLI. */
export async function admin(action: string, code: string | undefined) {
  sweep();
  if (action === "list") {
    const lines = [...requests.values()].map(describe);
    return new Response(lines.length ? lines.join("\n") + "\n" : "no pairing requests\n");
  }
  const r = code ? byCode(code) : undefined;
  if (!r) return new Response(`no request with code ${code} (expired after 10 min?)\n`, { status: 404 });
  if (r.status !== "pending") return new Response(`request ${r.code} already ${r.status}\n`, { status: 409 });
  if (action === "deny") {
    r.status = "denied";
    console.log(`pair: denied ${r.code}`);
    return new Response(`denied ${describe(r)}\n`);
  }
  if (action !== "approve") return new Response(`unknown action ${action}\n`, { status: 404 });
  const proc = Bun.spawn(["zeroclaw", "gateway", "get-paircode", "--new", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  let pairingCode: unknown;
  try { pairingCode = JSON.parse(out).pairing_code; } catch {}
  if (exit !== 0 || typeof pairingCode !== "string" || !pairingCode)
    return new Response(`get-paircode failed (exit ${exit}): ${err.trim() || out.trim()}\n`, { status: 502 });
  r.status = "approved";
  r.pairingCode = pairingCode;
  console.log(`pair: approved ${r.code}`);
  return new Response(`approved ${describe(r)}\n`);
}

/** Direct loopback connection only: Caddy (the only remote allowed in) always adds X-Forwarded-For. */
export const isLocal = (addr: string | undefined, req: Request) =>
  !!addr && /^(127\.|::1$|::ffff:127\.)/.test(addr) && !req.headers.has("x-forwarded-for");
