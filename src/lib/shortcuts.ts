import { useEffect, useRef } from "react";

// One keymap for the whole app: the help overlay (Ctrl+/) lists it, so adding a shortcut = one entry + one handler.
// Browser tabs keep Ctrl+1-9 for themselves: run someclaw as an app window (Chromium --app, Omarchy web app) for those.
export type Action =
  | "open-n"
  | "new"
  | "next"
  | "prev"
  | "archive"
  | "rename"
  | "abort"
  | "sidebar"
  | "focus"
  | "help";

type Binding = { action: Action; keys: string; label: string; match: (e: KeyboardEvent) => boolean };

const ctrl = (e: KeyboardEvent) => (e.ctrlKey || e.metaKey) && !e.altKey;
const bare = (e: KeyboardEvent) => !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;

export const KEYMAP: Binding[] = [
  { action: "open-n", keys: "Ctrl+1…9", label: "Open conversation 1-9", match: (e) => ctrl(e) && !e.shiftKey && /^Digit[1-9]$/.test(e.code) },
  { action: "new", keys: "Ctrl+O", label: "New conversation", match: (e) => ctrl(e) && !e.shiftKey && e.code === "KeyO" },
  { action: "next", keys: "Ctrl+↓", label: "Next conversation", match: (e) => ctrl(e) && !e.shiftKey && e.key === "ArrowDown" },
  { action: "prev", keys: "Ctrl+↑", label: "Previous conversation", match: (e) => ctrl(e) && !e.shiftKey && e.key === "ArrowUp" },
  { action: "archive", keys: "Ctrl+Shift+E", label: "Archive / unarchive conversation", match: (e) => ctrl(e) && e.shiftKey && e.code === "KeyE" },
  { action: "rename", keys: "F2", label: "Rename conversation", match: (e) => bare(e) && e.key === "F2" },
  { action: "abort", keys: "Esc", label: "Stop the running turn", match: (e) => bare(e) && e.key === "Escape" },
  { action: "sidebar", keys: "Ctrl+B", label: "Toggle sidebar", match: (e) => ctrl(e) && !e.shiftKey && e.code === "KeyB" },
  { action: "focus", keys: "Ctrl+L", label: "Focus message input", match: (e) => ctrl(e) && !e.shiftKey && e.code === "KeyL" },
  { action: "help", keys: "Ctrl+/", label: "Shortcuts", match: (e) => ctrl(e) && e.key === "/" },
];

/** Composer keys, handled in the textarea itself; listed here for the help overlay. */
export const COMPOSER_KEYS = [
  { keys: "Enter", label: "Send (steers while rocky works)" },
  { keys: "Shift+Enter", label: "New line" },
];

/** Handler returns false to let the browser have the key (e.g. Esc with nothing running). */
export function useShortcuts(handler: (action: Action, e: KeyboardEvent) => boolean | void) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return;
      const b = KEYMAP.find((x) => x.match(e));
      if (!b || ref.current(b.action, e) === false) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}
