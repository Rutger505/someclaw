import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/gateway";

type ConfigEntry = { path: string; value: unknown };
type ModelOption = { provider: string; alias: string; ref: string; model: string };

/** Selects rocky's configured provider alias; model names come from providers.models in gateway config. */
export function ModelSelector() {
  const [options, setOptions] = useState<ModelOption[]>([]);
  const [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    Promise.all([
      api<{ entries: ConfigEntry[] }>("/api/config/list?prefix=providers.models"),
      api<{ value: unknown }>("/api/config/prop?path=agents.rocky.model_provider"),
    ]).then(([config, current]) => {
      if (!live) return;
      const parsed = config.entries.flatMap((entry) => {
        const match = /^providers\.models\.([^.]+)\.([^.]+)\.model$/.exec(entry.path);
        if (!match) return [];
        return [{ provider: match[1]!, alias: match[2]!, ref: `${match[1]}.${match[2]}`, model: typeof entry.value === "string" ? entry.value : "" }];
      }).sort((a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model) || a.alias.localeCompare(b.alias));
      setOptions(parsed);
      setSelected(typeof current.value === "string" ? current.value : "");
    }).catch((e: unknown) => {
      if (live) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => {
      if (live) setLoading(false);
    });
    return () => { live = false; };
  }, []);

  const current = options.find((option) => option.ref === selected);
  const providers = useMemo(() => [...new Set(options.map((option) => option.provider))], [options]);
  const models = options.filter((option) => option.provider === current?.provider);
  const selectedProvider = current?.provider ?? "";

  async function choose(ref: string) {
    if (!ref || ref === selected || saving) return;
    setSaving(true);
    setError("");
    try {
      await api("/api/config/prop", {
        method: "PUT",
        body: JSON.stringify({ path: "agents.rocky.model_provider", value: ref }),
      });
      setSelected(ref);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  const selectClass = "h-8 min-w-0 rounded-md border border-line-strong bg-input px-2 text-xs text-fg outline-none focus:border-accent disabled:opacity-50";
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <label className="sr-only" htmlFor="model-provider">Provider</label>
        <select
          id="model-provider"
          aria-label="Provider"
          title={selectedProvider ? `Provider: ${selectedProvider}` : "Provider"}
          className={`${selectClass} w-24 sm:w-32`}
          value={selectedProvider}
          disabled={loading || saving || !providers.length}
          onChange={(e) => {
            const first = options.find((option) => option.provider === e.target.value);
            if (first) void choose(first.ref);
          }}
        >
          {loading && <option value="">Loading…</option>}
          {!loading && !providers.length && <option value="">No providers</option>}
          {providers.map((provider) => <option key={provider} value={provider}>{provider}</option>)}
        </select>
        <label className="sr-only" htmlFor="model-name">Model</label>
        <select
          id="model-name"
          aria-label="Model"
          title={current ? `Model: ${current.model || current.alias}` : "Model"}
          className={`${selectClass} w-32 sm:w-48`}
          value={selected}
          disabled={loading || saving || !models.length}
          onChange={(e) => void choose(e.target.value)}
        >
          {models.map((option) => (
            <option key={option.ref} value={option.ref}>{option.model || option.alias}{option.model ? ` · ${option.alias}` : ""}</option>
          ))}
        </select>
        {saving && <span className="sr-only">Saving model selection…</span>}
      </div>
      {error && (
        <div role="alert" className="absolute top-14 right-3 z-30 max-w-[min(32rem,calc(100%-1.5rem))] rounded-lg border border-err/30 bg-surface px-3 py-2 font-mono text-xs break-words text-err shadow-xl shadow-black/30">
          {error}
        </div>
      )}
    </>
  );
}
