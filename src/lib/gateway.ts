// Gateway auth: pairing token in localStorage (same key as the official dashboard, but this is its own origin).
const KEY = "zeroclaw_token";

export const getToken = () => localStorage.getItem(KEY);
export const clearToken = () => localStorage.removeItem(KEY);

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}`, ...init.headers },
  });
  if (!res.ok) throw new HttpError(res.status, `${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`);
  return res.headers.get("content-type")?.includes("json") ? res.json() : (res.text() as T);
}

export async function pair(code: string) {
  const res = await fetch("/api/pair", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, device_name: "someclaw", device_type: "browser" }),
  });
  if (!res.ok) throw new Error(`pair ${res.status}: ${await res.text()}`);
  localStorage.setItem(KEY, (await res.json()).token);
}

/** The WS upgrade's 401 is invisible to the browser, so check the token over REST first. */
export async function tokenValid() {
  if (!getToken()) return false;
  const res = await fetch("/api/status", { headers: { authorization: `Bearer ${getToken()}` } });
  if (res.status === 401) return false;
  return true;
}
