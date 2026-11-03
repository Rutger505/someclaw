import { useState } from "react";
import type { Tool } from "../lib/items";

const brief = (args: unknown) => {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const main = a.command ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.prompt;
    if (typeof main === "string") return main;
  }
  return JSON.stringify(args);
};

/** A run of tool calls as one line: the latest call, "+N" to expand the rest. Each call expands to args + output. */
export function ToolGroup({ tools, live }: { tools: Tool[]; live: boolean }) {
  const [all, setAll] = useState(false);
  const shown = all ? tools : tools.slice(-1);
  const running = tools.filter((t) => t.output === undefined).length;
  return (
    <div className="rounded-md border border-line bg-surface font-mono text-xs">
      {tools.length > 1 && (
        <button onClick={() => setAll((x) => !x)} className="w-full px-2 py-1 text-left text-muted hover:text-fg-2">
          {all ? "▾" : "▸"} {tools.length} tool calls
          {running > 0 && live && <span className="text-warn"> · {running} running</span>}
        </button>
      )}
      {shown.map((t, i) => (
        <ToolRow key={t.id || i} t={t} live={live} />
      ))}
    </div>
  );
}

function ToolRow({ t, live }: { t: Tool; live: boolean }) {
  const pending = t.output === undefined;
  return (
    <details className="border-t border-line first:border-t-0">
      <summary className="flex cursor-pointer list-none gap-1.5 px-2 py-1 text-fg-2 hover:text-fg">
        <span className={pending ? (live ? "animate-pulse text-warn" : "text-err") : "text-ok"}>{pending ? (live ? "…" : "✕") : "✓"}</span>
        <span className="text-accent-light">{t.name}</span>
        <span className="truncate text-faint">{brief(t.args)}</span>
      </summary>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap border-t border-line px-2 py-1 text-fg-2">
        {JSON.stringify(t.args, null, 2)}
        {!pending && `\n\n← ${t.output}`}
      </pre>
    </details>
  );
}
