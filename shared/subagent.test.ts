import { expect, test } from "bun:test";
import type { GatewayEvent } from "./protocol";
import { resendPrompt } from "./protocol";
import { keepSubagentEvent, SUBAGENT_MAX_OUTPUT, SUBAGENT_MAX_STEPS } from "./subagent";

const parent: GatewayEvent = { type: "tool_call", id: "toolu_1", name: "spawn_subagent", args: { prompt: "x" } };
const sub = (event: GatewayEvent, parent_call_id: unknown = "toolu_1"): GatewayEvent => ({ type: "subagent_event", parent_call_id, event });

/** Feeds frames like the broker does: kept ones join the steps. */
function feed(frames: GatewayEvent[], steps: GatewayEvent[] = [parent]) {
  for (const f of frames) {
    const k = keepSubagentEvent(f, steps);
    if (k) steps.push(k);
  }
  return steps;
}

test("keeps start, calls, results and end of a known parent", () => {
  const frames = [
    sub({ type: "subagent_start", run_id: "r" }),
    sub({ type: "tool_call", id: "toolu_9", name: "shell", args: { command: "ls" } }),
    sub({ type: "tool_result", id: "toolu_9", name: "shell", output: "a\nb", artifact: { k: 1 } }),
    sub({ type: "subagent_end", success: true, error: null }),
  ];
  expect(feed(frames).slice(1)).toEqual(frames);
});

test("unknown or missing parent, malformed and unknown inner types are dropped", () => {
  const steps = [parent];
  expect(keepSubagentEvent(sub({ type: "tool_call", id: "a", name: "shell" }, "toolu_404"), steps)).toBeNull();
  expect(keepSubagentEvent(sub({ type: "tool_call", id: "a", name: "shell" }, null), steps)).toBeNull();
  expect(keepSubagentEvent({ type: "subagent_event", parent_call_id: "toolu_1" }, steps)).toBeNull();
  expect(keepSubagentEvent({ type: "subagent_event", parent_call_id: "toolu_1", event: "x" }, steps)).toBeNull();
  expect(keepSubagentEvent(sub({ type: "chunk", content: "hi" }), steps)).toBeNull();
  // a subagent_event id is not a parent
  const s = feed([sub({ type: "tool_call", id: "toolu_9", name: "shell" })]);
  expect(keepSubagentEvent(sub({ type: "tool_call", id: "b", name: "shell" }, "toolu_9"), s)).toBeNull();
});

test("result of an unknown inner call is dropped", () => {
  expect(keepSubagentEvent(sub({ type: "tool_result", id: "nope", output: "x" }), [parent])).toBeNull();
});

test("long outputs are clipped, big artifacts dropped", () => {
  const steps = feed([sub({ type: "tool_call", id: "c", name: "shell" })]);
  const k = keepSubagentEvent(sub({ type: "tool_result", id: "c", output: "x".repeat(SUBAGENT_MAX_OUTPUT + 50), artifact: "y".repeat(20_000) }), steps)!;
  const ev = k.event as GatewayEvent;
  expect(String(ev.output).startsWith("x".repeat(SUBAGENT_MAX_OUTPUT))).toBe(true);
  expect(String(ev.output)).toContain("50 more chars not kept");
  expect(ev.artifact).toBeUndefined();
});

test("over the limit: one truncated marker, later calls and their results dropped", () => {
  const frames: GatewayEvent[] = [];
  for (let i = 0; i < SUBAGENT_MAX_STEPS + 5; i++) {
    frames.push(sub({ type: "tool_call", id: `c${i}`, name: "shell" }));
    frames.push(sub({ type: "tool_result", id: `c${i}`, name: "shell", output: "ok" }));
  }
  frames.push(sub({ type: "subagent_end", success: true, error: null }));
  const inner = feed(frames).slice(1).map((e) => e.event as GatewayEvent);
  expect(inner.filter((e) => e.type === "tool_call").length).toBe(SUBAGENT_MAX_STEPS);
  expect(inner.filter((e) => e.type === "tool_result").length).toBe(SUBAGENT_MAX_STEPS);
  expect(inner.filter((e) => e.type === "truncated")).toEqual([{ type: "truncated", limit: SUBAGENT_MAX_STEPS }]);
  expect(inner.at(-1)!.type).toBe("subagent_end");
});

test("limit is per parent call", () => {
  const other: GatewayEvent = { type: "tool_call", id: "toolu_2", name: "spawn_subagent" };
  const frames: GatewayEvent[] = [];
  for (let i = 0; i < SUBAGENT_MAX_STEPS; i++) frames.push(sub({ type: "tool_call", id: `c${i}`, name: "shell" }));
  const steps = feed(frames, [parent, other]);
  expect(keepSubagentEvent(sub({ type: "tool_call", id: "d", name: "shell" }, "toolu_2"), steps)).not.toBeNull();
});

test("resend after a restart lists subagent steps", () => {
  const steps = feed([sub({ type: "tool_call", id: "c", name: "shell", args: { command: "ls" } }), sub({ type: "tool_result", id: "c", output: "a" })]);
  const { content, steps: n } = resendPrompt("hi", steps, "now");
  expect(n).toBe(1);
  expect(content).toContain('Subagent (of toolu_1) tool call shell: {"command":"ls"}');
  expect(content).toContain("Subagent result: a");
});
