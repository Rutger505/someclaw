import { marked } from "marked";
import { useMemo } from "react";

marked.setOptions({ gfm: true, breaks: true });

// Raw HTML from the model is escaped: only markdown renders.
const renderer = new marked.Renderer();
renderer.html = ({ text }) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// marked emits plain tags, so they're styled from here with descendant variants.
const md = [
  "break-words [&>*+*]:mt-2",
  "[&_a]:text-accent-light [&_a]:underline [&_a]:underline-offset-2",
  "[&_code]:rounded [&_code]:bg-code [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]",
  "[&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:border-line [&_pre]:bg-code [&_pre]:p-3",
  "[&_pre_code]:bg-transparent [&_pre_code]:p-0",
  "[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li+li]:mt-0.5",
  "[&_:is(h1,h2,h3,h4)]:font-semibold [&_:is(h1,h2,h3,h4)]:text-fg",
  "[&_blockquote]:border-l-2 [&_blockquote]:border-line-strong [&_blockquote]:pl-3 [&_blockquote]:text-fg-2",
  "[&_table]:border-collapse [&_table]:text-sm [&_:is(th,td)]:border [&_:is(th,td)]:border-line [&_:is(th,td)]:px-2 [&_:is(th,td)]:py-1",
  "[&_hr]:border-line",
].join(" ");

export function Markdown({ text }: { text: string }) {
  const html = useMemo(() => marked.parse(text, { renderer, async: false }), [text]);
  return <div className={md} dangerouslySetInnerHTML={{ __html: html }} />;
}
