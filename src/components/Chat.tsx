import { Archive, ArchiveRestore, ArrowUp, CalendarClock, Check, CircleAlert, CircleHelp, Clock, Copy, ListOrdered, Pencil, Send, Upload, CornerDownRight, GitBranch, ListPlus, Lock, PanelLeft, Paperclip, Pin, RotateCcw, Square, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { previewText, splitAttachments, withAttachments, type Attachment } from "../../shared/attachments";
import type { ClientMsg, Conversation, Outbox, Resume, Scheduled, TurnModel, Usage } from "../../shared/protocol";
import { until, when } from "../lib/time";
import type { Snapshot } from "../lib/broker";
import { uploadFile } from "../lib/gateway";
import { buildItems, type Item } from "../lib/items";
import { Markdown } from "./Markdown";
import { convTitle, IconButton, Kbd, StatusIcon } from "./Sidebar";
import { Plan, ToolGroup } from "./Tools";
import { ModelSelector } from "./ModelSelector";
import { clipboardFiles, Editor, type EditorHandle } from "./Editor";
import { AttachmentChip } from "./Attachments";
import { editDraft, editDraftElsewhere, getDraft, onDraft } from "../lib/drafts";

/** unlock: true when it applied (channel thread); elsewhere the key stays with the browser. */
/** stop: stops the running turn; its outbox (messages after it) goes back into the composer. */
export type ChatHandle = { focus: () => void; rename: () => void; unlock: () => boolean; stop: () => void };

type Props = {
  id: string;
  conv: Conversation | undefined;
  snap: Snapshot | null;
  send: (m: ClientMsg) => void;
  /** Composer messages: rejects when the broker may not have it (the composer gets it back). */
  deliver: (m: ClientMsg) => Promise<void>;
  onDraft: (empty: boolean) => void;
  onToggleSidebar: () => void;
  /** Opens another conversation (a fork right after sending it). */
  onOpen: (id: string) => void;
  /** A message went out (the new-conversation slot moves to its own #id). */
  onSent: () => void;
  usage: Usage | null;
  /** Search hit: scroll to history[at] once loaded. */
  jump: { at: number; n: number } | null;
  /** Files were dropped anywhere on the page (into this composer). */
  onDropped: () => void;
};

/** One content width for messages and composer, so their edges line up. */
const COLUMN = "mx-auto w-full max-w-3xl px-6";

/** A composer attachment: uploads as soon as it's added, sent as a media marker once done. local: added in this
 * browser (absent: from the synced draft). */
type Pending = { key: string; name: string; image: boolean; local?: File; file?: Attachment; error?: string };
const synced = (file: Attachment): Pending => ({ key: file.path, name: file.name, image: file.image, file });
const uploaded = (fs: Pending[]) => fs.flatMap((f) => (f.file ? [f.file] : []));

export const Chat = forwardRef<ChatHandle, Props>(function Chat({ id, conv, snap, send, deliver, onDraft: onDraftEmpty, onToggleSidebar, onOpen, onSent, usage, jump, onDropped }, ref) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const input = useRef<EditorHandle>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow new output only while scrolled to the bottom
  const items = useMemo(() => (snap?.id === id ? buildItems(snap) : []), [snap, id]);
  const running = conv?.status === "running";
  /** rocky waits on an ask_user answer: the composer answers it. */
  const asking = running && items.some((x) => x.kind === "ask" && x.open);
  const historyLen = snap?.id === id ? snap.history.length : 0;
  const readOnly = !!conv?.channel;
  // Channel threads start locked: typing there forks, so it takes a deliberate click or Ctrl+Shift+F.
  const [unlocked, setUnlocked] = useState(false);
  const locked = readOnly && !unlocked;

  useImperativeHandle(ref, () => ({
    stop,
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

  // Drafts per conversation (text + uploaded attachments), synced to the server: same composer on every device.
  useEffect(() => {
    const saved = getDraft(id);
    setDraft(saved.text);
    setFiles(saved.files.map(synced));
    setUnlocked(!!(saved.text || saved.files.length)); // a kept draft means it was unlocked on purpose
    setRenaming(null);
    stick.current = true;
    input.current?.focus();
    // Changed on another device: theirs, keeping uploads still running here.
    return onDraft(id, (d) => {
      setDraft(d.text);
      setFiles((fs) => [...d.files.map((f) => fs.find((p) => p.file?.path === f.path) ?? synced(f)), ...fs.filter((p) => !p.file)]);
      if (d.text || d.files.length) setUnlocked(true);
    });
  }, [id]);
  useEffect(() => editDraft(id, draft, uploaded(files)), [draft, files]);
  useEffect(() => onDraftEmpty(!draft && !files.length), [draft, files]);

  useLayoutEffect(() => {
    if (!log.current) return;
    // Back from a link without the back/forward cache: reloaded, land where the page was left (scrolled up).
    const saved = items.length ? sessionStorage.getItem(`scroll.${id}`) : null;
    if (saved !== null) {
      sessionStorage.removeItem(`scroll.${id}`);
      stick.current = false;
      log.current.scrollTop = Number(saved);
    } else if (stick.current) log.current.scrollTop = log.current.scrollHeight;
  }, [items]);
  useEffect(() => {
    const hide = () => !stick.current && log.current && sessionStorage.setItem(`scroll.${id}`, String(log.current.scrollTop));
    const show = (e: PageTransitionEvent) => e.persisted && sessionStorage.removeItem(`scroll.${id}`);
    addEventListener("pagehide", hide);
    addEventListener("pageshow", show);
    return () => (removeEventListener("pagehide", hide), removeEventListener("pageshow", show));
  }, [id]);

  // Search hit: scroll to that message and flash it, once its history is rendered.
  const jumped = useRef<number | null>(null);
  useEffect(() => {
    if (!jump || jumped.current === jump.n || !items.length) return;
    const el = log.current?.querySelector<HTMLElement>(`[data-at="${jump.at}"]`);
    if (!el) return;
    jumped.current = jump.n;
    stick.current = false;
    el.scrollIntoView({ block: el.offsetHeight > (log.current?.clientHeight ?? 0) / 2 ? "start" : "center" });
    el.animate([{ boxShadow: "0 0 0 2px var(--color-accent)" }, { boxShadow: "0 0 0 2px transparent" }], { duration: 1800, easing: "ease-out" });
  }, [jump, items]);

  // Files dropped anywhere on the page land here, also with the overlay sidebar or a dialog over the composer.
  // Re-registered every render (fresh addFiles/readOnly); the enter/leave count lives in a ref so that survives it.
  const dragDepth = useRef(0);
  useEffect(() => {
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!files(e)) return;
      dragDepth.current++;
      setDragging(true);
    };
    const over = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault(); // else the browser opens the file
      e.dataTransfer!.dropEffect = "copy";
    };
    const leave = (e: DragEvent) => {
      if (!files(e) || --dragDepth.current > 0) return;
      dragDepth.current = 0;
      setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      if (!e.dataTransfer!.files.length) return;
      if (readOnly) setUnlocked(true); // dropping is deliberate enough: continue the thread here
      addFiles(e.dataTransfer!.files);
      onDropped();
    };
    // Pasted images with the focus outside the composer (chat log, sidebar, nothing): attach them too.
    const paste = (e: ClipboardEvent) => {
      if (e.defaultPrevented || !e.clipboardData) return;
      const pasted = clipboardFiles(e.clipboardData);
      if (!pasted.length) return;
      e.preventDefault();
      if (readOnly) setUnlocked(true);
      addFiles(pasted);
      onDropped();
    };
    addEventListener("paste", paste);
    addEventListener("dragenter", enter);
    addEventListener("dragover", over);
    addEventListener("dragleave", leave);
    addEventListener("drop", drop);
    return () => {
      removeEventListener("dragenter", enter);
      removeEventListener("dragover", over);
      removeEventListener("dragleave", leave);
      removeEventListener("drop", drop);
      removeEventListener("paste", paste);
    };
  });

  const uploading = files.some((f) => !f.file && !f.error);
  const failed = files.some((f) => f.error);
  const canSend = !!id && (!!draft.trim() || files.length > 0) && !uploading && !failed; // id: new-conversation slot known

  const addFiles = (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      const key = crypto.randomUUID();
      setFiles((fs) => [...fs, { key, name: f.name, image: f.type.startsWith("image/"), local: f }]);
      uploadFile(f).then(
        (file) => setFiles((fs) => fs.map((p) => (p.key === key ? { ...p, file, image: file.image } : p))),
        (e) => setFiles((fs) => fs.map((p) => (p.key === key ? { ...p, error: (e as Error).message } : p))),
      );
    }
    input.current?.focus();
  };

  // A usage window is full: the broker holds new messages until it resets (also when this conversation waits already).
  // Not memoized: a reset passing (before the next usage poll) has to count on the next render.
  let full: { label: string; at: string } | null = null;
  for (const w of usage?.windows ?? [])
    if (w.percent >= 100 && w.resets_at && Date.parse(w.resets_at) > Date.now() && (!full || w.resets_at > full.at)) full = { label: w.label, at: w.resets_at };
  const queues = !readOnly && !running && !!full;
  /** Puts held-back text back in the composer (cancel / edit), before what's typed there. */
  const restore = (texts: string[]) => setDraft((d) => [...texts, d].filter((x) => x.trim()).join("\n\n"));
  function stop() {
    restore(conv?.outbox?.items ?? []);
    send({ type: "abort", id });
  }
  const [scheduling, setScheduling] = useState(false);
  /** Usage windows a message can be scheduled for: the next session (5 h) and weekly reset. */
  const resets = (usage?.windows ?? []).filter((w) => w.key === "five_hour" || w.key === "seven_day");

  /** Idle: starts a turn (or queues it while a usage window is full). While rocky works: steers it, or with `after`
   * goes out after this turn as its own turn. window: at that usage window's next reset. Channel sessions: forks. */
  const submit = (opt: { window?: string; after?: boolean } = {}) => {
    if (!canSend) return;
    const kept = { id, draft: draft.trim(), files };
    const text = withAttachments(kept.draft, files.map((f) => f.file!));
    setScheduling(false);
    setDraft("");
    setFiles([]);
    editDraft(id, "", []); // a fork switches conversations in the same render: the effect would miss this one
    onSent();
    if (opt.window) return void deliver({ type: "schedule", id, text, window: opt.window }).catch(() => giveBack(kept));
    stick.current = true;
    if (!readOnly) return void deliver({ type: opt.after && running ? "enqueue" : "send", id, text }).catch(() => giveBack(kept));
    const fork = crypto.randomUUID();
    deliver({ type: "fork", from: id, id: fork, text }).catch(() => (onOpen(kept.id), giveBack(kept)));
    onOpen(fork);
  };
  /** Not sent (socket down or silent): back into its composer, before whatever was typed since. */
  const idRef = useRef(id);
  idRef.current = id;
  const giveBack = (kept: { id: string; draft: string; files: Pending[] }) => {
    if (idRef.current === kept.id) {
      restore([kept.draft]);
      return setFiles((fs) => [...kept.files, ...fs]);
    }
    // Switched conversations meanwhile: its draft gets it back.
    const d = getDraft(kept.id);
    editDraftElsewhere(kept.id, [kept.draft, d.text].filter((x) => x.trim()).join("\n\n"), [...uploaded(kept.files), ...d.files]);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
            {conv && <StatusIcon c={conv} compact />}
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
        {!readOnly && snap?.id === id && snap.skills.length > 0 && (
          <div className="hidden items-center gap-1 sm:flex">
            {snap.skills.map((name) => (
              <span
                key={name}
                title={`Skill ${name} is pinned: its SKILL.md goes along with your next message when it isn't in the context yet (or changed)`}
                className="flex h-7 items-center gap-1 rounded-md bg-elevated pr-0.5 pl-2 text-xs text-fg-2 ring-1 ring-line"
              >
                <Pin size={12} className="text-accent" />
                {name}
                <button
                  onClick={() => send({ type: "unpin", id, name })}
                  title={`Unpin ${name} (pinned again when rocky reads it again)`}
                  className="grid size-5 place-items-center rounded text-muted hover:bg-line-strong hover:text-fg"
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {!readOnly && <ModelSelector value={snap?.id === id ? snap.model : null} onChange={(ref) => send({ type: "model", id, ref })} />}
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
          {snap && !items.length && !conv?.resume?.queued?.length && !conv?.outbox && !conv?.scheduled.length && <Empty />}
          {items.map((item, i) => (
            <Row
              key={i}
              item={item}
              anchor={"at" in item ? item.at : undefined}
              onAnswer={(request_id, answer) => send({ type: "answer", id, request_id, answer })}
              // Reset to here: own conversations, between turns, only with something below to delete.
              reset={
                !readOnly && !running && "at" in item && item.at !== undefined && i < items.length - 1
                  ? { below: historyLen - item.at - 1, run: () => send({ type: "reset", id, keep: item.at! + 1, seen: historyLen }) }
                  : undefined
              }
            />
          ))}
          {conv?.error && !running && <Banner label="Turn failed" text={conv.error} />}
          {conv?.outbox && (
            <OutboxList
              outbox={conv.outbox}
              running={running}
              onNow={() => send({ type: "flush", id })}
              onCancel={() => {
                restore(conv.outbox?.items ?? []);
                conv.outbox?.items.forEach(() => send({ type: "unqueue", id, list: "outbox", index: 0 }));
              }}
              onEdit={(i) => {
                restore([conv.outbox!.items[i]!]);
                send({ type: "unqueue", id, list: "outbox", index: i });
                input.current?.focus();
              }}
            />
          )}
          {!!conv?.scheduled.length && (
            <ScheduledList
              list={conv.scheduled}
              onEdit={(i) => {
                restore([conv.scheduled[i]!.text]);
                send({ type: "unqueue", id, list: "scheduled", index: i });
                input.current?.focus();
              }}
            />
          )}
          {conv?.resume && !running && (
            <Waiting
              resume={conv.resume}
              usage={usage}
              onCancel={() => {
                restore(conv.resume?.queued ?? []);
                send({ type: "abort", id });
                // outbox items wait behind a resume only as resume.queued, so nothing else to restore
              }}
              onNow={() => send({ type: "flush", id })}
              onEdit={(i) => {
                restore([conv.resume!.queued![i]!]);
                send({ type: "unqueue", id, list: "queued", index: i });
                input.current?.focus();
              }}
            />
          )}
          {running && !asking && items.at(-1)?.kind !== "agent" && <Thinking />}
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
          <div className={`rounded-2xl border bg-surface shadow-lg shadow-black/20 transition-colors focus-within:border-accent-dim ${dragging ? "border-accent" : "border-line-strong"}`}>
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {files.map((f) => (
                  <AttachmentChip
                    key={f.key}
                    name={f.name}
                    image={f.image}
                    local={f.local}
                    path={f.file?.path}
                    loading={!f.file}
                    error={f.error}
                    onRemove={() => setFiles((fs) => fs.filter((p) => p.key !== f.key))}
                  />
                ))}
              </div>
            )}
            <Editor
              ref={input}
              value={draft}
              onChange={setDraft}
              onFiles={addFiles}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit({ after: e.ctrlKey || e.metaKey });
                } else if (e.key === "Escape" && readOnly && !draft) {
                  e.preventDefault();
                  setUnlocked(false); // back to read-only
                }
              }}
              placeholder={readOnly ? "Continue in a new someclaw conversation…" : asking ? "Answer rocky…" : running ? "Steer rocky…" : queues ? "Queue a message for rocky…" : "Message rocky…"}
              className="max-h-64 min-h-12 overflow-y-auto px-4 pt-3.5 pb-1"
            />
            <div className="flex items-center gap-2 px-3 pb-2.5">
              <span className="text-xs text-faint">
                {readOnly
                  ? "Enter continues in a new conversation with this thread as context · Esc locks again"
                  : running
                    ? "rocky is working · Enter steers · Ctrl+Enter after this turn · Esc stops"
                    : queues
                      ? `${full!.label} limit full · Enter queues until ${when(full!.at)} (${until(full!.at)})`
                      : "Enter to send · Shift+Enter new line"}
              </span>
              <div className="ml-auto flex items-center gap-1.5">
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => picker.current?.click()}
                  title="Attach files (or paste / drop them)"
                  className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-elevated hover:text-fg"
                >
                  <Paperclip size={16} />
                </button>
                {!readOnly && (
                  <div className="relative">
                    <button
                      type="button"
                      disabled={!canSend}
                      onClick={() => setScheduling((x) => !x)}
                      title="Send at the next session or weekly reset"
                      className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-elevated hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
                    >
                      <CalendarClock size={16} />
                    </button>
                    {scheduling && canSend && <ScheduleMenu resets={resets} usageError={usage?.error ?? null} onPick={(window) => submit({ window })} onClose={() => setScheduling(false)} />}
                  </div>
                )}
                {running && (
                  <button
                    type="button"
                    disabled={!canSend}
                    onClick={() => submit({ after: true })}
                    title="After this turn, as its own turn (Ctrl+Enter): a steer runs inside this turn, whose tool context keeps growing"
                    className="grid size-8 place-items-center rounded-full bg-elevated text-fg-2 ring-1 ring-line-strong transition-colors hover:bg-accent-glow hover:text-fg hover:ring-accent-dim disabled:bg-transparent disabled:text-faint disabled:ring-line"
                  >
                    <ListPlus size={16} />
                  </button>
                )}
                {running && (
                  <button
                    type="button"
                    onClick={stop}
                    title={conv?.outbox ? "Stop (Esc): the messages after this turn go back into the composer" : "Stop (Esc)"}
                    className="grid size-8 place-items-center rounded-full bg-elevated text-fg-2 ring-1 ring-line-strong transition-colors hover:bg-err/15 hover:text-err hover:ring-err/40"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                )}
                <button
                  title={readOnly ? "Continue in new conversation (Enter)" : running ? (asking ? "Answer rocky's question (Enter)" : "Steer: into this turn (Enter)") : queues ? `Queue until ${when(full!.at)} (Enter)` : "Send (Enter)"}
                  disabled={!canSend}
                  className="grid size-8 place-items-center rounded-full bg-accent text-base transition-colors hover:bg-accent-light disabled:bg-elevated disabled:text-faint"
                >
                  {readOnly ? <GitBranch size={16} strokeWidth={2.5} /> : running ? <CornerDownRight size={16} strokeWidth={2.5} /> : queues ? <Clock size={16} strokeWidth={2.5} /> : <ArrowUp size={17} strokeWidth={2.5} />}
                </button>
              </div>
            </div>
          </div>
        )}
      </form>

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-base/75 p-6 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-accent bg-surface/90 px-10 py-8 text-center shadow-2xl shadow-black/40">
            <Upload size={28} className="text-accent" />
            <p className="font-medium">Drop to attach</p>
            <p className="max-w-xs truncate text-sm text-muted">
              {conv ? convTitle(conv) : "New conversation"}
              {readOnly ? " · continues in a new conversation" : ""}
            </p>
          </div>
        </div>
      )}
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

