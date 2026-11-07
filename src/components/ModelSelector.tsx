import { Check, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelOption } from "../../shared/protocol";
import { api } from "../lib/gateway";

type ConfigEntry = { path: string; value: unknown };

/** Provider profiles (providers.models.<family>.<alias>) + rocky's default ref. Loaded once per page. */
let optionsPromise: Promise<{ options: ModelOption[]; defaultRef: string | null }> | null = null;
function loadOptions() {
  return (optionsPromise ??= Promise.all([
    api<{ entries: ConfigEntry[] }>("/api/config/list?prefix=providers.models"),
    api<{ value: unknown }>("/api/config/prop?path=agents.rocky.model_provider"),
  ])
    .then(([config, current]) => ({
      options: config.entries
        .flatMap((e) => {
          const m = /^providers\.models\.([^.]+)\.([^.]+)\.model$/.exec(e.path);
          return m ? [{ ref: `${m[1]}.${m[2]}`, family: m[1]!, alias: m[2]!, model: typeof e.value === "string" ? e.value : "" }] : [];
        })
        .sort((a, b) => a.family.localeCompare(b.family) || a.model.localeCompare(b.model) || a.alias.localeCompare(b.alias)),
      defaultRef: typeof current.value === "string" ? current.value : null,
    }))
    .catch((e) => {
      optionsPromise = null; // retry on next open
      throw e;
    }));
}

const label = (o: ModelOption) => o.model || o.alias;

/** Per-conversation model picker: one dropdown, grouped by provider family. value null = rocky's default. */
export function ModelSelector({ value, onChange }: { value: string | null; onChange: (ref: string | null) => void }) {
  const [data, setData] = useState<{ options: ModelOption[]; defaultRef: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    loadOptions()
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [open]);

  const options = data?.options ?? [];
  const def = options.find((o) => o.ref === data?.defaultRef);
  // Flat list for keyboard nav: default first, then each family's profiles.
  const flat: (string | null)[] = useMemo(() => [null, ...options.map((o) => o.ref)], [options]);
  const groups = useMemo(() => {
    const g = new Map<string, ModelOption[]>();
    for (const o of options) g.set(o.family, [...(g.get(o.family) ?? []), o]);
    return [...g];
  }, [options]);
  const current = options.find((o) => o.ref === value);

  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, flat.indexOf(value)));
    const close = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const pick = (ref: string | null) => {
    setOpen(false);
    if (ref !== value) onChange(ref);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) (e.preventDefault(), setOpen(true));
      return;
    }
    const k = { ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (k) {
      e.preventDefault();
      setActive((a) => (a + k + flat.length) % flat.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(flat[active] ?? null);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation(); // don't stop the running turn
      setOpen(false);
    } else if (e.key === "Tab") setOpen(false);
  };

  const unknown = value && data && !current; // chosen profile no longer in config
  const buttonText = current ? label(current) : unknown ? value : def ? label(def) : "Default";

  const row = (ref: string | null, i: number, main: string, sub: string) => (
    <div
      key={ref ?? "default"}
      role="option"
      aria-selected={ref === value}
      data-i={i}
      onPointerEnter={() => setActive(i)}
      onClick={() => pick(ref)}
      className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 ${i === active ? "bg-elevated text-fg" : "text-fg-2"}`}
    >
      <span className="grid size-3.5 shrink-0 place-items-center">{ref === value && <Check size={14} className="text-accent" />}</span>
      <span className="min-w-0 flex-1 truncate text-sm">{main}</span>
      <span className="shrink-0 font-mono text-[11px] text-faint">{sub}</span>
    </div>
  );

  let i = 1;
  return (
    <div ref={root} className="relative" onKeyDown={onKey}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={`Model for this conversation: ${value ?? `default (${data?.defaultRef ?? "?"})`}`}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-8 max-w-44 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-elevated hover:text-fg sm:max-w-64 ${
          open ? "bg-elevated text-fg" : unknown ? "text-err" : "text-fg-2"
        }`}
      >
        <span className="truncate">{buttonText}</span>
        {!value && <span className="shrink-0 text-faint">default</span>}
        <ChevronDown size={14} className={`shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div
          ref={listRef}
          role="listbox"
          data-popover-open
          className="absolute top-full right-0 z-40 mt-1.5 max-h-[min(28rem,70vh)] w-72 overflow-y-auto rounded-xl border border-line-strong bg-surface p-1 shadow-xl shadow-black/40"
        >
          {error && <p className="px-2 py-1.5 font-mono text-xs break-words text-err">{error}</p>}
          {!data && !error && <p className="px-2 py-1.5 text-xs text-muted">Loading…</p>}
          {data && (
            <>
              {row(null, 0, "Default", data.defaultRef ?? "none")}
              {groups.map(([family, opts]) => (
                <div key={family} role="group" aria-label={family}>
                  <p className="px-2 pt-2.5 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">{family}</p>
                  {opts.map((o) => row(o.ref, i++, label(o), o.alias))}
                </div>
              ))}
              {unknown && <p className="px-2 py-1.5 font-mono text-xs text-err">{value}: not in providers.models anymore</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
