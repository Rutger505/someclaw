import { Archive, ArchiveRestore, ChevronRight, ExternalLink, Keyboard, MessageCircle, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Conversation } from "../../shared/protocol";
import { DASHBOARD_URL } from "../App";
import type { Link } from "../lib/broker";

export const convTitle = (c: Conversation) => c.name ?? c.preview ?? (c.channel ? c.channel : "New conversation");

/** running = pulsing amber, error = red, unread = cyan, idle = nothing. */
export function StatusDot({ c, className = "" }: { c: Pick<Conversation, "status" | "unread">; className?: string }) {
  const [color, title] =
    c.status === "running"
      ? ["bg-warn animate-pulse", "running"]
      : c.status === "error"
        ? ["bg-err", "error"]
        : c.unread
          ? ["bg-accent shadow-[0_0_8px] shadow-accent/60", "unread"]
          : ["bg-transparent", "idle"];
  return <span title={title} className={`inline-block size-1.5 shrink-0 rounded-full ${color} ${className}`} />;
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
  const showKeys = useCtrlHeld();
  const active = list?.filter((c) => !c.archived) ?? [];
  const archived = list?.filter((c) => c.archived) ?? [];

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
        <button
          onClick={onNew}
          className="group flex h-9 w-full items-center gap-2 rounded-md border border-line-strong px-3 text-sm text-fg-2 transition-colors hover:border-accent-dim hover:bg-accent-glow hover:text-accent-light"
        >
          <Plus size={16} />
          <span>New conversation</span>
          <Kbd className="ml-auto opacity-0 transition-opacity group-hover:opacity-100">Ctrl O</Kbd>
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 pb-3">
        {listError && <p className="mb-2 rounded-md bg-err/10 px-2.5 py-2 font-mono text-xs break-words text-err">{listError}</p>}
        {list === null && !listError && <p className="px-2.5 py-1.5 text-sm text-muted">Loading…</p>}
        <div className="flex flex-col gap-0.5">
          {active.map((c, i) => (
            <Row key={c.id} c={c} n={showKeys && i < 9 ? i + 1 : null} open={c.id === openId} onOpen={onOpen} onArchive={onArchive} />
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
      </div>

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
}

function Row({ c, n, open, onOpen, onArchive }: { c: Conversation; n: number | null; open: boolean; onOpen: (id: string) => void; onArchive: (id: string, archived: boolean) => void }) {
  return (
    <div
      onClick={() => onOpen(c.id)}
      title={c.error ?? c.titleError ?? undefined}
      className={`group relative flex h-9 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors ${
        open ? "bg-elevated text-fg" : "text-fg-2 hover:bg-elevated/60 hover:text-fg"
      }`}
    >
      {open && <span className="absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent" />}
      {c.channel ? <MessageCircle size={14} className="shrink-0 text-muted" /> : <StatusDot c={c} className="mx-[3px]" />}
      <span className={`flex-1 truncate ${c.unread ? "font-medium text-fg" : ""}`}>{convTitle(c)}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onArchive(c.id, !c.archived);
        }}
        title={c.archived ? "Unarchive (Alt+A)" : "Archive (Alt+A)"}
        className="-mr-1 hidden size-6 place-items-center rounded text-muted group-hover:grid hover:bg-line-strong hover:text-fg"
      >
        {c.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
      </button>
      {n !== null && <Kbd className="group-hover:hidden">{n}</Kbd>}
    </div>
  );
}

/** Ctrl+1-9 hints only while Ctrl is held: a quiet list otherwise. */
function useCtrlHeld() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const on = (e: KeyboardEvent) => setHeld(e.key === "Control" ? e.type === "keydown" : e.ctrlKey);
    const off = () => setHeld(false);
    addEventListener("keydown", on);
    addEventListener("keyup", on);
    addEventListener("blur", off);
    return () => (removeEventListener("keydown", on), removeEventListener("keyup", on), removeEventListener("blur", off));
  }, []);
  return held;
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
