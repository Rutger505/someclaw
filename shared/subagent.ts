import type { GatewayEvent } from "./protocol";

// Subagent steps (zeroclaw-patches 0006): while a spawn_subagent call runs, the gateway sends
// {type: "subagent_event", parent_call_id, event} with event subagent_start {run_id}, tool_call, tool_result (same shape
// as the parent's) or subagent_end {success, error}. The broker keeps them with the turn's steps (gateway history has
// none), bounded per call; the UI nests them under the parent call. `truncated` is the broker's own: limit reached.

/** Inner tool calls kept per spawn_subagent call; later ones (and their results) are dropped. */
export const SUBAGENT_MAX_STEPS = 200;
/** Inner tool_result output kept, in chars. */
export const SUBAGENT_MAX_OUTPUT = 10_000;
const MAX_ARTIFACT = 10_000;

const inner = (e: GatewayEvent) => (e.type === "subagent_event" ? (e.event as GatewayEvent) : null);

/** subagent_event frame as the broker keeps it, or null to drop: malformed, no tool_call with id parent_call_id among
 * `steps` (the turn's steps so far), result of a dropped call, or over the limit. */
export function keepSubagentEvent(m: GatewayEvent, steps: GatewayEvent[]): GatewayEvent | null {
  const parent = m.parent_call_id;
  const ev = m.event as GatewayEvent | null | undefined;
  if (typeof parent !== "string" || !parent || !ev || typeof ev !== "object" || typeof ev.type !== "string") return null;
  if (!steps.some((e) => e.type === "tool_call" && e.id === parent)) return null;
  const mine = steps.filter((e) => e.type === "subagent_event" && e.parent_call_id === parent).map(inner) as GatewayEvent[];
  const frame = (event: GatewayEvent): GatewayEvent => ({ type: "subagent_event", parent_call_id: parent, event });
  if (ev.type === "tool_call") {
    if (mine.filter((e) => e.type === "tool_call").length < SUBAGENT_MAX_STEPS) return frame({ ...ev });
    return mine.some((e) => e.type === "truncated") ? null : frame({ type: "truncated", limit: SUBAGENT_MAX_STEPS });
  }
  if (ev.type === "tool_result") {
    if (ev.id !== undefined && !mine.some((e) => e.type === "tool_call" && e.id === ev.id)) return null;
    if (ev.id === undefined && mine.some((e) => e.type === "truncated")) return null;
    const out = typeof ev.output === "string" ? ev.output : JSON.stringify(ev.output ?? "");
    const r: GatewayEvent = { ...ev, output: out.length > SUBAGENT_MAX_OUTPUT ? `${out.slice(0, SUBAGENT_MAX_OUTPUT)}\n[someclaw: ${out.length - SUBAGENT_MAX_OUTPUT} more chars not kept]` : out };
    if (r.artifact !== undefined && JSON.stringify(r.artifact).length > MAX_ARTIFACT) delete r.artifact;
    return frame(r);
  }
  if (ev.type === "subagent_start" || ev.type === "subagent_end") return frame({ ...ev });
  return null; // unknown inner type: nothing to show, not worth keeping
}
