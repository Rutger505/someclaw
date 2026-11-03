import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChat, type Item } from "../lib/useChat";
import { Markdown } from "./Markdown";
import { DASHBOARD_URL } from "../App";

type Props = { sessionId: string; onIdle: (idle: boolean) => void; onUnauthorized: () => void };

export function Chat({ sessionId, onIdle, onUnauthorized }: Props) {
  const { items, status, busy, send } = useChat(sessionId, onUnauthorized);
  const [draft, setDraft] = useState("");
  const log = useRef<HTMLDivElement>(null);
  const stick = useRef(true); // follow new output only while scrolled to the bottom

  useEffect(() => onIdle(!busy && !draft), [busy, draft]);
  useLayoutEffect(() => {
    if (stick.current && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [items]);

  const submit = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    stick.current = true;
    send(text);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-line px-4 py-2 text-sm">
        <span className="font-semibold text-accent">someclaw</span>
        <span className="text-muted">rocky</span>
        <span className={`size-2 rounded-full ${status === "open" ? (busy ? "bg-warn animate-pulse" : "bg-ok") : "bg-err"}`} title={status} />
        <a href={DASHBOARD_URL} className="ml-auto text-muted hover:text-accent-light">dashboard ↗</a>
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
          {items.map((item, i) => <Row key={i} item={item} />)}
        </div>
      </div>

      <form
        className="border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="mx-auto flex max-w-3xl gap-2">
          <textarea
            autoFocus
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Message rocky"
            className="field-sizing-content max-h-60 min-h-10 flex-1 resize-none rounded-md border border-line-strong bg-input px-3 py-2 outline-none placeholder:text-faint focus:border-accent"
          />
          <button className="rounded-md bg-accent px-4 font-medium text-base hover:bg-accent-light disabled:opacity-40" disabled={!draft.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function Row({ item }: { item: Item }) {
  switch (item.kind) {
    case "user":
      return <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-accent-glow px-3 py-2 ring-1 ring-accent-dim">{item.text}</div>;
    case "agent":
      return (
        <div className="max-w-full">
          <Markdown text={item.text} />
          {item.live && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" />}
        </div>
      );
    case "tool":
      return (
        <details className="group rounded-md border border-line bg-surface font-mono text-xs">
          <summary className="cursor-pointer list-none px-2 py-1 text-fg-2 hover:text-fg">
            <span className={item.output === undefined ? "text-warn" : "text-ok"}>{item.output === undefined ? "…" : "✓"}</span> {item.name}
            <span className="text-faint"> {JSON.stringify(item.args).slice(0, 80)}</span>
          </summary>
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-line px-2 py-1 text-fg-2">
            {JSON.stringify(item.args, null, 2)}
            {item.output !== undefined && `\n\n← ${item.output}`}
          </pre>
        </details>
      );
    case "meta":
      return <div className={`font-mono text-xs ${item.error ? "text-err" : "text-muted"}`}>{item.text}</div>;
  }
}
