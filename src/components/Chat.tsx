import { Archive, ArchiveRestore, ArrowUp, Check, CircleAlert, CircleHelp, Clock, Copy, CornerDownRight, FileText, GitBranch, Image, Loader, Lock, PanelLeft, Paperclip, Pin, RotateCcw, Square, X } from "lucide-react";
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import { splitAttachments, withAttachments, type Attachment } from "../../shared/attachments";
import type { ClientMsg, Conversation, Resume, TurnModel } from "../../shared/protocol";
import type { Snapshot } from "../lib/broker";
import { uploadFile } from "../lib/gateway";
import { buildItems, type Item } from "../lib/items";
import { Markdown } from "./Markdown";
import { convTitle, IconButton, Kbd, StatusDot } from "./Sidebar";
import { Plan, ToolGroup } from "./Tools";
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

/** A composer attachment: uploads as soon as it's added, sent as a media marker once done. */
type Pending = { key: string; name: string; image: boolean; file?: Attachment; error?: string };

export const Chat = forwardRef<ChatHandle, Props>(function Chat({ id, conv, snap, send, onDraft, onToggleSidebar, onOpen }, ref) {
  const [draft, setDraft] = useState("");
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
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
    setFiles([]);
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

  const uploading = files.some((f) => !f.file && !f.error);
  const failed = files.some((f) => f.error);
  const canSend = (!!draft.trim() || files.length > 0) && !uploading && !failed;

  const addFiles = (list: FileList | File[]) => {
    for (const f of Array.from(list)) {
      const key = crypto.randomUUID();
      setFiles((fs) => [...fs, { key, name: f.name, image: f.type.startsWith("image/") }]);
      uploadFile(f).then(
        (file) => setFiles((fs) => fs.map((p) => (p.key === key ? { ...p, file, image: file.image } : p))),
        (e) => setFiles((fs) => fs.map((p) => (p.key === key ? { ...p, error: (e as Error).message } : p))),
      );
    }
    input.current?.focus();
  };

  /** Idle: starts a turn. While rocky works: steers it (no queue). Channel sessions: forks into a new conversation. */
  const submit = () => {
    if (!canSend) return;
    const text = withAttachments(draft.trim(), files.map((f) => f.file!));
    setDraft("");
    setFiles([]);
    stick.current = true;
    if (!readOnly) return send({ type: "send", id, text });
    const fork = crypto.randomUUID();
    send({ type: "fork", from: id, id: fork, text });
    onOpen(fork);
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
          {snap && !items.length && <Empty />}
          {items.map((item, i) => (
            <Row
              key={i}
              item={item}
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
          {conv?.resume && !running && <Waiting resume={conv.resume} onCancel={() => send({ type: "abort", id })} />}
          {running && !asking && items.at(-1)?.kind !== "agent" && <Thinking />}
        </div>
      </div>

      <form
        className={`${COLUMN} relative pb-5 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-linear-to-t before:from-base before:to-transparent`}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onDragOver={(e) => {
          if (locked || !e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(e) => {
          setDragging(false);
          if (locked || !e.dataTransfer.files.length) return;
          e.preventDefault();
          addFiles(e.dataTransfer.files);
        }}
      >
        {locked ? (
          <Locked channel={conv?.channel ?? "channel"} onUnlock={() => setUnlocked(true)} />
        ) : (
          <div className={`rounded-2xl border bg-surface shadow-lg shadow-black/20 transition-colors focus-within:border-accent-dim ${dragging ? "border-accent" : "border-line-strong"}`}>
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                {files.map((f) => (
                  <span
                    key={f.key}
                    title={f.error ?? f.file?.path ?? "uploading…"}
                    className={`flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1 text-xs ring-1 ${f.error ? "bg-err/10 text-err ring-err/40" : "bg-elevated text-fg-2 ring-line"}`}
                  >
                    {f.error ? <CircleAlert size={13} /> : !f.file ? <Loader size={13} className="animate-spin" /> : f.image ? <Image size={13} /> : <FileText size={13} />}
                    <span className="min-w-0 truncate">{f.error ?? f.name}</span>
                    <button type="button" onClick={() => setFiles((fs) => fs.filter((p) => p.key !== f.key))} title="Remove" className="text-faint hover:text-fg">
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <textarea
              ref={input}
              autoFocus
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onPaste={(e) => {
                if (!e.clipboardData.files.length) return;
                e.preventDefault();
                addFiles(e.clipboardData.files);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape" && readOnly && !draft) {
                  e.preventDefault();
                  setUnlocked(false); // back to read-only
                }
              }}
              placeholder={readOnly ? "Continue in a new someclaw conversation…" : asking ? "Answer rocky…" : running ? "Steer rocky…" : "Message rocky…"}
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
                  disabled={!canSend}
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

type Reset = { below: number; run: () => void };

function Row({ item, reset, onAnswer }: { item: Item; reset?: Reset; onAnswer: (requestId: string, answer: string) => void }) {
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
                <span key={f.path} title={f.path} className="flex max-w-full items-center gap-1.5 rounded-lg bg-elevated px-2 py-1 text-xs text-fg-2 ring-1 ring-line">
                  {f.image ? <Image size={13} /> : <FileText size={13} />}
                  <span className="min-w-0 truncate">{f.name}</span>
                </span>
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

/** rocky's ask_user question: choices as buttons; a free answer goes through the composer (broker routes it here). */
function Ask({ item, onAnswer }: { item: Extract<Item, { kind: "ask" }>; onAnswer: (requestId: string, answer: string) => void }) {
  return (
    <div className={`rounded-xl border px-4 py-3 ${item.open ? "border-accent-dim bg-accent-glow" : "border-line bg-surface"}`}>
      <p className="mb-1 flex items-center gap-1.5 text-xs text-muted">
        <CircleHelp size={13} className={item.open ? "text-accent" : ""} />
        <span className="font-medium text-fg-2">rocky asks</span>
        {item.open && <span>· answer below{item.choices.length > 0 && " or pick one"}</span>}
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
          <span className="font-normal text-muted"> · attempt {resume.attempt}{resume.max ? `/${resume.max}` : ""}</span>
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