type Reset = { below: number; run: () => void };

type RowProps = { item: Item; reset?: Reset; onAnswer: (requestId: string, answer: string) => void };

/** anchor: history index, as data-at for scrolling to a search hit. */
function Row({ anchor, ...props }: RowProps & { anchor?: number }) {
  if (anchor === undefined) return <RowBody {...props} />;
  return (
    <div data-at={anchor} className="scroll-mt-6 rounded-2xl">
      <RowBody {...props} />
    </div>
  );
}

function RowBody({ item, reset, onAnswer }: RowProps) {
  switch (item.kind) {
    case "user": {
      const { files, text } = splitAttachments(item.text);
      return (
        <div className="group ml-auto flex max-w-[85%] flex-col items-end gap-1">
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
          {item.skills && item.skills.length > 0 && (
            <span className="flex items-center gap-1 text-xs text-muted" title={item.skills.map((s) => `${s.name} (${s.hash})`).join(", ")}>
              <Pin size={12} /> sent along: {item.skills.map((s) => s.name).join(", ")}
            </span>
          )}
          {files.length > 0 && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {files.map((f) => (
                <AttachmentChip key={f.path} name={f.name} image={f.image} path={f.path} />
              ))}
            </div>
          )}
          {text && <div className="max-w-full rounded-2xl rounded-br-md bg-elevated px-4 py-2.5 whitespace-pre-wrap wrap-anywhere ring-1 ring-line">{text}</div>}
          <Actions text={item.text} reset={reset} />
        </div>
      );
    }
    case "agent":
      return (
        <div className="group max-w-full">
          <Markdown text={item.text} />
          {item.live && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse rounded-sm bg-accent align-middle" />}
          {!item.live && <Actions text={item.text} reset={reset} turn={item.turn} />}
        </div>
      );
    case "cron": {
      const ok = item.cron.status === "ok";
      const at = new Date(item.cron.at);
      return (
        <div className="group max-w-full">
          <div className={`rounded-xl border px-4 py-3 ${ok ? "border-line bg-surface" : "border-err/25 bg-err/[0.06]"}`}>
            <p className="mb-2 flex items-center gap-1.5 text-xs text-muted" title={`job ${item.cron.job} · run ${item.cron.run} · ${item.cron.at}`}>
              <Clock size={13} className={ok ? "text-accent" : "text-err"} />
              <span className="font-medium text-fg-2">cron{item.cron.name ? ` · ${item.cron.name}` : ""}</span>
              <span>· {isNaN(at.getTime()) ? item.cron.at : at.toLocaleString()}</span>
              {!ok && <span className="font-mono text-err">· {item.cron.status}</span>}
            </p>
            <Markdown text={item.text} />
          </div>
          <Actions text={item.text} reset={reset} />
        </div>
      );
    }
    case "tools":
      return <ToolGroup tools={item.tools} live={!!item.live} />;
    case "plan":
      return <Plan entries={item.entries} live={!!item.live} />;
    case "ask":
      return <Ask item={item} onAnswer={onAnswer} />;
    case "meta":
      return item.error ? <Banner text={item.text} /> : <p className="text-xs text-muted">{item.text}</p>;
  }
}

