import { Bot, Check, ChevronDown, Circle, ListTodo, Wrench, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PlanEntry, Subagent, Tool } from "../lib/items";

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
 * latest at the bottom; a finished subagent's steps are rows too, indented under its spawn call. Each running subagent's
 * spawn call gets its own block below instead (the call row, then its plan and latest steps nested under it), so parallel
 * subagents all stay visible; a finished one with a plan keeps its block with just the plan. Clicking a row
 * expands the group with that call opened; the header toggles the group. Expanded: every call, each opening to args + output.
 */
export function ToolGroup({ tools, live }: { tools: Tool[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState<number | null>(null);
  const running = tools.filter((t) => t.output === undefined).length;
  const isRunning = (t: Tool) => live && !!t.sub && !t.sub.ended;
  // Spawn calls of running subagents, or finished ones with a plan, get their own block below the ticker:
  // the call row itself, with its plan and (while running) latest steps nested under it.
  const windowed = (t: Tool) => !!t.sub && (isRunning(t) || !!subPlan(t.sub));
  // Collapsed rows: every other call, then its finished subagent's steps.
  const rows: Row[] = tools.flatMap((t, i) =>
    windowed(t)
      ? []
      : [{ t, i, sub: false, live }, ...(t.sub?.steps ?? []).map((step) => ({ t: step, i, sub: true, live: false }))],
  );
  const openAt = (i: number) => {
    setFocus(i);
    setOpen(true);
  };

  return (
    <div>
      <button
        onClick={() => {
          setFocus(null);
          setOpen((x) => !x);
        }}
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
            <div key={t.id || i}>
              <ToolDetails t={t} live={live} focused={focus === i} />
              {t.sub && <SubagentSteps sub={t.sub} live={live} />}
            </div>
          ))}
        </div>
      ) : (
        <>
          <Ticker rows={rows} onOpen={openAt} />
          {tools.map((t, i) => {
            if (!windowed(t)) return null;
            const run = isRunning(t);
            const plan = subPlan(t.sub!);
            return (
              <div key={`sub-${t.id || i}`} className="mt-3">
                <ToolLine t={t} live={live} sub={false} onClick={() => openAt(i)} />
                <div className="ml-1.5 border-l-2 border-line pl-3">
                  {plan && <Plan entries={plan} live={run} />}
                  {run && <Ticker rows={t.sub!.steps.map((step) => ({ t: step, i, sub: false, live: true }))} onOpen={openAt} />}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

type Row = { t: Tool; i: number; sub: boolean; live: boolean };

/** Window of the last VISIBLE rows, sliding up as rows arrive. */
function Ticker({ rows, onOpen }: { rows: Row[]; onOpen: (i: number) => void }) {
  const hidden = Math.max(0, rows.length - VISIBLE);
  return (
    <div
      style={{ height: Math.min(rows.length, VISIBLE) * ROW }}
      className={`overflow-hidden font-mono text-xs transition-[height] duration-200 ease-out motion-reduce:transition-none ${
        hidden ? "mask-t-from-60%" : ""
      }`}
    >
      <div
        style={{ transform: `translateY(-${hidden * ROW}px)` }}
        className="transition-transform duration-300 ease-out motion-reduce:transition-none"
      >
        {rows.map(({ t, i, sub, live }, row) => (
          <ToolLine key={`${t.id || i}-${row}`} t={t} live={live} sub={sub} onClick={() => onOpen(i)} />
        ))}
      </div>
    </div>
  );
}

function Status({ t, live }: { t: Tool; live: boolean }) {
  if (t.output !== undefined) return <Check size={12} strokeWidth={3} className="shrink-0 text-ok" />;
  if (!live) return <X size={12} strokeWidth={3} className="shrink-0 text-err" />;
  return <span className="size-3 shrink-0 animate-spin rounded-full border-[1.5px] border-warn border-t-transparent" />;
}

function ToolLine({ t, live, sub, onClick }: { t: Tool; live: boolean; sub: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title="Open this call"
      className={`-mx-2 flex h-6 w-[calc(100%+1rem)] cursor-pointer ${sub ? "pl-7" : ""} items-center gap-2 rounded-md px-2 text-left text-fg-2 transition-opacity duration-300 hover:bg-elevated hover:text-fg starting:opacity-0`}
    >
      {sub && <Bot size={12} className="shrink-0 text-muted" />}
      <Status t={t} live={live} />
      <span className="shrink-0 text-accent-light">{t.name}</span>
      {t.sub && <span className="shrink-0 text-muted">{steps(t.sub)}</span>}
      <span className="truncate text-faint">{brief(t.args)}</span>
    </button>
  );
}

function ToolDetails({ t, live, focused }: { t: Tool; live: boolean; focused: boolean }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!focused || !ref.current) return;
    ref.current.open = true;
    ref.current.scrollIntoView({ block: "nearest" });
  }, [focused]);

  return (
    <details ref={ref} className="group">
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

/** A subagent's plan: the gateway sends no "plan" event for it, so the args of its latest TodoWrite. */
function subPlan(sub: Subagent): PlanEntry[] | null {
  const todos = (sub.steps.findLast((t) => t.name === "TodoWrite")?.args as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return null;
  return todos.map((x: Record<string, unknown>) => ({
    content: String(x.content ?? ""),
    activeForm: typeof x.activeForm === "string" ? x.activeForm : undefined,
    status: String(x.status ?? "pending"),
  }));
}

const steps = (sub: Subagent) => `${sub.steps.length} step${sub.steps.length === 1 ? "" : "s"}`;

/** What a spawn_subagent call's subagent did, nested under it: its plan, then its steps as a regular tool group.
 * Its own running state: until subagent_end, while the turn is live. */
function SubagentSteps({ sub, live }: { sub: Subagent; live: boolean }) {
  const running = live && !sub.ended;
  const plan = subPlan(sub);
  return (
    <div className="mt-1 mb-4 ml-5 border-l-2 border-line pl-3 font-sans">
      {plan && <Plan entries={plan} live={running} />}
      {sub.steps.length > 0 && <ToolGroup tools={sub.steps} live={running} />}
      {!live && !sub.ended && <div className="text-err">no subagent_end</div>}
      {sub.ended && !sub.success && <div className="whitespace-pre-wrap break-words text-err">{sub.error || "subagent_end: success=false, no error"}</div>}
      {sub.truncated !== undefined && <div className="text-faint">later steps not kept (someclaw keeps {sub.truncated} per subagent)</div>}
    </div>
  );
}

/** TodoWrite plan as a checklist; in_progress shows its activeForm, spinning while the turn runs. */
export function Plan({ entries, live }: { entries: PlanEntry[]; live: boolean }) {
  const done = entries.filter((e) => e.status === "completed").length;
  return (
    <div className="text-xs">
      <div className="flex h-8 items-center gap-2 text-muted">
        <ListTodo size={13} />
        <span className="font-medium">
          Plan · {done}/{entries.length}
        </span>
      </div>
      <ul className="space-y-1">
        {entries.map((e, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5 flex size-3 shrink-0 items-center justify-center">
              {e.status === "completed" ? (
                <Check size={12} strokeWidth={3} className="text-ok" />
              ) : e.status === "in_progress" ? (
                live ? (
                  <span className="size-3 animate-spin rounded-full border-[1.5px] border-warn border-t-transparent" />
                ) : (
                  <Circle size={10} strokeWidth={3} className="fill-warn text-warn" />
                )
              ) : (
                <Circle size={10} className="text-faint" />
              )}
            </span>
            <span
              className={
                e.status === "completed" ? "text-faint line-through" : e.status === "in_progress" ? "text-fg" : "text-fg-2"
              }
            >
              {e.status === "in_progress" && e.activeForm ? e.activeForm : e.content}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
