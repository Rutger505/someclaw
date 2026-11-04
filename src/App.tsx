import { CircleAlert, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clearToken, pair, tokenValid } from "./lib/gateway";
import { useVersionReload } from "./lib/useVersionReload";
import { useBroker } from "./lib/broker";
import { COMPOSER_KEYS, KEYMAP, useShortcuts } from "./lib/shortcuts";
import { Chat, type ChatHandle } from "./components/Chat";
import { Kbd, Sidebar } from "./components/Sidebar";

export const DASHBOARD_URL = "https://zeroclaw.homelab.rutgerpronk.com";

export function App() {
  const [auth, setAuth] = useState<"checking" | "paired" | "unpaired">("checking");
  useEffect(() => {
    tokenValid().then((ok) => setAuth(ok ? "paired" : "unpaired"), () => setAuth("paired"));
  }, []);
  if (auth === "checking") return null;
  if (auth === "unpaired") return <Pair onPaired={() => setAuth("paired")} />;
  return (
    <Shell
      onUnauthorized={() => {
        clearToken();
        setAuth("unpaired");
      }}
    />
  );
}

// The open conversation lives in the URL hash: reload keeps it, back/forward switch.
const hashId = () => decodeURIComponent(location.hash.slice(1));
const newId = () => crypto.randomUUID();

function Shell({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [openId, setOpenId] = useState(() => hashId() || newId());
  const { list, listError, snap, link, errors, dismissError, send } = useBroker(openId, onUnauthorized);
  const [sidebar, setSidebar] = useState(() => localStorage.getItem("sidebar") !== "0" && innerWidth >= 768);
  const [help, setHelp] = useState(false);
  const [draftEmpty, setDraftEmpty] = useState(true);
  const chat = useRef<ChatHandle>(null);
  const conv = list?.find((c) => c.id === openId);
  const active = list?.filter((c) => !c.archived) ?? [];

  useVersionReload(draftEmpty);

  const open = (id: string) => {
    setOpenId(id);
    if (innerWidth < 768) setSidebar(false);
  };
  useEffect(() => {
    if (hashId() !== openId) history.pushState(null, "", `#${encodeURIComponent(openId)}`);
  }, [openId]);
  useEffect(() => {
    const onHash = () => hashId() && setOpenId(hashId());
    addEventListener("hashchange", onHash);
    addEventListener("popstate", onHash);
    return () => (removeEventListener("hashchange", onHash), removeEventListener("popstate", onHash));
  }, []);
  useEffect(() => localStorage.setItem("sidebar", sidebar ? "1" : "0"), [sidebar]);
  useEffect(() => {
    document.title = conv ? `${conv.name ?? "someclaw"} · someclaw` : "someclaw";
  }, [conv?.name]);

  useShortcuts((action, e) => {
    // The list the user sees: archived ones only when open.
    const order = conv?.archived ? [...active, conv] : active;
    const at = order.findIndex((c) => c.id === openId);
    switch (action) {
      case "open-n": {
        const c = active[Number(e.code.slice(-1)) - 1];
        if (c) open(c.id);
        return;
      }
      case "new":
        return open(newId());
      case "next":
      case "prev": {
        const c = order[at < 0 ? 0 : at + (action === "next" ? 1 : -1)];
        if (c) open(c.id);
        return;
      }
      case "archive":
        if (conv) send({ type: "archive", id: conv.id, archived: !conv.archived });
        return;
      case "rename":
        return chat.current?.rename();
      case "abort":
        if (help) return setHelp(false);
        if (document.activeElement instanceof HTMLInputElement) return false; // rename field handles its own Esc
        if (conv?.status !== "running" && conv?.status !== "waiting") return false;
        return send({ type: "abort", id: openId });
      case "sidebar":
        return setSidebar((x) => !x);
      case "focus":
        return chat.current?.focus();
      case "help":
        return setHelp((x) => !x);
    }
  });

  return (
    <div className="relative flex h-full">
      {sidebar && (
        <div className="absolute inset-y-0 left-0 z-20 shadow-2xl md:static md:shadow-none">
          <Sidebar
            list={list}
            listError={listError}
            link={link}
            openId={openId}
            onOpen={open}
            onNew={() => open(newId())}
            onArchive={(id, archived) => send({ type: "archive", id, archived })}
            onHelp={() => setHelp(true)}
          />
        </div>
      )}
      <Chat ref={chat} id={openId} conv={conv} snap={snap} send={send} onDraft={setDraftEmpty} onToggleSidebar={() => setSidebar((x) => !x)} />

      {errors.length > 0 && (
        <div className="absolute top-4 right-4 z-30 flex w-96 max-w-[calc(100%-2rem)] flex-col gap-2">
          {errors.slice(-4).map((e) => (
            <div key={e.at} className="flex gap-2.5 rounded-xl border border-err/30 bg-elevated px-3.5 py-2.5 shadow-xl shadow-black/30">
              <CircleAlert size={16} className="mt-0.5 shrink-0 text-err" />
              <p className="min-w-0 flex-1 font-mono text-xs break-words text-err/90">{e.message}</p>
              <button onClick={() => dismissError(e.at)} title="Dismiss" className="-m-1 grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-line-strong hover:text-fg">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {help && <Help onClose={() => setHelp(false)} />}
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  const rows = [...KEYMAP.map(({ keys, label }) => ({ keys, label })), ...COMPOSER_KEYS];
  return (
    <div onClick={onClose} className="absolute inset-0 z-40 flex items-center justify-center bg-base/70 backdrop-blur-sm">
      <div onClick={(e) => e.stopPropagation()} className="w-[26rem] rounded-2xl border border-line-strong bg-surface p-5 shadow-2xl shadow-black/40">
        <div className="mb-4 flex items-center">
          <p className="font-semibold">Keyboard shortcuts</p>
          <button onClick={onClose} className="ml-auto grid size-7 place-items-center rounded-md text-muted hover:bg-elevated hover:text-fg">
            <X size={16} />
          </button>
        </div>
        <div className="flex flex-col gap-1.5">
          {rows.map((r) => (
            <div key={r.keys} className="flex items-center justify-between gap-4 text-sm">
              <span className="text-fg-2">{r.label}</span>
              <Kbd className="text-[11px] text-fg-2">{r.keys}</Kbd>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-muted">Numbers in the sidebar are the Ctrl+1-9 targets. Those only reach the page in an app window (Chromium --app / Omarchy web app); browser tabs keep them.</p>
      </div>
    </div>
  );
}

function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        pair(code.trim()).then(onPaired, (err) => setError(err.message));
      }}
    >
      <span className="grid size-12 place-items-center rounded-xl bg-accent-glow ring-1 ring-accent-dim">
        <span className="size-4 rounded-full bg-accent shadow-[0_0_16px] shadow-accent" />
      </span>
      <p className="text-lg font-medium">Pair someclaw</p>
      <p className="text-sm text-fg-2">
        Enter a pairing code from <code className="rounded bg-code px-1.5 py-0.5 font-mono text-[13px] text-accent-light">zeroclaw gateway get-paircode --new</code>
      </p>
      <input
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="h-11 w-64 rounded-xl border border-line-strong bg-input px-3 text-center font-mono text-lg tracking-[0.3em] outline-none focus:border-accent"
      />
      {error && <p className="max-w-md font-mono text-xs break-words text-err">{error}</p>}
    </form>
  );
}
