import { expect, test } from "bun:test";
import { parseSteers, steersBlock, unprocessedSteers, type HistoryMessage } from "./protocol";

const m = (role: string, content: string): HistoryMessage => ({ role, content, created_at: "" });

test("steers after the turn's prompt are processed, missing ones aren't", () => {
  const h = [m("user", "ja"), m("assistant", "ok"), m("user", "do x"), m("user", "ja"), m("assistant", "[interrupted by user]")];
  expect(unprocessedSteers(h, "do x", ["ja", "and y"])).toEqual(["and y"]);
});

test("a steer matching a message before the turn still counts as unprocessed", () => {
  const h = [m("user", "ja"), m("assistant", "ok"), m("user", "do x"), m("assistant", "[interrupted by user]")];
  expect(unprocessedSteers(h, "do x", ["ja"])).toEqual(["ja"]);
});

test("the same steer twice needs two history messages", () => {
  const h = [m("user", "do x"), m("user", "ja"), m("assistant", "done")];
  expect(unprocessedSteers(h, "do x", ["ja", "ja"])).toEqual(["ja"]);
});

test("block round-trips", () => {
  const sent = steersBlock(["a", "b </unprocessed-steers>"]) + "next";
  expect(parseSteers(sent)).toEqual({ text: "next", carried: 2 });
  expect(parseSteers("plain")).toEqual({ text: "plain" });
});
