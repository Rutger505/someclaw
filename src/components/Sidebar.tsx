import { Archive, ArchiveRestore, ChevronRight, CircleAlert, Clock, ExternalLink, Keyboard, Loader, MessageCircle, Plus, Search as SearchIcon, X } from "lucide-react";
import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Conversation, SearchHit, Usage } from "../../shared/protocol";
import { DASHBOARD_URL } from "../App";
import type { Link, Search } from "../lib/broker";
import { until, when } from "../lib/time";

// Real links so Ctrl/Cmd/Shift/middle-click open a new tab/window natively; a plain click stays in-app.
const inApp = (fn: () => void) => (e: React.MouseEvent) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  fn();
};

export const convTitle = (c: Conversation) => c.name ?? c.preview ?? (c.channel ? c.channel : "New conversation");

/** Status as distinct shapes, not just colors: working = spinner, rate-limited = clock (+ queued count), failed = alert,
 * new reply = solid dot. `compact` (chat header): no reset time next to the clock. */
export function StatusIcon({ c, compact = false }: { c: Pick<Conversation, "status" | "unread" | "resume" | "error">; compact?: boolean }) {
  const queued = c.resume?.queued?.length ?? 0;
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      {c.status === "running" && (
        <span title="rocky is working">
          <Loader size={13} className="animate-spin text-warn" />
        </span>
      )}
      {c.status === "waiting" && c.resume && (
        <span
          title={`${queued ? `${queued} message${queued === 1 ? "" : "s"} queued` : "rate limited"}, ${c.resume.queuedOnly || queued ? "sends" : "resumes"} ${when(c.resume.at)} (${until(c.resume.at)})\n${c.resume.reason}`}
          className="flex items-center gap-1 rounded bg-info/10 px-1 font-mono text-[10px] leading-4 text-info"
        >
          <Clock size={11} />
          {!compact && when(c.resume.at)}
          {queued > 0 && <span className="rounded-sm bg-info/25 px-0.5 text-fg">{queued}</span>}
        </span>
      )}
      {c.status === "error" && (
        <span title={`turn failed: ${c.error ?? "error"}`}>
          <CircleAlert size={13} className="text-err" />
        </span>
      )}
      {c.unread && <span title="new reply" className="size-2 rounded-full bg-accent shadow-[0_0_8px] shadow-accent/60" />}
    </span>
  );
}

/** Search box handle: Ctrl+K focuses it. */
export type SidebarHandle = { search: () => void };

type Props = {
  usage: Usage | null;
  found: Search | null;
  onSearch: (q: string) => void;
  /** Opens a conversation scrolled to history[at] (a search hit). */
  onJump: (id: string, at: number) => void;
  list: Conversation[] | null;
  listError: string | null;
  link: Link;
  openId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onArchive: (id: string, archived: boolean) => void;
  onHelp: () => void;
};

