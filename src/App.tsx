import { useEffect, useState } from "react";
import { clearToken, pair, tokenValid } from "./lib/gateway";
import { useVersionReload } from "./lib/useVersionReload";
import { Chat } from "./components/Chat";

export const DASHBOARD_URL = "https://zeroclaw.homelab.rutgerpronk.com";

function sessionId() {
  const key = "session.rocky";
  const id = localStorage.getItem(key) ?? crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

export function App() {
  const [auth, setAuth] = useState<"checking" | "paired" | "unpaired">("checking");
  const [idle, setIdle] = useState(true);
  useVersionReload(idle);

  useEffect(() => {
    tokenValid().then((ok) => setAuth(ok ? "paired" : "unpaired"), () => setAuth("paired"));
  }, []);

  if (auth === "checking") return null;
  if (auth === "unpaired") return <Pair onPaired={() => setAuth("paired")} />;
  return (
    <Chat
      sessionId={sessionId()}
      onIdle={setIdle}
      onUnauthorized={() => {
        clearToken();
        setAuth("unpaired");
      }}
    />
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
