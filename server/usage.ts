// When does the Anthropic rate limit reset? ZeroClaw drops the 429's reset headers, so ask the usage endpoint
// Claude Code uses for /usage (same account), with Claude Code's OAuth token. Undocumented: on any failure the
// broker falls back to a short fixed retry and shows why.
// The token lives ~8 h and nothing refreshes it unless Claude Code runs, so we run `claude auth status`
// (refreshes and rewrites the credentials file) instead of reimplementing Claude Code's OAuth flow.
import { readFileSync } from "node:fs";
import type { Usage, UsageWindow } from "../shared/protocol";

const CREDENTIALS = process.env.CLAUDE_CREDENTIALS ?? `${process.env.HOME}/.claude/.credentials.json`;
const CLAUDE_BIN = process.env.CLAUDE_BIN ?? "claude";
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const REFRESH_BEFORE_MS = 5 * 60_000;

type Window = { utilization: number | null; resets_at: string | null } | null;

export type Reset = { at: string; window: string };

function readToken(): { token: string; expiresAt: number } {
  try {
    const o = JSON.parse(readFileSync(CREDENTIALS, "utf8")).claudeAiOauth;
    return { token: o.accessToken, expiresAt: Number(o.expiresAt) || 0 };
  } catch (e) {
    throw new Error(`no Claude Code token in ${CREDENTIALS}: ${e instanceof Error ? e.message : e}`);
  }
}

let refreshing: Promise<void> | null = null;

/** Let Claude Code refresh its own token. One at a time: concurrent refreshes would race on the refresh token. */
function refresh(): Promise<void> {
  refreshing ??= (async () => {
    let p;
    try {
      p = Bun.spawn([CLAUDE_BIN, "auth", "status"], { stdout: "pipe", stderr: "pipe" });
    } catch (e) {
      throw new Error(`claude auth status: ${e instanceof Error ? e.message : e}`);
    }
    const timer = setTimeout(() => p.kill(), 30_000);
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    clearTimeout(timer);
    if (code !== 0) throw new Error(`claude auth status exited ${code}: ${(err || out).trim().slice(0, 200)}`);
  })().finally(() => (refreshing = null));
  return refreshing;
}

async function fetchUsage(token: string) {
  return fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-code/someclaw" },
    signal: AbortSignal.timeout(10_000),
  });
}

type Raw = Record<string, unknown>;

// Dev/e2e: usage JSON from a file instead of the endpoint, to test the queue without hitting a limit.
const FAKE = process.env.SOMECLAW_USAGE_FILE;

async function fetchRaw(): Promise<Raw> {
  if (FAKE) return JSON.parse(readFileSync(FAKE, "utf8"));
  let { token, expiresAt } = readToken();
  if (expiresAt - Date.now() < REFRESH_BEFORE_MS) {
    await refresh();
    ({ token, expiresAt } = readToken());
    if (expiresAt - Date.now() < REFRESH_BEFORE_MS) throw new Error("Claude Code token still expired after refresh: run `claude` on the VM to log in");
  }
  let res = await fetchUsage(token);
  if (res.status === 401) {
    console.log("usage: 401, refreshing the Claude Code token");
    await refresh();
    res = await fetchUsage(readToken().token);
  }
  const body = await res.text();
  // 429 = the usage endpoint's own rate limit, not ours; the broker treats it like any failure (short retry).
  if (!res.ok) throw new Error(`usage endpoint: ${res.status} ${body.slice(0, 200)}`);
  return JSON.parse(body) as Raw;
}

const LABELS: Record<string, string> = {
  five_hour: "Session",
  seven_day: "Weekly",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
};

/** Plan windows: top-level { utilization, resets_at } objects (null = not on this plan). */
function windows(raw: Raw): UsageWindow[] {
  const out: UsageWindow[] = [];
  for (const [key, w] of Object.entries(raw)) {
    if (!w || typeof w !== "object" || Array.isArray(w) || !("resets_at" in w)) continue;
    const { utilization, resets_at } = w as Window & object;
    if (typeof utilization !== "number") continue;
    out.push({ key, label: LABELS[key] ?? key, percent: utilization, resets_at: resets_at ? new Date(resets_at).toISOString() : null });
  }
  const order = (k: string) => (k in LABELS ? Object.keys(LABELS).indexOf(k) : 99);
  return out.sort((a, b) => order(a.key) - order(b.key));
}

function extra(raw: Raw): Usage["extra"] {
  const e = raw.extra_usage as { is_enabled?: boolean; used_credits?: number; currency?: string; decimal_places?: number } | null | undefined;
  if (!e || typeof e !== "object") return null;
  return { enabled: !!e.is_enabled, used: (e.used_credits ?? 0) / 10 ** (e.decimal_places ?? 2), currency: e.currency ?? "" };
}

// ---------- cached poll ----------
// One shared view for the sidebar and the broker's queue decision. Polled every POLL_MS while someone needs it.

const POLL_MS = 5 * 60_000;
let current: Usage = { windows: [], extra: null, at: null, error: null };
let polling: Promise<Usage> | null = null;
const listeners = new Set<(u: Usage) => void>();

export const usage = () => current;
export const onUsage = (fn: (u: Usage) => void) => listeners.add(fn);

/** Fetches now (joins a running poll). Never throws: failures land in usage().error. */
export function pollUsage(): Promise<Usage> {
  polling ??= (async () => {
    try {
      const raw = await fetchRaw();
      current = { windows: windows(raw), extra: extra(raw), at: new Date().toISOString(), error: null };
    } catch (e) {
      current = { ...current, error: e instanceof Error ? e.message : String(e) };
      console.error(`usage: ${current.error}`);
    }
    for (const fn of listeners) fn(current);
    return current;
  })().finally(() => (polling = null));
  return polling;
}

/** Polls every POLL_MS while `needed()` (browser open, messages queued), right after a full window resets too. */
export function startUsagePoller(needed: () => boolean) {
  let last = 0;
  const tick = async () => {
    const reset = fullUntil();
    const resetPassed = reset && Date.parse(reset.at) < Date.now();
    if (needed() && Date.now() - last >= (resetPassed ? 60_000 : POLL_MS)) {
      last = Date.now();
      await pollUsage();
    }
    setTimeout(tick, 15_000);
  };
  tick();
}

/** Latest reset among the windows at 100% in the cached usage, or null when none is (or it's unknown). */
export function fullUntil(u = current): Reset | null {
  let latest: Reset | null = null;
  for (const w of u.windows) {
    if (!w.resets_at || w.percent < 100) continue;
    if (!latest || w.resets_at > latest.at) latest = { at: w.resets_at, window: w.key };
  }
  return latest;
}

/** Latest reset among the windows at 100% right now, or null when none is full (short per-minute limit). Throws when
 * the usage endpoint can't be read. */
export async function rateLimitReset(): Promise<Reset | null> {
  const u = await pollUsage();
  if (u.error) throw new Error(u.error);
  return fullUntil(u);
}
