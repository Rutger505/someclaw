import { Archive, ArchiveRestore, ArrowUp, CircleAlert, Clock, CornerDownRight, GitBranch, Lock, PanelLeft, Square, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClientMsg, Conversation, Resume } from "../../shared/protocol";
import type { Snapshot } from "../lib/broker";
import { buildItems, type Item } from "../lib/items";
import { Markdown } from "./Markdown";
import { convTitle, IconButton, Kbd, StatusDot } from "./Sidebar";
import { ToolGroup } from "./Tools";
import { ModelSelector } from "./ModelSelector";

/** unlock: true when it applied (channel thread); elsewhere the key stays with the browser. */
export type ChatHandle = { focus: () => void; rename: () => void; unlock: () => boolean };

type Props = {
  id: string;
  conv: Conversation | undefined;
  snap: Snapshot | null;
  send: (m: ClientMsg) => void;
  onDraft: (empty: boolean) => void;
  onToggleSidebar: () => void;
  /** Opens another conversation (a fork right after sending it). */
  onOpen: (id: string) => void;
};

/** One content width for messages and composer, so their edges line up. */
const COLUMN = "mx-auto w-full max-w-3xl px-6";

export const Chat = forwardRef<ChatHandle, Props>(function Chat({ id, conv, snap, send, onDraft, onToggleSidebar, onOpen }, ref) {
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow new output only while scrolled to the bottom
  const items = useMemo(() => (snap?.id === id ? buildItems(snap) : []), [snap, id]);
  const running = conv?.status === "running";
  const readOnly = !!conv?.channel;
  // Channel threads start locked: typing there forks, so it takes a deliberate click or Ctrl+Shift+F.
  const [unlocked, setUnlocked] = useState(false);
  const locked = readOnly && !unlocked;

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    rename: () => conv && setRenaming(conv.name ?? ""),
    unlock: () => {
      if (!readOnly) return false;
      if (unlocked) input.current?.focus();
      else setUnlocked(true);
      return true;
    },
  }));
  useEffect(() => {
    if (unlocked) input.current?.focus();
  }, [unlocked]);

  // Drafts per conversation, kept across switches and reloads.
  useEffect(() => {
    const saved = localStorage.getItem(`draft.${id}`) ?? "";
    setDraft(saved);
    setUnlocked(!!saved); // a kept draft means it was unlocked on purpose
    setRenaming(null);
    stick.current = true;
    input.current?.focus();
  }, [id]);
  useEffect(() => {
    if (draft) localStorage.setItem(`draft.${id}`, draft);
    else localStorage.removeItem(`draft.${id}`);
    onDraft(!draft);
  }, [draft]);

  useLayoutEffect(() => {
    if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [items]);

  /** Idle: starts a turn. While rocky works: steers it (no queue). Channel sessions: forks into a new conversation. */
  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    stick.current = true;
    if (!readOnly) return send({ type: "send", id, text });
    const fork = crypto.randomUUID();
    send({ type: "fork", from: id, id: fork, text });
    onOpen(fork);
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="relative flex h-14 shrink-0 items-center gap-2 border-b border-line px-3">
        <IconButton onClick={onToggleSidebar} title="Sidebar (Ctrl+B)">
          <PanelLeft size={18} />
        </IconButton>
        {renaming !== null ? (
          <form
            className="flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              if (renaming.trim()) send({ type: "rename", id, name: renaming });
              setRenaming(null);
              input.current?.focus();
            }}
          >
            <input
              autoFocus
              value={renaming}
              onChange={(e) => setRenaming(e.target.value)}
              onBlur={() => setRenaming(null)}
              onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setRenaming(null))}
              className="h-8 w-full rounded-md border border-accent-dim bg-input px-2.5 text-sm outline-none focus:border-accent"
            />
          </form>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
            {conv && <StatusDot c={conv} />}
            <span
              className="truncate text-sm font-medium"
              onDoubleClick={() => conv && !readOnly && setRenaming(conv.name ?? "")}
              title={conv ? "Double-click or F2 to rename" : undefined}
            >
              {conv ? convTitle(conv) : <span className="text-muted">New conversation</span>}
            </span>
            {conv?.channel && <span className="rounded-md bg-elevated px-1.5 py-0.5 text-xs text-fg-2">{conv.channel} · read-only</span>}
          </div>
        )}
        {!readOnly && <ModelSelector />}
        {conv && (
          <IconButton onClick={() => send({ type: "archive", id, archived: !conv.archived })} title={conv.archived ? "Unarchive (Ctrl+Shift+E)" : "Archive (Ctrl+Shift+E)"}>
            {conv.archived ? <ArchiveRestore size={17} /> : <Archive size={17} />}
          </IconButton>
        )}
      </header>

      <div
        ref={log}
        className="flex-1 overflow-y-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        <div className={`${COLUMN} flex flex-col gap-5 py-8`}>
          {conv?.titleError && <Banner label="Auto-title failed" text={conv.titleError} />}
          {snap?.historyError && <Banner label="History failed to load" text={snap.historyError} />}
          {!snap && <p className="text-sm text-muted">Loading…</p>}
          {snap && !items.length && <Empty />}
          {items.map((item, i) => (
            <Row key={i} item={item} />
          ))}
          {conv?.error && !running && <Banner label="Turn failed" text={conv.error} />}
          {conv?.resume && !running && <Waiting resume={conv.resume} onCancel={() => send({ type: "abort", id })} />}
          {running && items.at(-1)?.kind !== "agent" && <Thinking />}
        </div>
      </div>

      <form
        className={`${COLUMN} relative pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-t before:from-base before:to-transparent`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {locked ? (
          <Locked channel={conv?.channel ?? "channel"} onUnlock={() => setUnlocked(true)} />
        ) : (
          <div className="rounded-2xl border border-line-strong bg-surface shadow-lg shadow-black/20 transition-colors focus-within:border-accent-dim">
            <textarea
              ref={input}
              autoFocus
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape" && readOnly && !draft) {
                  e.preventDefault();
                  setUnlocked(false); // back to read-only
                }
              }}
              placeholder={readOnly ? "Continue in a new someclaw conversation…" : running ? "Steer rocky…" : "Message rocky…"}
              className="field-sizing-content block max-h-64 min-h-12 w-full resize-none bg-transparent px-4 pt-3.5 pb-1 outline-none placeholder:text-faint disabled:opacity-50"
            />
            <div className="flex items-center gap-2 px-3 pb-2.5">
              <span className="text-xs text-faint">
                {readOnly
                  ? "Enter continues in a new conversation with this thread as context · Esc locks again"
                  : running
                    ? "rocky is working · Enter steers · Esc stops"
                    : "Enter to send · Shift+Enter new line"}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                {running && (
                  <button
                    type="button"
                    onClick={() => send({ type: "abort", id })}
                    title="Stop (Esc)"
                    className="grid size-8 place-items-center rounded-full bg-elevated text-fg-2 ring-1 ring-line-strong transition-colors hover:bg-err/15 hover:text-err hover:ring-err/40"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                )}
                <button
                  title={readOnly ? "Continue in new conversation (Enter)" : running ? "Steer (Enter)" : "Send (Enter)"}
                  disabled={!draft.trim()}
                  className="grid size-8 place-items-center rounded-full bg-accent text-base transition-colors hover:bg-accent-light disabled:bg-elevated disabled:text-faint"
                >
                  {readOnly ? <GitBranch size={16} strokeWidth={2.5} /> : running ? <CornerDownRight size={16} strokeWidth={2.5} /> : <ArrowUp size={17} strokeWidth={2.5} />}
                </button>
              </div>
            </div>
          </div>
        )}
      </form>
    </div>
  );
});

