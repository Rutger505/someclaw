import { Check, ChevronDown, Wrench, X } from "lucide-react";
import { useState } from "react";
import type { Tool } from "../lib/items";

const ROW = 24; // px, every row is h-6 so the ticker can scroll by whole rows
const VISIBLE = 3;

const brief = (args: unknown) => {
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const main = a.command ?? a.path ?? a.pattern ?? a.query ?? a.url ?? a.prompt;
    if (typeof main === "string") return main;
  }
  return JSON.stringify(args);
};

/**
 * A run of tool calls. Collapsed: a 3-row window that slides up as calls arrive (no manual scroll),
 * latest at the bottom. Click to expand: every call, each opening to args + output.
 */
export function ToolGroup({ tools, live }: { tools: Tool[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = tools.filter((t) => t.output === undefined).length;
  const hidden = Math.max(0, tools.length - VISIBLE);

  return (
    <div>
      <button
        onClick={() => setOpen((x) => !x)}
        className="flex h-8 items-center gap-2 text-left text-xs text-muted transition-colors hover:text-fg-2"
      >
        <Wrench size={13} />
        <span className="font-medium">
          {tools.length} tool call{tools.length === 1 ? "" : "s"}
        </span>
        <ChevronDown size={14} className={`transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
        {running > 0 && live && <span className="text-warn">· running</span>}
      </button>

      {open ? (
        <div className="max-h-[32rem] overflow-y-auto font-mono text-xs">
          {tools.map((t, i) => (
            <ToolDetails key={t.id || i} t={t} live={live} />
          ))}
        </div>
      ) : (
        <div
          onClick={() => setOpen(true)}
          style={{ height: Math.min(tools.length, VISIBLE) * ROW }}
          className={`cursor-pointer overflow-hidden font-mono text-xs transition-[height] duration-200 ease-out motion-reduce:transition-none ${
            hidden ? "mask-t-from-60%" : ""
          }`}
        >
          <div
            style={{ transform: `translateY(-${hidden * ROW}px)` }}
            className="transition-transform duration-300 ease-out motion-reduce:transition-none"
          >
            {tools.map((t, i) => (
              <ToolLine key={t.id || i} t={t} live={live} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Status({ t, live }: { t: Tool; live: boolean }) {
  if (t.output !== undefined) return <Check size={12} strokeWidth={3} className="shrink-0 text-ok" />;
  if (!live) return <X size={12} strokeWidth={3} className="shrink-0 text-err" />;
  return <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-warn border-t-transparent" />;
}

function ToolLine({ t, live }: { t: Tool; live: boolean }) {
  return (
    <div className="flex h-6 items-center gap-2 text-fg-2 transition-opacity duration-300 starting:opacity-0">
      <Status t={t} live={live} />
      <span className="shrink-0 text-accent-light">{t.name}</span>
      <span className="truncate text-faint">{brief(t.args)}</span>
    </div>
  );
}

function ToolDetails({ t, live }: { t: Tool; live: boolean }) {
  return (
    <details className="group">
      <summary className="-mx-2 flex h-6 cursor-pointer list-none items-center gap-2 rounded-md px-2 text-fg-2 hover:bg-elevated hover:text-fg">
        <Status t={t} live={live} />
        <span className="shrink-0 text-accent-light">{t.name}</span>
        <span className="truncate text-faint">{brief(t.args)}</span>
      </summary>
      <pre className="my-1 max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-code px-3 py-2 text-fg-2">
        {JSON.stringify(t.args, null, 2)}
        {t.output !== undefined && `\n\n← ${t.output}`}
      </pre>
    </details>
  );
}
