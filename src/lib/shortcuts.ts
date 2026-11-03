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
const alt = (e: KeyboardEvent) => e.altKey && !e.ctrlKey && !e.metaKey;

export const KEYMAP: Binding[] = [
  { action: "open-n", keys: "Ctrl+1…9", label: "Open conversation 1-9", match: (e) => ctrl(e) && !e.shiftKey && /^Digit[1-9]$/.test(e.code) },
  { action: "new", keys: "Ctrl+O", label: "New conversation", match: (e) => ctrl(e) && !e.shiftKey && e.code === "KeyO" },
  { action: "next", keys: "Alt+↓", label: "Next conversation", match: (e) => alt(e) && e.key === "ArrowDown" },
  { action: "prev", keys: "Alt+↑", label: "Previous conversation", match: (e) => alt(e) && e.key === "ArrowUp" },
  { action: "archive", keys: "Alt+A", label: "Archive / unarchive conversation", match: (e) => alt(e) && e.code === "KeyA" },
  { action: "rename", keys: "Alt+R", label: "Rename conversation", match: (e) => alt(e) && e.code === "KeyR" },
  { action: "abort", keys: "Esc", label: "Stop the running turn", match: (e) => e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey },
  { action: "sidebar", keys: "Ctrl+B", label: "Toggle sidebar", match: (e) => ctrl(e) && !e.shiftKey && e.code === "KeyB" },
  { action: "focus", keys: "Ctrl+L", label: "Focus message input", match: (e) => ctrl(e) && !e.shiftKey && e.code === "KeyL" },
  { action: "help", keys: "Ctrl+/", label: "Shortcuts", match: (e) => ctrl(e) && e.key === "/" },
];

/** Composer keys, handled in the textarea itself; listed here for the help overlay. */
export const COMPOSER_KEYS = [
  { keys: "Enter", label: "Send (steers the running turn while rocky is busy)" },
  { keys: "Alt+Enter", label: "Queue: send after the running turn" },
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
