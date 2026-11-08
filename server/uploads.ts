// File uploads from the composer. Saved under the agent workspace (the vision pipeline and file tools read from there;
// it's outside the config repo's .gitignore whitelist, so never committed). The browser puts the returned path in a
// media marker (shared/attachments.ts).
import { mkdir, writeFile } from "node:fs/promises";
import { IMAGE_TYPES, type Attachment } from "../shared/attachments";
import { tokenValid } from "./gateway";

const DIR = process.env.SOMECLAW_UPLOAD_DIR ?? `${process.env.HOME}/.zeroclaw/agents/rocky/workspace/uploads`;
export const MAX_UPLOAD_MB = 50;

const safe = (name: string) =>
  name.normalize("NFKC").replace(/[\/\\\0\n\r\]\[]/g, "_").replace(/^\.+/, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "file";

export async function upload(req: Request): Promise<Response> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!token || !(await tokenValid(token))) return new Response("unauthorized: pair again", { status: 401 });
  const name = safe(new URL(req.url).searchParams.get("name") ?? "");
  const size = Number(req.headers.get("content-length") ?? NaN);
  if (size > MAX_UPLOAD_MB * 1024 * 1024) return new Response(`${name}: ${(size / 1048576).toFixed(1)} MB, max ${MAX_UPLOAD_MB} MB`, { status: 413 });

  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > MAX_UPLOAD_MB * 1024 * 1024) return new Response(`${name}: max ${MAX_UPLOAD_MB} MB`, { status: 413 });
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const dir = `${DIR}/${day}`;
  const path = `${dir}/${now.toISOString().slice(11, 19).replaceAll(":", "")}-${crypto.randomUUID().slice(0, 4)}-${name}`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(path, body, { mode: 0o600 });
  } catch (e) {
    console.error(`upload: writing ${path} failed:`, e);
    return new Response(`writing ${path}: ${(e as Error).message}`, { status: 500 });
  }
  const type = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const file: Attachment = { name, path, image: IMAGE_TYPES.includes(type) };
  console.log(`upload: ${path} (${body.length} B, ${type || "no type"})`);
  return Response.json(file);
}