/** rocky's ask_user question: choices as buttons + its own answer field (the composer answers it too; broker routes it here). */
function Ask({ item, onAnswer }: { item: Extract<Item, { kind: "ask" }>; onAnswer: (requestId: string, answer: string) => void }) {
  const [text, setText] = useState("");
  const submit = () => text.trim() && onAnswer(item.requestId, text.trim());
  return (
    <div className={`rounded-xl border px-4 py-3 ${item.open ? "border-accent-dim bg-accent-glow" : "border-line bg-surface"}`}>
      <p className="mb-1 flex items-center gap-1.5 text-xs text-muted">
        <CircleHelp size={13} className={item.open ? "text-accent" : ""} />
        <span className="font-medium text-fg-2">rocky asks</span>
      </p>
      <Markdown text={item.question} />
      {item.open && item.choices.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.choices.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => onAnswer(item.requestId, c)}
              className="rounded-full bg-elevated px-3 py-1.5 text-sm text-fg-2 ring-1 ring-line-strong transition-colors hover:bg-accent-glow hover:text-fg hover:ring-accent-dim"
            >
              {c}
            </button>
          ))}
        </div>
      )}
      {item.open && (
        <form
          className="mt-3 flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            autoFocus={item.choices.length === 0}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={item.choices.length > 0 ? "Or type an answer…" : "Your answer…"}
            className="h-9 min-w-0 flex-1 rounded-lg border border-line-strong bg-input px-3 text-sm outline-none focus:border-accent"
          />
          <IconButton title="Send answer" aria-label="Send answer" type="submit" disabled={!text.trim()}>
            <ArrowUp size={16} />
          </IconButton>
        </form>
      )}
      {item.answer !== undefined && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-fg">
          <CornerDownRight size={14} className="mt-0.5 shrink-0 text-accent" />
          <span className="whitespace-pre-wrap wrap-anywhere">{item.answer}</span>
        </p>
      )}
      {item.outcome !== undefined && <p className="mt-2 font-mono text-xs text-err">{item.outcome || "closed without an answer"}</p>}
    </div>
  );
}

