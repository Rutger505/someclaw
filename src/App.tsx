import { useEffect, useRef, useState } from "react";
import { clearToken, pair, tokenValid } from "./lib/gateway";
import { useVersionReload } from "./lib/useVersionReload";
import { useBroker } from "./lib/broker";
import { COMPOSER_KEYS, KEYMAP, useShortcuts } from "./lib/shortcuts";
import { Chat, type ChatHandle } from "./components/Chat";
import { Sidebar } from "./components/Sidebar";

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
        if (conv?.status !== "running") return false;
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
        <div className="absolute right-3 bottom-20 z-30 flex max-w-md flex-col gap-2">
          {errors.slice(-4).map((e) => (
            <div key={e.at} onClick={() => dismissError(e.at)} className="cursor-pointer rounded-md border border-err/50 bg-elevated px-3 py-2 font-mono text-xs text-err shadow-lg">
              {e.message}
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
    <div onClick={onClose} className="absolute inset-0 z-40 flex items-center justify-center bg-base/70">
      <div onClick={(e) => e.stopPropagation()} className="w-96 rounded-lg border border-line-strong bg-surface p-4 shadow-2xl">
        <p className="mb-3 font-semibold text-accent">Shortcuts</p>
        {rows.map((r) => (
          <div key={r.keys} className="flex justify-between py-0.5 text-sm">
            <span className="text-fg-2">{r.label}</span>
            <kbd className="font-mono text-xs text-accent-light">{r.keys}</kbd>
          </div>
        ))}
        <p className="mt-3 text-xs text-muted">Ctrl+1-9 only reach the page in an app window (Chromium --app / Omarchy web app), browser tabs keep them.</p>
      </div>
    </div>
  );
}

function Pair({ onPaired }: { onPaired: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="flex h-full flex-col items-center justify-center gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        pair(code.trim()).then(onPaired, (err) => setError(err.message));
      }}
    >
      <p className="text-fg-2">Not paired: enter a pairing code (<code className="font-mono text-accent">zeroclaw gateway get-paircode --new</code>)</p>
      <input
        autoFocus
        value={code}
        onChange={(e) => setCode(e.target.value)}
        className="w-64 rounded-md border border-line-strong bg-input px-3 py-2 text-center font-mono tracking-widest outline-none focus:border-accent"
      />
      {error && <p className="font-mono text-sm text-err">{error}</p>}
    </form>
  );
}
