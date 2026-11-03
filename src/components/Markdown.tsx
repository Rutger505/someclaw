import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: true });

// Raw HTML from the model is escaped: only markdown renders.
const renderer = new marked.Renderer();
renderer.html = ({ text }) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { renderer, async: false }), [text]);
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