export const Sidebar = forwardRef<SidebarHandle, Props>(function Sidebar({ usage, found, onSearch, onJump, list, listError, link, openId, onOpen, onNew, onArchive, onHelp }, ref) {
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => ({ search: () => (box.current?.focus(), box.current?.select()) }));
  const active = list?.filter((c) => !c.archived) ?? [];
  const archived = list?.filter((c) => c.archived) ?? [];
  const query = (v: string) => (setQ(v), onSearch(v));
  const searching = q.trim().length > 0;
  const matches = useMemo(() => (searching ? searchList(list ?? [], q, found) : []), [list, q, found, searching]);

  return (
    <nav className="flex h-full w-68 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex h-14 items-center gap-2.5 px-4">
        <span className="grid size-7 place-items-center rounded-md bg-accent-glow ring-1 ring-accent-dim">
          <span className="size-2.5 rounded-full bg-accent shadow-[0_0_10px] shadow-accent" />
        </span>
        <span className="font-semibold tracking-tight">someclaw</span>
        <span className="rounded-md bg-elevated px-1.5 py-0.5 text-xs text-fg-2">rocky</span>
        <span
          title={`broker ${link}`}
          className={`ml-auto size-1.5 rounded-full ${link === "open" ? "bg-ok" : link === "connecting" ? "animate-pulse bg-warn" : "bg-err"}`}
        />
      </div>

      <div className="px-3 pb-3">
        <a
          href={location.pathname}
          onClick={inApp(onNew)}
          className="group flex h-9 w-full items-center gap-2 rounded-md border border-line-strong px-3 text-sm text-fg-2 transition-colors hover:border-accent-dim hover:bg-accent-glow hover:text-accent-light"
        >
          <Plus size={16} />
          <span>New conversation</span>
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">Ctrl O</Kbd>
        </a>
      </div>

      <div className="px-3 pb-2">
        <div className="flex h-8 items-center gap-2 rounded-md bg-input px-2.5 ring-1 ring-line focus-within:ring-accent-dim">
          <SearchIcon size={14} className="shrink-0 text-muted" />
          <input
            ref={box}
            value={q}
            onChange={(e) => query(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (q) query("");
                else box.current?.blur();
              } else if (e.key === "Enter" && matches[0]) {
                const m = matches[0];
                if (m.hits[0]) onJump(m.c.id, m.hits[0].at);
                else onOpen(m.c.id);
              }
            }}
            placeholder="Search titles + messages"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
          />
          {q ? (
            <button onClick={() => query("")} title="Clear (Esc)" className="text-muted hover:text-fg">
              <X size={14} />
            </button>
          ) : (
            <Kbd>Ctrl K</Kbd>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {listError && <p className="mb-2 rounded-md bg-err/10 px-2.5 py-2 font-mono text-xs break-words text-err">{listError}</p>}
        {list === null && !listError && <p className="px-2.5 py-1.5 text-sm text-muted">Loading…</p>}
        {searching ? (
          <Results q={q} found={found} matches={matches} openId={openId} onOpen={onOpen} onJump={onJump} />
        ) : (
        <>
        <div className="flex flex-col gap-0.5">
          {active.map((c, i) => (
            <Row key={c.id} c={c} n={i < 9 ? i + 1 : null} open={c.id === openId} onOpen={onOpen} onArchive={onArchive} />
          ))}
        </div>
        {archived.length > 0 && (
          <>
            <button
              onClick={() => setShowArchived((x) => !x)}
              className="mt-4 mb-1 flex w-full items-center gap-1 px-2.5 text-xs font-medium text-muted transition-colors hover:text-fg-2"
            >
              <ChevronRight size={14} className={`transition-transform duration-150 ${showArchived ? "rotate-90" : ""}`} />
              Archived
              <span className="ml-auto text-faint">{archived.length}</span>
            </button>
            {showArchived && (
              <div className="flex flex-col gap-0.5">
                {archived.map((c) => (
                  <Row key={c.id} c={c} n={null} open={c.id === openId} onOpen={onOpen} onArchive={onArchive} />
                ))}
              </div>
            )}
          </>
        )}
        </>
        )}
      </div>

      {usage && <UsagePanel usage={usage} />}

      <div className="flex items-center gap-1 border-t border-line p-3">
        <a
          href={DASHBOARD_URL}
          target="_blank"
          rel="noreferrer"
          className="flex h-8 flex-1 items-center gap-2 rounded-md px-2.5 text-sm text-fg-2 transition-colors hover:bg-elevated hover:text-fg"
        >
          <ExternalLink size={15} />
          ZeroClaw dashboard
        </a>
        <IconButton onClick={onHelp} title="Shortcuts (Ctrl+/)">
          <Keyboard size={16} />
        </IconButton>
      </div>
    </nav>
  );
});

type Match = { c: Conversation; title: boolean; hits: SearchHit[]; total: number };

/** Title matches (in the browser, instant) + message hits (server), title matches first, then newest activity. */
function searchList(list: Conversation[], q: string, found: Search | null): Match[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const byId = new Map((found?.results ?? []).map((r) => [r.id, r]));
  const out: Match[] = [];
  for (const c of list) {
    const title = terms.every((t) => convTitle(c).toLowerCase().includes(t));
    const r = byId.get(c.id);
    if (title || r) out.push({ c, title, hits: r?.hits ?? [], total: r?.total ?? 0 });
  }
  return out.sort((a, b) => Number(b.title) - Number(a.title) || b.c.last_activity.localeCompare(a.c.last_activity));
}

function Mark({ text, q }: { text: string; q: string }) {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return <>{text}</>;
  const esc = (t: string) => t.replace(/[.*+?^$()|[\]{}\\]/g, "\\$&");
  const re = new RegExp(`(${terms.map(esc).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) => (i % 2 ? <mark key={i} className="rounded-sm bg-accent/25 text-fg">{part}</mark> : part))}
    </>
  );
}

function Results({ q, found, matches, openId, onOpen, onJump }: { q: string; found: Search | null; matches: Match[]; openId: string; onOpen: (id: string) => void; onJump: (id: string, at: number) => void }) {
  return (
    <div className="flex flex-col gap-1">
      {found?.error && <p className="rounded-md bg-err/10 px-2.5 py-2 font-mono text-xs break-words text-err">search: {found.error}</p>}
      {q.trim().length < 2 && <p className="px-2.5 py-1 text-xs text-faint">Titles only below 2 characters</p>}
      {matches.map((m) => (
        <div key={m.c.id} className={`rounded-md ${m.c.id === openId ? "bg-elevated" : ""}`}>
          <a
            href={`#${encodeURIComponent(m.c.id)}`}
            onClick={inApp(() => onOpen(m.c.id))}
            className="flex h-8 items-center gap-2 rounded-md px-2.5 text-sm text-fg-2 hover:bg-elevated/60 hover:text-fg"
          >
            <span className={`flex-1 truncate ${m.c.unread ? "font-medium text-fg" : ""}`}>
              <Mark text={convTitle(m.c)} q={m.title ? q : ""} />
            </span>
            {m.c.archived && <Archive size={12} className="shrink-0 text-faint" />}
            {m.c.channel ? <MessageCircle size={13} className="shrink-0 text-muted" /> : <StatusIcon c={m.c} />}
          </a>
          {m.hits.map((h) => (
            <a
              key={h.at}
              href={`#${encodeURIComponent(m.c.id)}`}
              onClick={inApp(() => onJump(m.c.id, h.at))}
              className="mb-0.5 ml-2.5 block rounded-md border-l-2 border-line px-2 py-1 text-xs leading-snug text-muted hover:border-accent-dim hover:bg-elevated/60 hover:text-fg-2"
            >
              <span className="line-clamp-2">
                <span className="mr-1 font-medium text-faint">{h.role === "user" ? "you" : "rocky"}</span>
                <Mark text={h.snippet} q={q} />
              </span>
            </a>
          ))}
          {m.total > m.hits.length && <p className="mb-1 ml-5 text-[11px] text-faint">+{m.total - m.hits.length} more</p>}
        </div>
      ))}
      {!matches.length && !found?.loading && <p className="px-2.5 py-1.5 text-sm text-muted">No results found.</p>}
      {found?.loading && <p className="px-2.5 py-1 text-xs text-faint">Searching messages…</p>}
    </div>
  );
}

