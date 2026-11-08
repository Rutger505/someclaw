// Attachments ride in the message text as ZeroClaw's channel media markers (the gateway chat socket takes text only):
// images as [IMAGE:<path>] (vision pipeline), anything else as [Document: <name>] <path>, one per line before the text.

export type Attachment = { name: string; path: string; image: boolean };

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export const marker = (a: Attachment) => (a.image ? `[IMAGE:${a.path}]` : `[Document: ${a.name}] ${a.path}`);

export const withAttachments = (text: string, files: Attachment[]) => [...files.map(marker), text].filter(Boolean).join("\n");

const LINE = /^(?:\[IMAGE:([^\]\n]+)\]|\[Document: ([^\]\n]+)\] (\S[^\n]*))$/;

/** Leading marker lines -> attachments + the remaining text. Markers elsewhere in the text stay text. */
export function splitAttachments(content: string): { files: Attachment[]; text: string } {
  const lines = content.split("\n");
  const files: Attachment[] = [];
  while (lines.length) {
    const m = LINE.exec(lines[0]!);
    if (!m) break;
    lines.shift();
    if (m[1]) files.push({ name: m[1].split("/").pop()!.replace(/^\d{6}-[0-9a-f]{4}-/, ""), path: m[1], image: true });
    else files.push({ name: m[2]!, path: m[3]!, image: false });
  }
  return { files, text: lines.join("\n") };
}

/** Preview/title text: markers become 📎 names. */
export function previewText(content: string) {
  const { files, text } = splitAttachments(content);
  return [files.map((f) => `📎 ${f.name}`).join(" "), text].filter(Boolean).join(" ");
}
