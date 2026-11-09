import { RefreshCw, TriangleAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, getToken, HttpError } from "../lib/gateway";

type ReloadStatus = {
  pending_reload: boolean;
  application?: { records?: { path: string[]; outcome: string; reason?: string }[] };
};
type Drift = { drifted: { path: string; secret?: boolean }[] };

const POLL_MS = 5_000;
const DOWN_RETRY_MS = 300; // gateway down (restarting): notice it's back right away

/**
 * Same signals as the official dashboard's ReloadBanner: config writes that only apply after a gateway reload
 * (pending_reload), and config.toml on disk differing from what the daemon loaded (drift, e.g. after a sync).
 * busy: someclaw has turns running; a reload restarts the gateway, so the button waits.
 */
export function ReloadBanner({ busy }: { busy: boolean }) {
  const [paths, setPaths] = useState<{ pending: string[]; drifted: string[] } | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [reload, setReload] = useState<{ state: "running" } | { state: "error"; message: string } | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    let timer: Timer | undefined;
    const poll = async () => {
      let wait = POLL_MS;
      if (document.visibilityState === "visible") {
        try {
          const [status, drift] = await Promise.all([api<ReloadStatus>("/api/config/reload-status"), api<Drift>("/api/config/drift")]);
          if (!live) return;
          const pending = (status.application?.records ?? []).filter((r) => r.outcome === "queued_for_reload").map((r) => r.path.join("."));
          setPaths({
            // pending_reload without records (older gateways): still show the banner
            pending: status.pending_reload ? (pending.length ? [...new Set(pending)] : ["(unknown paths)"]) : [],
            drifted: drift.drifted.map((d) => d.path + (d.secret ? " (secret)" : "")),
          });
          setPollError(null);
        } catch (e) {
          if (live) setPollError(e instanceof Error ? e.message : String(e)); // gateway down mid-reload, etc.
          if (!(e instanceof HttpError) || e.status >= 500) wait = DOWN_RETRY_MS;
        }
      }
      if (live) timer = setTimeout(poll, wait);
    };
    poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [tick]);

  const run = async () => {
    setReload({ state: "running" });
    try {
      const res = await fetch("/someclaw/reload", { method: "POST", headers: { authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`POST /admin/reload: ${res.status} ${await res.text()}`);
      // Wait for the new gateway instance before polling the flags again.
      for (let i = 0; i < 300; i++) {
        await new Promise((r) => setTimeout(r, 200));
        const h = await fetch("/health").catch(() => null);
        if (h?.ok) break;
        if (i === 299) throw new Error(`gateway not healthy 60 s after reload: /health ${h ? `${h.status} ${await h.text()}` : "unreachable"}`);
      }
      setReload(null);
      setTick((t) => t + 1);
    } catch (e) {
      setReload({ state: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const pending = paths?.pending ?? [];
  const drifted = paths?.drifted ?? [];
  const sig = `${pending.join(",")}|${drifted.join(",")}`;
  if ((!pending.length && !drifted.length && reload?.state !== "error") || dismissed === sig) return null;

  const text =
    pending.length && drifted.length
      ? "Config changed and config.toml differs from the running daemon: reload the gateway to apply"
      : pending.length
        ? "Config changed: reload the gateway to apply"
        : "config.toml differs from what the daemon loaded: reload the gateway to apply";
  const shown = [...pending, ...drifted.map((d) => `${d} (on disk)`)];

  return (
    <div className="flex shrink-0 items-start gap-2.5 border-b border-warn/25 bg-warn/[0.06] px-4 py-2.5 text-sm">
      <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{text}</p>
        {shown.length > 0 && (
          <p className="font-mono text-xs break-words text-fg-2">
            {shown.slice(0, 4).join(" · ")}
            {shown.length > 4 && ` · +${shown.length - 4} more`}
          </p>
        )}
        {reload?.state === "error" && <p className="font-mono text-xs break-words text-err">{reload.message}</p>}
        {pollError && <p className="font-mono text-xs break-words text-err">{pollError}</p>}
      </div>
      <button
        onClick={run}
        disabled={busy || reload?.state === "running"}
        title={busy ? "A turn is running: reloading restarts the gateway. Wait until it's done." : "POST /admin/reload"}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-elevated px-2.5 text-xs text-fg ring-1 ring-line-strong transition-colors hover:bg-warn/15 hover:ring-warn/40 disabled:opacity-50 disabled:hover:bg-elevated disabled:hover:ring-line-strong"
      >
        <RefreshCw size={13} className={reload?.state === "running" ? "animate-spin" : ""} />
        {reload?.state === "running" ? "Reloading…" : "Reload gateway"}
      </button>
      <button onClick={() => setDismissed(sig)} title="Dismiss until something else changes" className="-mr-1 grid size-7 shrink-0 place-items-center rounded text-muted hover:bg-line-strong hover:text-fg">
        <X size={14} />
      </button>
    </div>
  );
}
