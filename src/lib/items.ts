import { RESUME_TEXT, assistantParts, toolResult, type ForkRef, type GatewayEvent, type Resent, type TurnModel } from "../../shared/protocol";
import type { Snapshot } from "./broker";

export type Tool = { id: string; name: string; args: unknown; output?: string };
export type Item =
  /** at: index in the persisted history (reset to here); absent for the running turn. */
  | { kind: "user"; text: string; steer?: boolean; fork?: ForkRef; resent?: Resent; at?: number }
  /** turn: model, tokens, duration, when known (turns finished in someclaw since this was added). */
  | { kind: "agent"; text: string; live?: boolean; at?: number; turn?: TurnModel }
  | { kind: "tools"; tools: Tool[]; live?: boolean }
  | { kind: "meta"; text: string; error?: boolean };

const RESUME_META = "↻ auto-resumed after rate limit reset";

/** Consecutive tool calls collapse into one "tools" item (shown as its latest call, expandable). */
function addEvent(items: Item[], e: GatewayEvent, live: boolean) {
  const last = items.at(-1);
  switch (e.type) {
    case "user":
      if (e.content === RESUME_TEXT) items.push({ kind: "meta", text: RESUME_META });
      else items.push({ kind: "user", text: String(e.content ?? ""), steer: !!e.steer, fork: e.fork as ForkRef | undefined });
      break;
    case "chunk":
      if (last?.kind === "agent" && last.live) last.text += String(e.content ?? "");
      else items.push({ kind: "agent", text: String(e.content ?? ""), live });
      break;
    case "message":
    case "done": {
      const full = String(e.full_response ?? e.content ?? "").trim();
      // Streamed chunks already show it; only fill in when nothing streamed.
      if (full && !items.some((x) => x.kind === "agent")) items.push({ kind: "agent", text: full });
      for (const x of items) if (x.kind === "agent" || x.kind === "tools") x.live = false;
      break;
    }
    case "tool_call": {
      const tool = { id: String(e.id ?? ""), name: String(e.name ?? "?"), args: e.args ?? {} };
      if (last?.kind === "tools") last.tools.push(tool);
      else items.push({ kind: "tools", tools: [tool], live });
      if (last?.kind === "agent") last.live = false;
      break;
    }
    case "tool_result": {
      const group = items.findLast((x) => x.kind === "tools");
      const t = group?.tools.findLast((t) => (e.id ? t.id === e.id : t.name === e.name && t.output === undefined));
      if (t) t.output = String(e.output ?? "");
      else items.push({ kind: "tools", tools: [{ id: String(e.id ?? ""), name: String(e.name ?? "?"), args: {}, output: String(e.output ?? "") }] });
      break;
    }
    case "error":
      items.push({ kind: "meta", text: `error: ${String(e.message ?? JSON.stringify(e))}`, error: true });
      break;
    case "aborted":
      items.push({ kind: "meta", text: "aborted", error: true });
      break;
    case "notice": // broker: restart mid-turn, reattach/resend
      items.push({ kind: "meta", text: `↻ ${String(e.message ?? "")}` });
      break;
    default:
      items.push({ kind: "meta", text: JSON.stringify(e) });
  }
}

export function buildItems(s: Snapshot): Item[] {
  const items: Item[] = [];
  const toolsAt = (i: number) => {
    for (const log of s.tools) if (log.at === i) for (const e of log.events) addEvent(items, e, false);
  };
  s.history.forEach((m, i) => {
    toolsAt(i);
    if (m.role === "user") items.push(m.content === RESUME_TEXT ? { kind: "meta", text: RESUME_META } : { kind: "user", text: m.content, fork: m.fork, resent: m.resent, at: i });
    else if (m.role === "assistant") {
      // Channel sessions: tool-using turns are stored as native JSON (text + tool_calls), results as role "tool".
      const { text, calls } = assistantParts(m.content);
      if (text.trim() || !calls.length) items.push({ kind: "agent", text, at: i, turn: s.turns.find((t) => t.at === i) });
      for (const c of calls) addEvent(items, { type: "tool_call", id: c.id, name: c.name, args: c.args }, false);
    } else if (m.role === "tool" && toolResult(m.content)) {
      const r = toolResult(m.content)!;
      addEvent(items, { type: "tool_result", id: r.id, output: r.output }, false);
    } else items.push({ kind: "meta", text: `${m.role}: ${m.content}` });
  });
  for (const log of s.tools) if (log.at >= s.history.length) for (const e of log.events) addEvent(items, e, false);
  const turn: Item[] = []; // own array: "done" only fills in text when this turn streamed none
  for (const e of s.turn) addEvent(turn, e, true);
  return [...items, ...turn];
}