/**
 * Channel thread composer before unlocking. No input exists yet, so stray keys go nowhere; the button never takes focus
 * and ignores keyboard activation (click detail 0), so a space or Enter can't press it by accident.
 */
function Locked({ channel, onUnlock }: { channel: string; onUnlock: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line-strong bg-surface px-4 py-3 shadow-lg shadow-black/20">
      <Lock size={15} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-sm text-muted">{channel} thread · read-only</span>
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => e.detail > 0 && onUnlock()}
        title="Continue in a new someclaw conversation with this thread as context (Ctrl+Shift+F)"
        className="flex shrink-0 items-center gap-2 rounded-full bg-elevated py-1.5 pr-2 pl-3 text-sm text-fg-2 ring-1 ring-line-strong transition-colors hover:bg-accent-glow hover:text-fg hover:ring-accent-dim"
      >
        <GitBranch size={14} /> Continue here
        <Kbd className="hidden sm:inline">Ctrl Shift F</Kbd>
      </button>
    </div>
  );
}

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-auto flex max-w-[85%] flex-col items-end gap-1">
          {item.steer && (
            <span className="flex items-center gap-1 text-xs text-accent">
              <CornerDownRight size={12} /> steered
            </span>
          )}
          {item.fork && (
            <a href={`#${encodeURIComponent(item.fork.id)}`} className="flex items-center gap-1 text-xs text-accent hover:underline">
              <GitBranch size={12} /> continued from {item.fork.channel} · {item.fork.messages} messages as context
            </a>
          )}
          <div className="max-w-full rounded-2xl rounded-br-md bg-elevated px-4 py-2.5 whitespace-pre-wrap wrap-anywhere ring-1 ring-line">{item.text}</div>
        </div>
      );
    case "agent":
      return (
        <div className="max-w-full">
          <Markdown text={item.text} />
          {item.live && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />}
        </div>
      );
    case "tools":
      return <ToolGroup tools={item.tools} live={!!item.live} />;
    case "meta":
      return item.error ? <Banner text={item.text} /> : <p className="text-xs text-muted">{item.text}</p>;
  }
}