const tok = (n: number) => (n < 1000 ? String(n) : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);
const pad = (n: number) => String(n).padStart(2, "0");
function dur(ms: number) {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${pad(Math.floor(s % 60))}s` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Model · tokens · duration of a reply's turn, in the hover bar. */
function TurnInfo({ t }: { t: TurnModel }) {
  const parts = [`${t.provider} · ${t.model}`];
  if (t.input !== undefined && t.output !== undefined) parts.push(`${tok(t.input)} in · ${tok(t.output)} out`);
  if (t.ms !== undefined) parts.push(dur(t.ms));
  const title = [
    `Model: ${t.provider} · ${t.model}`,
    t.input !== undefined && `Input: ${t.input.toLocaleString()} tokens, summed over every model call this turn${t.cached !== undefined ? ` (${t.cached.toLocaleString()} cached)` : ""}`,
    t.output !== undefined && `Output: ${t.output.toLocaleString()} tokens`,
    t.ms !== undefined && `Turn took ${dur(t.ms)} (send to done)`,
  ].filter(Boolean).join("\n");
  return <span className="min-w-0 truncate px-1.5 font-mono text-[11px] text-faint" title={title}>{parts.join(" · ")}</span>;
}

/** Under a message, on hover (always on touch): copy its full text, reset the conversation to it (asks first), turn info. */
function Actions({ text, reset, turn }: { text: string; reset?: Reset; turn?: TurnModel }) {
  const [copied, setCopied] = useState<"ok" | string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (copied !== "ok") return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = () =>
    navigator.clipboard
      .writeText(text)
      .then(() => setCopied("ok"))
      .catch((e) => setCopied(`copy failed: ${e instanceof Error ? e.message : String(e)}`));
  const btn = "flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs transition-colors";
  const quiet = `${btn} text-muted hover:bg-elevated hover:text-fg`;

  if (confirm && reset)
    return (
      <div className="-mx-1.5 mt-0.5 flex items-center gap-1 text-xs">
        <span className="px-1.5 text-fg-2">
          Delete {reset.below} message{reset.below === 1 ? "" : "s"} below?
        </span>
        <button onClick={() => (setConfirm(false), reset.run())} className={`${btn} text-err ring-1 ring-err/40 hover:bg-err/15`}>
          <RotateCcw size={13} /> Reset to here
        </button>
        <button onClick={() => setConfirm(false)} className={quiet} title="Cancel">
          <X size={13} />
        </button>
      </div>
    );
  return (
    <div className={`-mx-1.5 mt-0.5 flex items-center gap-0.5 transition-opacity ${copied ? "" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100"}`}>
      <button onClick={copy} className={quiet} title="Copy message">
        {copied === "ok" ? <Check size={14} className="text-ok" /> : <Copy size={14} />}
      </button>
      {reset && (
        <button onClick={() => setConfirm(true)} className={quiet} title="Delete every message below this one, rocky's context included">
          <RotateCcw size={14} /> Reset to here
        </button>
      )}
      {copied && copied !== "ok" && <span className="px-1.5 font-mono text-err">{copied}</span>}
      {turn && <TurnInfo t={turn} />}
    </div>
  );
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

/** Rate-limited: the broker resumes the turn (and/or sends the queued messages) itself at resume.at. */
function Waiting({ resume, usage, onCancel, onNow, onEdit }: { resume: Resume; usage: Usage | null; onCancel: () => void; onNow: () => void; onEdit: (index: number) => void }) {
  const queued = resume.queued ?? [];
  // Full plan window: sending now only works on extra usage, so the button only shows when that's on and says so.
  // No window full (short limit, reset unknown): a plain retry.
  const window = resume.window ?? /^(\w+) usage at 100%/.exec(resume.reason)?.[1];
  const extra = usage?.extra;
  const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: extra?.currency || "EUR" });
  const now = !window
    ? { label: "Retry now", title: "Retry now instead of waiting (fails again if the limit is still hit)" }
    : extra?.available
      ? {
          label: `Send now · extra usage`,
          title: `Runs on extra usage (paid credits past the plan limit): ${money(extra.used)} used this month${extra.limit !== null ? ` of ${money(extra.limit)}` : ", no monthly cap set"}`,
        }
      : null;
  const verb = resume.queuedOnly
    ? queued.length === 1 ? "Sends it" : `Sends these ${queued.length}, one turn each, from`
    : queued.length ? "Resumes, then sends these one turn each, from" : "Resumes automatically";
  return (
    <div className="flex flex-col gap-2">
      {queued.map((q, i) => (
        <HeldBubble key={i} tone="info" label={<><Clock size={12} /> queued · {i === 0 ? `sends ${when(resume.at)}` : "own turn after the one before"}</>} text={q} onEdit={() => onEdit(i)} />
      ))}
      <div className="flex items-center gap-2.5 rounded-xl border border-info/25 bg-info/[0.06] px-3.5 py-2.5 text-sm">
        <Clock size={16} className="shrink-0 text-info" />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-fg">
            {verb} {when(resume.at)}
            <span className="font-normal text-muted">
              {" "}
              · {until(resume.at)}
              {!resume.queuedOnly && ` · attempt ${resume.attempt}${resume.max ? `/${resume.max}` : ""}`}
            </span>
          </p>
          <p className="font-mono text-xs break-words text-fg-2">{resume.reason}</p>
        </div>
        {now && (
          <button
            onClick={onNow}
            title={now.title}
            className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-fg-2 ring-1 ring-line-strong transition-colors hover:bg-elevated hover:text-fg"
          >
            <Send size={13} /> {now.label}
          </button>
        )}
        <button
          onClick={onCancel}
          title={queued.length ? "Cancel: queued messages go back into the composer" : "Cancel auto-resume (Esc)"}
          className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-line-strong hover:text-fg"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

/** Menu above the schedule button: send at the next session (5 h) or weekly reset. */
function ScheduleMenu({ resets, usageError, onPick, onClose }: { resets: Usage["windows"]; usageError: string | null; onPick: (window: string) => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && onClose();
    const esc = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    addEventListener("mousedown", away);
    addEventListener("keydown", esc, true);
    return () => {
      removeEventListener("mousedown", away);
      removeEventListener("keydown", esc, true);
    };
  }, []);
  return (
    <div ref={box} data-popover-open className="absolute right-0 bottom-10 z-20 flex w-72 flex-col gap-0.5 rounded-xl border border-line-strong bg-surface p-1.5 shadow-xl shadow-black/40">
      <p className="px-2 pt-1 pb-1.5 text-xs text-faint">Send at the next reset</p>
      {resets.map((w) => (
        <button
          key={w.key}
          type="button"
          disabled={!w.resets_at || Date.parse(w.resets_at) <= Date.now()}
          onClick={() => onPick(w.key)}
          className="flex items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-fg-2 hover:bg-elevated hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <span>{w.key === "five_hour" ? "Session reset" : "Weekly reset"}</span>
          <span className="ml-auto font-mono text-xs text-muted">{w.resets_at ? `${when(w.resets_at)} · ${until(w.resets_at)}` : "not started"}</span>
        </button>
      ))}
      {!resets.length && <p className="px-2 py-1.5 font-mono text-xs break-words text-err">{usageError ? `usage: ${usageError}` : "usage not loaded yet"}</p>}
    </div>
  );
}

