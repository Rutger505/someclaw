import { expect, test } from "bun:test";
import { stamp } from "./time";

const now = new Date(2026, 10, 24, 18, 0);
const t = (d: Date) => d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

test("stamp: time only today, day label before", () => {
  const today = new Date(2026, 10, 24, 0, 5);
  expect(stamp(today, now)).toBe(t(today));
  const yesterday = new Date(2026, 10, 23, 23, 55);
  expect(stamp(yesterday, now)).toBe(`Yesterday ${t(yesterday)}`);
  expect(stamp(new Date(2026, 10, 20, 9, 0), now)).toStartWith(new Date(2026, 10, 20).toLocaleDateString(undefined, { weekday: "short" }));
  expect(stamp(new Date(2025, 0, 3, 9, 0), now)).toContain("2025");
});
