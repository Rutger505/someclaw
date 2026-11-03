import { useState } from "react";
import type { Conversation } from "../../shared/protocol";
import { DASHBOARD_URL } from "../App";
import type { Link } from "../lib/broker";

export const convTitle = (c: Conversation) => c.name ?? c.preview ?? (c.channel ? c.channel : "New conversation");

/** running = pulsing amber, error = red, paused queue = amber ring, unread = cyan, idle = grey. */
export function StatusDot({ c, className = "" }: { c: Pick<Conversation, "status" | "unread" | "paused" | "queue">; className?: string }) {
  const [color, title] =
    c.status === "running"
      ? ["bg-warn animate-pulse", "running"]
      : c.status === "error"
        ? ["bg-err", "error"]
        : c.paused && c.queue.length
          ? ["bg-transparent ring-2 ring-inset ring-warn", "queue paused"]
          : c.unread
            ? ["bg-accent shadow-[0_0_6px] shadow-accent", "unread"]
            : ["bg-faint", "idle"];
  return <span title={title} className={`inline-block size-2 shrink-0 rounded-full ${color} ${className}`} />;
}

type Props = {
  list: Conversation[] | null;
  listError: string | null;
  link: Link;
  openId: string;
  onOpen: (id: string) => void;
  onNew: () => void;
  onArchive: (id: string, archived: boolean) => void;
  onHelp: () => void;
};

export function Sidebar({ list, listError, link, openId, onOpen, onNew, onArchive, onHelp }: Props) {
  const [showArchived, setShowArchived] = useState(false);
  const active = list?.filter((c) => !c.archived) ?? [];
  const archived = list?.filter((c) => c.archived) ?? [];

  return (
    <nav className="flex h-full w-72 shrink-0 flex-col border-r border-line bg-surface">
      <div className="flex items-center gap-2 px-3 py-3">
        <span className="font-semibold text-accent">someclaw</span>
        <span className="text-sm text-muted">rocky</span>
        <span
          title={`broker ${link}`}
          className={`ml-auto size-1.5 rounded-full ${link === "open" ? "bg-ok" : link === "connecting" ? "bg-warn" : "bg-err"}`}
        />
      </div>

      <button
        onClick={onNew}
        className="mx-3 mb-2 flex items-center justify-between rounded-md border border-accent-dim bg-accent-glow px-3 py-1.5 text-sm text-accent-light hover:border-accent"
      >
        <span>+ New conversation</span>
        <kbd className="font-mono text-xs text-muted">Ctrl+O</kbd>
      </button>

      <div className="flex-1 overflow-y-auto px-2 pb-2">
        {listError && <p className="mx-1 my-2 break-words font-mono text-xs text-err">{listError}</p>}
        {list === null && !listError && <p className="px-2 py-1 text-sm text-muted">loading…</p>}
        {active.map((c, i) => (
          <Row key={c.id} c={c} n={i < 9 ? i + 1 : null} open={c.id === openId} onOpen={onOpen} onArchive={onArchive} />
        ))}
        {archived.length > 0 && (
          <>
            <button
              onClick={() => setShowArchived((x) => !x)}
              className="mt-3 w-full px-2 py-1 text-left text-xs uppercase tracking-wider text-muted hover:text-fg-2"
            >
              {showArchived ? "▾" : "▸"} Archived ({archived.length})
            </button>
            {showArchived && archived.map((c) => <Row key={c.id} c={c} n={null} open={c.id === openId} onOpen={onOpen} onArchive={onArchive} />)}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-line px-3 py-2 text-sm">
        <a href={DASHBOARD_URL} target="_blank" rel="noreferrer" className="flex-1 rounded-md px-2 py-1 text-fg-2 hover:bg-elevated hover:text-accent-light">
          ZeroClaw dashboard ↗
        </a>
        <button onClick={onHelp} title="Shortcuts (Ctrl+/)" className="rounded-md px-2 py-1 font-mono text-muted hover:bg-elevated hover:text-fg">
          ?
        </button>
      </div>
    </nav>
  );
}

function Row({ c, n, open, onOpen, onArchive }: { c: Conversation; n: number | null; open: boolean; onOpen: (id: string) => void; onArchive: (id: string, archived: boolean) => void }) {
  return (
    <div
      onClick={() => onOpen(c.id)}
      title={c.error ?? c.titleError ?? undefined}
      className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
        open ? "bg-accent-glow text-fg ring-1 ring-accent-dim" : "text-fg-2 hover:bg-elevated hover:text-fg"
      }`}
    >
      <StatusDot c={c} />
      <span className={`flex-1 truncate ${c.name ? "" : "italic"} ${c.unread ? "font-medium text-fg" : ""}`}>{convTitle(c)}</span>
      {c.queue.length > 0 && <span className="rounded bg-elevated px-1 font-mono text-xs text-warn" title="queued">{c.queue.length}</span>}
      {c.channel && <span className="font-mono text-[10px] text-faint">{c.channel.split(".")[0]}</span>}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onArchive(c.id, !c.archived);
        }}
        title={c.archived ? "Unarchive (Alt+A)" : "Archive (Alt+A)"}
        className="hidden text-xs text-muted hover:text-accent-light group-hover:inline"
      >
        {c.archived ? "unarchive" : "archive"}
      </button>
      {n !== null && <kbd className="font-mono text-[10px] text-faint group-hover:hidden">^{n}</kbd>}
    </div>
  );
}
