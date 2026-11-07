// When does the Anthropic rate limit reset? ZeroClaw drops the 429's reset headers, so ask the usage endpoint
// Claude Code uses for /usage (same account), with Claude Code's OAuth token. Undocumented: on any failure the
// broker falls back to a short fixed retry and shows why.
// The token lives ~8 h and nothing refreshes it unless Claude Code runs, so we run `claude auth status`
// (refreshes and rewrites the credentials file) instead of reimplementing Claude Code's OAuth flow.
import { readFileSync } from "node:fs";

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

/** Latest reset among the windows at 100%, or null when none is full (short per-minute limit). */
export async function rateLimitReset(): Promise<Reset | null> {
  let { token, expiresAt } = readToken();
  if (expiresAt - Date.now() < REFRESH_BEFORE_MS) {
    await refresh();
    ({ token, expiresAt } = readToken());
    if (expiresAt - Date.now() < REFRESH_BEFORE_MS) throw new Error("Claude Code token still expired after refresh: run `claude` on the VM to log in");
  }
  let res = await fetchUsage(token);
  if (res.status === 401) {
    await refresh();
    res = await fetchUsage(readToken().token);
  }
  const body = await res.text();
  // 429 = the usage endpoint's own rate limit, not ours; the broker treats it like any failure (short retry).
  if (!res.ok) throw new Error(`usage endpoint: ${res.status} ${body.slice(0, 200)}`);
  const usage = JSON.parse(body) as Record<string, Window>;
  let latest: Reset | null = null;
  for (const [window, w] of Object.entries(usage)) {
    if (!w || typeof w !== "object" || !w.resets_at || (w.utilization ?? 0) < 100) continue;
    if (!latest || w.resets_at > latest.at) latest = { at: new Date(w.resets_at).toISOString(), window };
  }
  return latest;
}