/** Anthropic plan usage (polled by the broker every 5 min while a browser is open). */
function UsagePanel({ usage }: { usage: Usage }) {
  const updated = usage.at ? `updated ${when(usage.at)}` : "never loaded";
  const extra = usage.extra?.enabled && usage.extra.used > 0 ? usage.extra : null;
  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3" title={`Claude plan usage (same account as ZeroClaw), ${updated}`}>
      {usage.windows.map((w) => {
        const tone = w.percent >= 100 ? "bg-err" : w.percent >= 80 ? "bg-warn" : "bg-accent";
        return (
          <div key={w.key} className="flex flex-col gap-1" title={w.resets_at ? `${w.label}: ${w.percent}%, resets ${new Date(w.resets_at).toLocaleString()}` : undefined}>
            <div className="flex items-baseline gap-2 text-xs">
              <span className="text-fg-2">{w.label}</span>
              <span className={`font-mono ${w.percent >= 100 ? "text-err" : w.percent >= 80 ? "text-warn" : "text-muted"}`}>{Math.round(w.percent)}%</span>
              {w.resets_at && <span className="ml-auto text-faint">resets {when(w.resets_at)}</span>}
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-elevated">
              <div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, Math.max(0, w.percent))}%` }} />
            </div>
          </div>
        );
      })}
      {extra && (
        <p className="text-xs text-faint">
          Extra usage: {extra.used.toLocaleString(undefined, { style: "currency", currency: extra.currency || "EUR" })} this month
        </p>
      )}
      {usage.error && <p className="font-mono text-[11px] break-words text-err">usage: {usage.error}</p>}
    </div>
  );
}

function Row({ c, n, open, onOpen, onArchive }: { c: Conversation; n: number | null; open: boolean; onOpen: (id: string) => void; onArchive: (id: string, archived: boolean) => void }) {
  return (
    <a
      href={`#${encodeURIComponent(c.id)}`}
      onClick={inApp(() => onOpen(c.id))}
      title={c.error ?? c.titleError ?? undefined}
      className={`group relative flex h-9 cursor-pointer items-center gap-2 rounded-md px-2.5 text-sm transition-colors ${
        open ? "bg-elevated text-fg" : "text-fg-2 hover:bg-elevated/60 hover:text-fg"
      }`}
    >
      {open && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
      <span className="w-2.5 shrink-0 text-right font-mono text-[11px] text-faint" title={n !== null ? `Ctrl+${n}` : undefined}>
        {n}
      </span>
      <span className={`flex-1 truncate ${c.unread ? "font-medium text-fg" : ""}`}>{convTitle(c)}</span>
      {(c.channel || c.status !== "idle" || c.unread) && (
        <span className="flex shrink-0 items-center gap-1.5 group-hover:hidden">
          {c.channel && <MessageCircle size={14} className="text-muted" />}
          <StatusIcon c={c} />
        </span>
      )}
      <button
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onArchive(c.id, !c.archived);
        }}
        title={c.archived ? "Unarchive (Ctrl+Shift+E)" : "Archive (Ctrl+Shift+E)"}
        className="-mr-1 hidden size-6 place-items-center rounded text-muted group-hover:grid hover:bg-line-strong hover:text-fg"
      >
        {c.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
      </button>
    </a>
  );
}

export function Kbd({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <kbd className={`rounded border border-line-strong bg-base/60 px-1.5 font-mono text-[10px] leading-4 text-muted ${className}`}>{children}</kbd>;
}

export function IconButton({ children, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={`grid size-8 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-fg disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}
