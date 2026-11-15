// Attachment chips (composer + sent messages) with previews: images as thumbnails, click opens them full size;
// other files open as text when they're valid UTF-8. Sent files come back from the VM (GET /someclaw/upload).
import { CircleAlert, FileText, Image, Loader, X } from "lucide-react";
import { useEffect, useState } from "react";
import { fetchUpload } from "../lib/gateway";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif)$/i;
/** Text previews stop here: a huge log or CSV in a <pre> locks the page. */
const MAX_TEXT = 2 * 1024 * 1024;

type Source = { path?: string; local?: File };

export type ChipProps = Source & {
  name: string;
  /** Sent as an image (vision pipeline). */
  image: boolean;
  loading?: boolean;
  error?: string;
  onRemove?: () => void;
};

const isImage = (name: string, path?: string) => IMAGE_EXT.test(name) || (!!path && IMAGE_EXT.test(path));

/** The file's bytes: the local File while it's still in the composer, else from the VM. */
function useBlob({ path, local }: Source, enabled: boolean) {
  const [state, setState] = useState<{ blob?: Blob; error?: string }>({});
  useEffect(() => {
    if (!enabled) return;
    if (local) return setState({ blob: local });
    if (!path) return;
    let live = true;
    fetchUpload(path).then(
      (blob) => live && setState({ blob }),
      (e) => live && setState({ error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
  }, [path, local, enabled]);
  return state;
}

function useObjectUrl(blob: Blob | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!blob) return setUrl(undefined);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export function AttachmentChip({ name, image, path, local, loading, error, onRemove }: ChipProps) {
  const [open, setOpen] = useState(false);
  const pic = isImage(name, path);
  const thumb = useBlob({ path, local }, pic);
  const url = useObjectUrl(thumb.blob);
  return (
    <>
      <span
        title={error ?? path ?? "uploading…"}
        className={`flex max-w-full items-center gap-1.5 rounded-lg py-1 pr-2 text-xs ring-1 ${url ? "pl-1" : "pl-2"} ${error ? "bg-err/10 text-err ring-err/40" : "bg-elevated text-fg-2 ring-line"}`}
      >
        <button type="button" onClick={() => setOpen(true)} disabled={!path && !local} className="flex min-w-0 items-center gap-1.5 hover:text-fg">
          {url ? (
            <img src={url} alt="" className="size-8 shrink-0 rounded-md object-cover" />
          ) : error ? (
            <CircleAlert size={13} className="shrink-0" />
          ) : image || pic ? (
            <Image size={13} className="shrink-0" />
          ) : (
            <FileText size={13} className="shrink-0" />
          )}
          <span className="min-w-0 truncate">{error ?? name}</span>
          {loading && !error && <Loader size={13} className="shrink-0 animate-spin" />}
        </button>
        {onRemove && (
          <button type="button" onClick={onRemove} title="Remove" className="text-faint hover:text-fg">
            <X size={12} />
          </button>
        )}
      </span>
      {open && <Preview name={name} path={path} local={local} onClose={() => setOpen(false)} />}
    </>
  );
}

function Preview({ name, path, local, onClose }: Source & { name: string; onClose: () => void }) {
  const pic = isImage(name, path);
  const { blob, error } = useBlob({ path, local }, true);
  const url = useObjectUrl(pic ? blob : undefined);
  const [text, setText] = useState<{ text?: string; error?: string }>({});

  useEffect(() => {
    if (!blob || pic) return;
    if (blob.size > MAX_TEXT) return setText({ error: `${(blob.size / 1048576).toFixed(1)} MB: too large to preview (max ${MAX_TEXT / 1048576} MB)` });
    let live = true;
    blob.arrayBuffer().then((buf) => {
      if (!live) return;
      try {
        setText({ text: new TextDecoder("utf-8", { fatal: true }).decode(buf) });
      } catch {
        setText({ error: `not UTF-8 text (${blob.type || "unknown type"}, ${blob.size} B): no preview` });
      }
    }, (e) => live && setText({ error: (e as Error).message }));
    return () => {
      live = false;
    };
  }, [blob, pic]);

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [onClose]);

  const err = error ?? text.error;
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-base/90 backdrop-blur-sm" onClick={onClose}>
      <div className="flex items-center gap-3 px-4 py-3 text-sm" onClick={(e) => e.stopPropagation()}>
        <span className="min-w-0 truncate font-medium">{name}</span>
        {path && <span className="hidden min-w-0 truncate font-mono text-xs text-faint sm:block">{path}</span>}
        <button type="button" onClick={onClose} title="Close (Esc)" className="ml-auto grid size-8 shrink-0 place-items-center rounded-full text-muted hover:bg-elevated hover:text-fg">
          <X size={18} />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pt-0">
        {err ? (
          <p className="flex items-center gap-2 text-sm text-err" onClick={(e) => e.stopPropagation()}>
            <CircleAlert size={16} /> {err}
          </p>
        ) : url ? (
          <img src={url} alt={name} className="max-h-full max-w-full rounded-xl object-contain" onClick={(e) => e.stopPropagation()} />
        ) : text.text !== undefined ? (
          <pre
            onClick={(e) => e.stopPropagation()}
            className="h-full w-full max-w-5xl overflow-auto rounded-xl bg-code p-4 font-mono text-xs leading-relaxed whitespace-pre text-fg ring-1 ring-line"
          >
            {text.text}
          </pre>
        ) : (
          <Loader size={20} className="animate-spin text-muted" />
        )}
      </div>
    </div>
  );
}
