import { GitBranch, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { Upstream } from "../../shared/protocol";

const POLL_MS = 60_000;
const short = (sha: string | null) => sha?.slice(0, 7) ?? "?";

/** Served build isn't at origin/main (server/upstream.ts): the update timer is stuck. Also shows a failing check. */
export function UpstreamBanner() {
  const [s, setS] = useState<Upstream | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let timer: Timer | undefined;
    const poll = async () => {
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch("/someclaw/upstream", { cache: "no-store" });
          if (!res.ok) throw new Error(`GET /someclaw/upstream: ${res.status} ${await res.text()}`);
          const body = (await res.json()) as Upstream;
          if (live) (setS(body), setFetchError(null));
        } catch (e) {
          if (live) setFetchError(e instanceof Error ? e.message : String(e));
        }
      }
      if (live) timer = setTimeout(poll, POLL_MS);
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, []);

  const error = fetchError ?? s?.error ?? null;
  const sig = `${s?.main}|${error}`;
  if ((!s?.behind && !error) || dismissed === sig) return null;

  const mins = s?.since ? Math.round((Date.now() - s.since) / 60_000) : null;
  return (
    <div className="flex shrink-0 items-start gap-2.5 border-b border-warn/25 bg-warn/[0.06] px-4 py-2.5 text-sm">
      <GitBranch size={16} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        {s?.behind && (
          <p className="font-medium text-fg">
            someclaw is not on latest main
            {s.commits !== null && `: ${s.commits} commit${s.commits === 1 ? "" : "s"} behind`}
          </p>
        )}
        {s?.behind && (
          <p className="font-mono text-xs break-words text-fg-2">
            running {short(s.built)} · main {short(s.main)}
            {mins !== null && ` · for ${mins} min`} · journalctl --user -u someclaw-update
          </p>
        )}
        {error && <p className="font-mono text-xs break-words text-err">version check: {error}</p>}
      </div>
      <button onClick={() => setDismissed(sig)} title="Dismiss until main changes" className="-mr-1 grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-line-strong hover:text-fg">
        <X size={14} />
      </button>
    </div>
  );
}
