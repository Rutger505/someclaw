import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from "react";

// Plain-text composer field on a contenteditable instead of a <textarea>: Firefox for Android (GeckoView) offers the
// keyboard's image insertion (Gboard clipboard, screenshots, stickers) only to contenteditable fields
// (GeckoEditable: contentMimeTypes only when the input type hint is empty), never to a textarea. Gecko delivers such
// an image as a paste event with the file in clipboardData, so the normal paste handling picks it up.

/** focus(true): caret to the end (Ctrl+L), else keep a caret already inside. */
export type EditorHandle = { focus: (end?: boolean) => void };

type Props = {
  value: string;
  onChange: (text: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  /** Files pasted or inserted by the keyboard (handled here, not by the page-wide paste handler). */
  onFiles: (files: File[]) => void;
  placeholder: string;
  className: string;
};

/** plaintext-only: no rich text from pastes (Chrome, Firefox ≥ 136); else "true" plus our own plain-text paste. */
const MODE = (() => {
  try {
    const d = document.createElement("div");
    d.contentEditable = "plaintext-only";
    return d.contentEditable === "plaintext-only" ? "plaintext-only" : "true";
  } catch {
    return "true";
  }
})();

/** Text as typed; a lone line break (what browsers leave in an emptied field) counts as empty. */
const read = (el: HTMLElement) => {
  const t = el.innerText.replace(/\r/g, "");
  return t === "\n" ? "" : t;
};

function caretToEnd(el: HTMLElement) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = getSelection();
  s?.removeAllRanges();
  s?.addRange(r);
}

/** Files in a paste: `files`, else file items (some browsers only fill items, e.g. an image copied from a page).
 * Unnamed clipboard images get a name with the right extension. */
export function clipboardFiles(dt: DataTransfer): File[] {
  let list = Array.from(dt.files);
  if (!list.length) list = Array.from(dt.items).filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter((f): f is File => !!f);
  return list.map((f) => {
    if (f.name && f.name !== "image.png" && f.name !== "image") return f;
    const ext = f.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\W.*/, "") || "bin";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    return new File([f], `pasted-${stamp}.${ext}`, { type: f.type });
  });
}

export const Editor = forwardRef<EditorHandle, Props>(function Editor({ value, onChange, onKeyDown, onFiles, placeholder, className }, ref) {
  const el = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    focus: (end) => {
      const e = el.current;
      if (!e) return;
      e.focus();
      if (end || !e.contains(getSelection()?.anchorNode ?? null)) caretToEnd(e);
    },
  }));

  // Value set from outside (clear after send, restore, draft of another conversation): write it, caret to the end.
  useLayoutEffect(() => {
    const e = el.current;
    if (!e || read(e) === value) return;
    e.textContent = value;
    if (document.activeElement === e) caretToEnd(e);
  }, [value]);

  // Fallback for keyboards/browsers that insert an image node instead of firing paste (contenteditable="true"):
  // take it out and attach the image instead.
  useEffect(() => {
    const e = el.current;
    if (!e) return;
    const obs = new MutationObserver(() => {
      const imgs = Array.from(e.querySelectorAll("img"));
      if (!imgs.length) return;
      for (const img of imgs) {
        const src = img.src;
        img.remove();
        fetch(src)
          .then((r) => r.blob())
          .then((b) => onFilesRef.current(clipboardFiles(fileList(new File([b], "image", { type: b.type || "image/png" })))))
          .catch((err) => console.error("inserted image:", err));
      }
      onChangeRef.current(read(e));
    });
    obs.observe(e, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
  const onFilesRef = useRef(onFiles);
  onFilesRef.current = onFiles;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  return (
    <div className="relative">
      {!value && <span className="pointer-events-none absolute inset-0 truncate px-4 pt-3.5 text-faint select-none">{placeholder}</span>}
      <div
        ref={el}
        role="textbox"
        aria-multiline="true"
        aria-label={placeholder}
        contentEditable={MODE as "true"}
        suppressContentEditableWarning
        spellCheck
        enterKeyHint="send"
        onInput={(e) => onChange(read(e.currentTarget))}
        onKeyDown={onKeyDown}
        onBeforeInput={(e) => {
          // Some keyboards hand an image over as an insert with a DataTransfer instead of a paste event.
          const n = e.nativeEvent as InputEvent;
          const files = n.dataTransfer ? clipboardFiles(n.dataTransfer) : [];
          if (!files.length) return;
          e.preventDefault();
          onFiles(files);
        }}
        onPaste={(e) => {
          e.stopPropagation(); // not again by the page-wide paste handler
          const files = clipboardFiles(e.clipboardData);
          if (files.length) {
            e.preventDefault();
            return onFiles(files);
          }
          if (MODE === "plaintext-only") return; // the browser pastes plain text itself
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
        className={`whitespace-pre-wrap wrap-anywhere outline-none ${className}`}
      />
    </div>
  );
});

const fileList = (f: File) => {
  const dt = new DataTransfer();
  dt.items.add(f);
  return dt;
};
