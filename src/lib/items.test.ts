import { expect, test } from "bun:test";
import type { GatewayEvent } from "../../shared/protocol";
import type { Snapshot } from "./broker";
import { buildItems, type Item, type Tool } from "./items";

const snap = (p: Partial<Snapshot>): Snapshot => ({ id: "c", history: [], tools: [], turns: [], turn: [], historyError: null, model: null, skills: [], ...p });
const sub = (event: GatewayEvent, parent_call_id = "toolu_1"): GatewayEvent => ({ type: "subagent_event", parent_call_id, event });
const tools = (items: Item[]) => items.flatMap((x) => (x.kind === "tools" ? x.tools : [])) as Tool[];

const running: GatewayEvent[] = [
  { type: "user", content: "go" },
  { type: "tool_call", id: "toolu_1", name: "spawn_subagent", args: { prompt: "look" } },
  sub({ type: "subagent_start", run_id: "r" }),
  sub({ type: "tool_call", id: "toolu_9", name: "shell", args: { command: "ls" } }),
  sub({ type: "tool_result", id: "toolu_9", name: "shell", output: "a\nb" }),
  sub({ type: "tool_call", id: "toolu_10", name: "file_read", args: { path: "x" } }),
];

test("running turn: steps nest under the spawn_subagent call, not as own tool calls", () => {
  const t = tools(buildItems(snap({ turn: running })));
  expect(t.map((x) => x.name)).toEqual(["spawn_subagent"]);
  expect(t[0]!.sub).toEqual({
    ended: false,
    steps: [
      { id: "toolu_9", name: "shell", args: { command: "ls" }, output: "a\nb" },
      { id: "toolu_10", name: "file_read", args: { path: "x" } },
    ],
  });
});

test("failed end carries the error; finished turn from the tool log shows the steps", () => {
  const events = [...running.slice(1), sub({ type: "subagent_end", success: false, error: "boom" }), { type: "tool_result", id: "toolu_1", name: "spawn_subagent", output: "failed" }];
  const items = buildItems(snap({ history: [{ role: "user", content: "go" }, { role: "assistant", content: "done" }] as Snapshot["history"], tools: [{ at: 1, events }] }));
  const t = tools(items)[0]!;
  expect(t.output).toBe("failed");
  expect(t.sub).toMatchObject({ ended: true, success: false, error: "boom" });
  expect(t.sub!.steps.length).toBe(2);
});

test("unknown parent and malformed frames are ignored", () => {
  const items = buildItems(snap({ turn: [...running.slice(0, 2), sub({ type: "tool_call", id: "z", name: "shell" }, "toolu_404"), { type: "subagent_event", parent_call_id: "toolu_1" }] }));
  expect(items.some((x) => x.kind === "meta")).toBe(false);
  expect(tools(items)[0]!.sub).toBeUndefined();
});

test("truncated marker", () => {
  const t = tools(buildItems(snap({ turn: [...running, sub({ type: "truncated", limit: 200 })] })))[0]!;
  expect(t.sub!.truncated).toBe(200);
});
