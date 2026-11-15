// Gateway auth: pairing token in localStorage (same key as the official dashboard, but this is its own origin).
import type { Attachment } from "../../shared/attachments";

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

/** Pairing by approval (server/pairing.ts): rocky runs `bin/pair approve <code>` on the VM. */
export async function requestPairing(): Promise<{ id: string; code: string; expires_at: string }> {
  const res = await fetch("/someclaw/pair/request", { method: "POST" });
  if (!res.ok) throw new Error(`pair request ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function pollPairing(id: string): Promise<{ status: "pending" | "approved" | "denied" | "expired"; pairing_code?: string }> {
  const res = await fetch(`/someclaw/pair/request/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`pair poll ${res.status}: ${await res.text()}`);
  return res.json();
}

/** The WS upgrade's 401 is invisible to the browser, so check the token over REST first. */
export async function tokenValid() {
  if (!getToken()) return false;
  const res = await fetch("/api/status", { headers: { authorization: `Bearer ${getToken()}` } });
  if (res.status === 401) return false;
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Picked files are read one at a time: Firefox for Android fails one of several photos picked at once when they're
 * read in parallel (the upload never reaches the server: "NetworkError when attempting to fetch resource"). */
let reading: Promise<unknown> = Promise.resolve();
function readFile(f: File): Promise<ArrayBuffer> {
  const run = reading.then(async () => {
    for (let i = 0; ; i++) {
      try {
        return await f.arrayBuffer();
      } catch (e) {
        if (i === 2) throw new Error(`read ${f.name}: ${(e as Error).message}`);
        await sleep(300 * (i + 1));
      }
    }
  });
  reading = run.catch(() => {});
  return run;
}

/** POST /someclaw/upload: saves the file on the VM, returns the path to put in a media marker. Network errors retry. */
export async function uploadFile(f: File): Promise<Attachment> {
  const body = await readFile(f);
  for (let i = 0; ; i++) {
    let res: Response;
    try {
      res = await fetch(`/someclaw/upload?name=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${getToken()}`, "content-type": f.type || "application/octet-stream" },
        body,
      });
    } catch (e) {
      if (i === 2) throw new Error(`upload ${f.name}: ${(e as Error).message}`);
      await sleep(500 * (i + 1));
      continue;
    }
    if (!res.ok) throw new HttpError(res.status, `upload ${f.name}: ${res.status} ${await res.text()}`);
    return res.json();
  }
}

/** An uploaded file back (GET /someclaw/upload), cached per path for the page's lifetime: uploads never change. */
const downloads = new Map<string, Promise<Blob>>();
export function fetchUpload(path: string): Promise<Blob> {
  let p = downloads.get(path);
  if (!p) {
    p = fetch(`/someclaw/upload?path=${encodeURIComponent(path)}`, { headers: { authorization: `Bearer ${getToken()}` } }).then(async (res) => {
      if (!res.ok) throw new HttpError(res.status, `${res.status} ${await res.text()}`);
      return res.blob();
    });
    p.catch(() => downloads.delete(path)); // errors may be temporary
    downloads.set(path, p);
  }
  return p;
}
