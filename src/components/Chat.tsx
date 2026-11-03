import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ClientMsg, Conversation } from "../../shared/protocol";
import type { Snapshot } from "../lib/broker";
import { buildItems, type Item } from "../lib/items";
import { Markdown } from "./Markdown";
import { ToolGroup } from "./Tools";
import { convTitle, StatusDot } from "./Sidebar";

export type ChatHandle = { focus: () => void; rename: () => void };

type Props = {
  id: string;
  conv: Conversation | undefined;
  snap: Snapshot | null;
  send: (m: ClientMsg) => void;
  onDraft: (empty: boolean) => void;
  onToggleSidebar: () => void;
};

export const Chat = forwardRef<ChatHandle, Props>(function Chat({ id, conv, snap, send, onDraft, onToggleSidebar }, ref) {
  const [draft, setDraft] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow new output only while scrolled to the bottom
  const items = useMemo(() => (snap?.id === id ? buildItems(snap) : []), [snap, id]);
  const running = conv?.status === "running";
  const readOnly = !!conv?.channel;

  useImperativeHandle(ref, () => ({
    focus: () => input.current?.focus(),
    rename: () => conv && setRenaming(conv.name ?? ""),
  }));

  // Drafts per conversation, kept across switches and reloads.
  useEffect(() => {
    setDraft(localStorage.getItem(`draft.${id}`) ?? "");
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

  const submit = (steer: boolean) => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    stick.current = true;
    send(steer ? { type: "steer", id, text } : { type: "send", id, text });
  };

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm">
        <button onClick={onToggleSidebar} title="Sidebar (Ctrl+B)" className="text-muted hover:text-fg">
          ☰
        </button>
        {conv && <StatusDot c={conv} />}
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
              className="w-full rounded border border-accent bg-input px-2 py-0.5 outline-none"
            />
          </form>
        ) : (
          <span
            className="flex-1 truncate font-medium"
            onDoubleClick={() => conv && !readOnly && setRenaming(conv.name ?? "")}
            title={conv ? "double-click or Alt+R to rename" : undefined}
          >
            {conv ? convTitle(conv) : <span className="text-muted">New conversation</span>}
          </span>
        )}
        {conv?.titleError && <span className="max-w-64 truncate font-mono text-xs text-err" title={conv.titleError}>{conv.titleError}</span>}
        {running && (
          <button onClick={() => send({ type: "abort", id })} className="rounded border border-err/50 px-2 py-0.5 text-xs text-err hover:bg-err/10" title="Esc">
            stop
          </button>
        )}
        {conv && (
          <button onClick={() => send({ type: "archive", id, archived: !conv.archived })} className="text-xs text-muted hover:text-accent-light" title="Alt+A">
            {conv.archived ? "unarchive" : "archive"}
          </button>
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
        <div className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4">
          {snap?.historyError && <p className="font-mono text-xs text-err">history: {snap.historyError}</p>}
          {!snap && <p className="font-mono text-xs text-muted">loading…</p>}
          {snap && !items.length && <p className="pt-24 text-center text-muted">New conversation with rocky</p>}
          {items.map((item, i) => <Row key={i} item={item} />)}
          {conv?.error && !running && <p className="font-mono text-xs text-err">error: {conv.error}</p>}
          {running && items.at(-1)?.kind === "user" && <span className="inline-block h-4 w-1.5 animate-pulse bg-accent" />}
        </div>
      </div>

      {conv && (conv.queue.length > 0 || conv.paused) && (
        <div className="mx-auto w-full max-w-3xl px-3 pt-2">
          <div className="rounded-md border border-line bg-surface text-sm">
            <div className="flex items-center gap-2 px-3 py-1 text-xs text-muted">
              <span>
                queue · {conv.queue.length}
                {conv.paused && <span className="text-warn"> · paused (after a stop, error or restart)</span>}
              </span>
              {conv.paused && (
                <button onClick={() => send({ type: "resume", id })} className="ml-auto text-accent-light hover:underline">
                  resume
                </button>
              )}
            </div>
            {conv.queue.map((q) => (
              <div key={q.qid} className="group flex items-start gap-2 border-t border-line px-3 py-1.5">
                <span className="flex-1 whitespace-pre-wrap text-fg-2">{q.text}</span>
                <button onClick={() => send({ type: "steer", id, qid: q.qid })} className="text-xs text-accent-light hover:underline" title="send into the running turn now">
                  steer
                </button>
                <button onClick={() => send({ type: "unqueue", id, qid: q.qid })} className="text-xs text-muted hover:text-err" title="remove">
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <form
        className="p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            ref={input}
            autoFocus
            rows={1}
            value={draft}
            disabled={readOnly}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit(e.altKey);
              }
            }}
            placeholder={readOnly ? `${conv?.channel}: read-only here` : running ? "Queue a message (Alt+Enter: steer now)" : "Message rocky"}
            className="field-sizing-content max-h-60 min-h-10 flex-1 resize-none rounded-md border border-line-strong bg-input px-3 py-2 outline-none placeholder:text-faint focus:border-accent disabled:opacity-50"
          />
          <button className="rounded-md bg-accent px-4 font-medium text-base hover:bg-accent-light disabled:opacity-40" disabled={!draft.trim() || readOnly}>
            {running ? "Queue" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
});

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return (
        <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-accent-glow px-3 py-2 ring-1 ring-accent-dim">
          {item.steer && <span className="mr-1 font-mono text-xs text-accent">steer</span>}
          {item.text}
        </div>
      );
    case "agent":
      return (
        <div className="max-w-full">
          <Markdown text={item.text} />
          {item.live && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" />}
        </div>
      );
    case "tools":
      return <ToolGroup tools={item.tools} live={!!item.live} />;
    case "meta":
      return <div className={`font-mono text-xs ${item.error ? "text-err" : "text-muted"}`}>{item.text}</div>;
  }
}
