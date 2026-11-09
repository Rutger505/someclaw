// Gateway REST + /ws/chat helpers. The token is whatever a browser paired with; the broker keeps the latest valid one.
export const GATEWAY = (process.env.ZEROCLAW_GATEWAY ?? "http://127.0.0.1:42617").replace(/\/+$/, "");
export const AGENT = "rocky";

export class GatewayError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Gateway not answering (restarting): connection refused/reset, or its 503 while it reloads. Worth a fast retry. */
export const gatewayDown = (e: unknown) =>
  e instanceof GatewayError ? e.status === 503 : typeof (e as { code?: unknown })?.code === "string";

export async function api<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(GATEWAY + path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...init.headers },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await res.text();
  if (!res.ok) throw new GatewayError(res.status, `${init.method ?? "GET"} ${path}: ${res.status} ${body.slice(0, 300)}`);
  return (body ? JSON.parse(body) : null) as T;
}

export async function tokenValid(token: string) {
  const res = await fetch(`${GATEWAY}/api/status`, { headers: { authorization: `Bearer ${token}` } });
  return res.status !== 401;
}

/** model: provider ref for this session (model_provider query param); omitted = the agent's configured default. */
export function chatSocket(token: string, sessionId: string, { model, agent = AGENT }: { model?: string; agent?: string } = {}) {
  const q = new URLSearchParams({ session_id: sessionId, agent }); // token as subprotocol: kept out of URLs/logs
  if (model) q.set("model_provider", model);
  return new WebSocket(`${GATEWAY.replace(/^http/, "ws")}/ws/chat?${q}`, ["zeroclaw.v1", `bearer.${token}`]);
}

export type GatewaySession = {
  session_id: string;
  agent_alias: string | null;
  channel_id: string | null;
  name?: string | null;
  created_at: string;
  last_activity: string;
  message_count: number;
};
