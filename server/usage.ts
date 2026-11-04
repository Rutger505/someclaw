// When does the Anthropic rate limit reset? ZeroClaw drops the 429's reset headers, so ask the usage endpoint
// Claude Code uses for /usage (same account), with Claude Code's OAuth token. Undocumented: on any failure the
// broker falls back to a fixed interval and shows why.
import { readFileSync } from "node:fs";

const CREDENTIALS = process.env.CLAUDE_CREDENTIALS ?? `${process.env.HOME}/.claude/.credentials.json`;
const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

type Window = { utilization: number | null; resets_at: string | null } | null;

export type Reset = { at: string; window: string };

/** Latest reset among the windows at 100%, or null when none is full (short per-minute limit). */
export async function rateLimitReset(): Promise<Reset | null> {
  let token: string;
  try {
    token = JSON.parse(readFileSync(CREDENTIALS, "utf8")).claudeAiOauth.accessToken;
  } catch (e) {
    throw new Error(`no Claude Code token in ${CREDENTIALS}: ${e instanceof Error ? e.message : e}`);
  }
  // Claude Code refreshes this token when it runs; an expired one 401s (run `claude` once to refresh).
  const res = await fetch(USAGE_URL, {
    headers: { authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", "user-agent": "claude-code/someclaw" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`usage endpoint: ${res.status} ${body.slice(0, 200)}`);
  const usage = JSON.parse(body) as Record<string, Window>;
  let latest: Reset | null = null;
  for (const [window, w] of Object.entries(usage)) {
    if (!w || typeof w !== "object" || !w.resets_at || (w.utilization ?? 0) < 100) continue;
    if (!latest || w.resets_at > latest.at) latest = { at: new Date(w.resets_at).toISOString(), window };
  }
  return latest;
}
