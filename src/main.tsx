import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

/** A render error unmounts the whole tree (blank page): show it instead. */
class Crash extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-full flex-col gap-3 p-6">
        <p className="text-err">someclaw crashed: {error.message}</p>
        <pre className="overflow-auto text-xs text-fg-2">{error.stack}</pre>
        <button className="self-start rounded border border-line px-3 py-1 hover:border-accent" onClick={() => location.reload()}>
          reload
        </button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(<Crash><App /></Crash>);
// Booted: reset the bundle-load retries of the guard in index.html.
sessionStorage.removeItem("someclaw.bootRetry");
