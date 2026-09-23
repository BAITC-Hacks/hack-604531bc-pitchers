import assert from "node:assert/strict";
import test from "node:test";
import { loadContractors } from "../src/engine/data.js";
import { ValidationError, recommend } from "../src/engine/recommend.js";

const DEMO_1 = { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 };
const DEMO_2 = { ...DEMO_1, date: "2026-12-26" };

const ids = (result) => result.cards.map((card) => card.id);

test("recommend is deterministic: the same query keeps the same order of ids", () => {
  const first = recommend(DEMO_1);
  const second = recommend(DEMO_1);
  assert.deepEqual(ids(first), ids(second));
  assert.ok(first.cards.length > 0, "demo query must return cards");
});

test("a contractor busy on the date never reaches the cards", () => {
  const busyIds = loadContractors()
    .filter((contractor) => contractor.city === DEMO_1.city && contractor.categories.includes(DEMO_1.category))
    .filter((contractor) => contractor.busyDates.has(DEMO_1.date))
    .map((contractor) => contractor.id);

  assert.ok(busyIds.length > 0, "the fixture must contain busy contractors on this date");
  for (const id of ids(recommend(DEMO_1))) {
    assert.ok(!busyIds.includes(id), `${id} is busy on ${DEMO_1.date} but was shown`);
  }
});

test("the same query on another date gives different cards and reports busy exclusions", () => {
  const first = recommend(DEMO_1);
  const second = recommend(DEMO_2);

  assert.notDeepEqual(ids(first), ids(second));
  assert.ok(second.excludedList.some((item) => item.reason === "busy"), "expected busy exclusions on 26.12");
  assert.equal(second.excluded.busy, second.excludedList.filter((item) => item.reason === "busy").length);
});

test("a category missing in the city returns no_category and points to other cities", () => {
  const result = recommend({
    city: "Астана",
    date: "2026-10-17",
    eventType: "свадьба",
    category: "Декоратор",
    budget: 1000000,
  });

  assert.equal(result.status, "no_category");
  assert.equal(result.cards.length, 0);
  assert.ok(result.otherCities.some((item) => item.city === "Алматы" && item.count > 0));
});

test("everything filtered out returns all_filtered with a nearest free date", () => {
  const result = recommend({
    city: "Алматы",
    date: "2026-12-19",
    eventType: "корпоратив",
    category: "Банкетный зал",
    budget: 3000000,
  });

  assert.equal(result.status, "all_filtered");
  assert.equal(result.cards.length, 0);
  assert.match(result.hints.nearestFreeDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.notEqual(result.hints.nearestFreeDate, "2026-12-19");
});

test("a date outside the calendar window is a validation error", () => {
  assert.throws(() => recommend({ ...DEMO_1, date: "2027-01-05" }), ValidationError);
  assert.throws(() => recommend({ ...DEMO_1, date: "2026-09-01" }), ValidationError);
});