/** Held-back bubble (queued, next up, scheduled): dashed, with Edit = back into the composer. */
function HeldBubble({ label, text, tone, onEdit }: { label: React.ReactNode; text: string; tone: "info" | "muted"; onEdit: () => void }) {
  return (
    <div className="group ml-auto flex max-w-[85%] flex-col items-end gap-1">
      <span className={`flex items-center gap-1 text-xs ${tone === "info" ? "text-info" : "text-muted"}`}>{label}</span>
      <div className={`max-w-full rounded-2xl rounded-br-md border border-dashed px-4 py-2.5 whitespace-pre-wrap wrap-anywhere text-fg-2 ${tone === "info" ? "border-info/40 bg-info/[0.06]" : "border-line-strong bg-elevated/40"}`}>
        {previewText(text)}
      </div>
      <button
        onClick={onEdit}
        title="Take it out, back into the composer"
        className="flex h-6 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted opacity-0 transition-colors group-hover:opacity-100 hover:bg-elevated hover:text-fg pointer-coarse:opacity-100"
      >
        <Pencil size={13} /> Edit
      </button>
    </div>
  );
}

/** Messages that go out one turn each after the running turn (queued at a reset, scheduled). */
function OutboxList({ outbox, running, onNow, onCancel, onEdit }: { outbox: Outbox; running: boolean; onNow: () => void; onCancel: () => void; onEdit: (index: number) => void }) {
  const n = outbox.items.length;
  return (
    <div className="flex flex-col gap-2">
      {outbox.items.map((q, i) => (
        <HeldBubble key={i} tone="muted" label={<><ListOrdered size={12} /> {i === 0 ? "next" : `#${i + 1}`} · own turn</>} text={q} onEdit={() => onEdit(i)} />
      ))}
      {outbox.held ? (
        <div className="flex items-center gap-2.5 rounded-xl border border-err/25 bg-err/[0.06] px-3.5 py-2.5 text-sm">
          <CircleAlert size={16} className="shrink-0 text-err" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-fg">Paused: {n === 1 ? "this message waits" : `these ${n} wait`} because the last turn failed</p>
            <p className="font-mono text-xs break-words text-err/90">{outbox.held}</p>
          </div>
          <button onClick={onNow} title="Send the next one now" className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-fg-2 ring-1 ring-line-strong transition-colors hover:bg-elevated hover:text-fg">
            <Send size={13} /> Send next
          </button>
          <button onClick={onCancel} title="Cancel: back into the composer" className="-mr-1 grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-line-strong hover:text-fg">
            <X size={14} />
          </button>
        </div>
      ) : (
        <p className="ml-auto text-xs text-faint">{running ? `${n === 1 ? "Goes" : `These ${n} go`} out after this turn, one turn each (smaller context)` : "Sending…"}</p>
      )}
    </div>
  );
}

/** Messages the broker sends at a usage window's reset. */
function ScheduledList({ list, onEdit }: { list: Scheduled[]; onEdit: (index: number) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {list.map((s, i) => (
        <HeldBubble
          key={`${s.at}-${i}`}
          tone="info"
          label={<span title={new Date(s.at).toLocaleString()} className="flex items-center gap-1"><CalendarClock size={12} /> {s.label} reset · {when(s.at)} · {until(s.at)}</span>}
          text={s.text}
          onEdit={() => onEdit(i)}
        />
      ))}
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