/** Real error text, framed: label in sans, the message itself verbatim in mono. */
function Banner({ label, text }: { label?: string; text: string }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-err/25 bg-err/[0.06] px-3.5 py-2.5 text-sm">
      <CircleAlert size={16} className="mt-0.5 shrink-0 text-err" />
      <div className="min-w-0">
        {label && <p className="font-medium text-fg">{label}</p>}
        <p className="font-mono text-xs break-words text-err/90">{text}</p>
      </div>
    </div>
  );
}

/** Rate-limited: the broker resumes the turn itself at resume.at. */
function Waiting({ resume, onCancel }: { resume: Resume; onCancel: () => void }) {
  const at = new Date(resume.at);
  const sameDay = at.toDateString() === new Date().toDateString();
  const when = at.toLocaleString(undefined, sameDay ? { timeStyle: "short" } : { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <div className="flex gap-2.5 rounded-xl border border-info/25 bg-info/[0.06] px-3.5 py-2.5 text-sm">
      <Clock size={16} className="mt-0.5 shrink-0 text-info" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">
          Resumes automatically {sameDay ? "at" : "on"} {when}
          <span className="font-normal text-muted"> · attempt {resume.attempt}</span>
        </p>
        <p className="font-mono text-xs break-words text-fg-2">{resume.reason}</p>
      </div>
      <button
        onClick={onCancel}
        title="Cancel auto-resume (Esc)"
        className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-line-strong hover:text-fg"
      >
        <X size={14} />
      </button>
    </div>
  );
}

function Thinking() {
  return (
    <div className="flex h-6 items-center gap-1" title="rocky is working">
      {[0, 150, 300].map((d) => (
        <span key={d} style={{ animationDelay: `${d}ms` }} className="size-1.5 animate-bounce rounded-full bg-accent/70" />
      ))}
    </div>
  );
}

function Empty() {
  return (
    <div className="flex flex-col items-center gap-3 pt-[18vh] text-center">
      <span className="grid size-12 place-items-center rounded-xl bg-accent-glow ring-1 ring-accent-dim">
        <span className="size-4 rounded-full bg-accent shadow-[0_0_16px] shadow-accent" />
      </span>
      <p className="text-lg font-medium">What's up?</p>
      <p className="text-sm text-muted">New conversation with rocky</p>
    </div>
  );
}
