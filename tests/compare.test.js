import assert from "node:assert/strict";
import test from "node:test";
import { compareDates } from "../src/engine/compare.js";
import { ValidationError } from "../src/engine/recommend.js";

const DEMO_1 = { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 };

test("comparing the demo query against 26.12 shows who dropped out and why", () => {
  const { a, b, diff, message } = compareDates(DEMO_1, "2026-12-26");

  assert.equal(a.query.date, "2026-10-17");
  assert.equal(b.query.date, "2026-12-26");
  assert.ok(a.cards.length > 0, "the first date must return cards");
  assert.ok(diff.droppedOut.length > 0, "somebody must drop out on 26.12");
  assert.ok(
    diff.droppedOut.some((item) => item.detail.includes("занят")),
    `expected a "занят" detail, got: ${diff.droppedOut.map((item) => item.detail).join(" | ")}`,
  );
  for (const item of diff.droppedOut) {
    assert.ok(item.id && item.name && item.detail, "every dropped card carries id, name and detail");
  }
  assert.match(message, /26\.12\.2026/);
});

test("the comparison is deterministic", () => {
  const first = compareDates(DEMO_1, "2026-12-26");
  const second = compareDates(DEMO_1, "2026-12-26");
  assert.deepEqual(first.diff, second.diff);
  assert.equal(first.message, second.message);
});

test("the same date on both sides changes nothing", () => {
  const { diff, message } = compareDates(DEMO_1, DEMO_1.date);
  assert.deepEqual(diff, { droppedOut: [], newcomers: [] });
  assert.match(message, /не изменилась/);
});

test("a missing or out-of-window second date is a validation error", () => {
  assert.throws(() => compareDates(DEMO_1, ""), ValidationError);
  assert.throws(() => compareDates(DEMO_1, "2027-01-05"), ValidationError);
});
