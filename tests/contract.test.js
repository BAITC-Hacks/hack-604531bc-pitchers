/**
 * Guards the EngineResult contract from AGENTS.md across every status,
 * so a change in one module cannot silently break the AI layer or the UI.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { catalogueFacets, loadContractors } from "../src/engine/data.js";
import { FILTER_REASONS } from "../src/engine/filters.js";
import { recommend } from "../src/engine/recommend.js";

const QUERIES = {
  found: { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 },
  partial: { city: "Алматы", date: "2026-12-26", eventType: "корпоратив", category: "Ведущий", budget: 1500000 },
  all_filtered: { city: "Алматы", date: "2026-12-19", eventType: "корпоратив", category: "Банкетный зал", budget: 3000000 },
  no_category: { city: "Астана", date: "2026-10-17", eventType: "свадьба", category: "Декоратор", budget: 1000000 },
};

const TOP_LEVEL = [
  "status", "query", "candidatesTotal", "excluded", "excludedList",
  "cards", "commonFacts", "otherCities", "hints", "actions", "message",
];
const CARD_FIELDS = ["id", "name", "categories", "city", "priceFrom", "flags", "score", "scoreParts", "facts", "factChips"];
const FACT_FIELDS = [
  "priceFrom", "budget", "headroomKzt", "headroomPct", "formats", "languages",
  "maxHours", "matchedKeywords", "descriptionSnippet", "flags", "differentiators",
];

test("every status returns the documented EngineResult shape", () => {
  for (const [expected, query] of Object.entries(QUERIES)) {
    const result = recommend(query);
    assert.equal(result.status, expected, `query for ${expected} returned ${result.status}`);
    for (const field of TOP_LEVEL) {
      assert.ok(field in result, `${expected}: missing ${field}`);
    }
    assert.deepEqual(Object.keys(result.excluded).sort(), [...FILTER_REASONS].sort());
    assert.ok(Array.isArray(result.excludedList) && Array.isArray(result.actions));
    assert.ok(typeof result.message === "string" && result.message.trim().length > 0);
  }
});

test("cards carry every documented field, and differentiators are never empty", () => {
  for (const query of Object.values(QUERIES)) {
    const result = recommend(query);
    assert.ok(result.cards.length <= 3, "at most three cards");
    for (const card of result.cards) {
      for (const field of CARD_FIELDS) assert.ok(field in card, `card ${card.id}: missing ${field}`);
      for (const field of FACT_FIELDS) assert.ok(field in card.facts, `card ${card.id}: missing facts.${field}`);
      assert.ok(card.facts.differentiators.length > 0, `card ${card.id}: empty differentiators`);
      assert.ok(card.factChips.length >= 2 && card.factChips.length <= 4, `card ${card.id}: ${card.factChips.length} chips`);
      assert.ok(card.facts.descriptionSnippet.length <= 140, `card ${card.id}: snippet too long`);
      assert.ok(card.score >= 0 && card.score <= 1);
      for (const [part, value] of Object.entries(card.scoreParts)) {
        assert.ok(value >= 0 && value <= 1, `card ${card.id}: ${part} out of range`);
      }
    }
    assert.equal(result.commonFacts.length > 0, result.cards.length > 0, "commonFacts follow cards");
  }
});

test("excludedList matches the excluded counters one to one", () => {
  for (const query of Object.values(QUERIES)) {
    const result = recommend(query);
    for (const reason of FILTER_REASONS) {
      const listed = result.excludedList.filter((item) => item.reason === reason).length;
      assert.equal(listed, result.excluded[reason], `${reason}: ${listed} listed vs ${result.excluded[reason]} counted`);
    }
    for (const item of result.excludedList) {
      assert.ok(item.id && item.name && item.detail?.trim(), `excluded ${item.id}: empty detail`);
    }
  }
});

test("actions carry a complete query the UI can send back unchanged", () => {
  for (const query of Object.values(QUERIES)) {
    const result = recommend(query);
    for (const action of result.actions) {
      assert.ok(action.label?.trim(), "action without a label");
      for (const field of ["city", "date", "eventType", "category", "budget"]) {
        assert.ok(action.query[field] !== undefined, `action «${action.label}»: missing ${field}`);
      }
      assert.doesNotThrow(() => recommend(action.query), `action «${action.label}» is not a valid query`);
    }
  }
});

test("the contract holds across the whole catalogue, not just the demo queries", () => {
  const contractors = loadContractors();
  const facets = catalogueFacets(contractors);
  let checked = 0;

  for (const city of facets.cities) {
    for (const category of facets.categories) {
      for (const eventType of facets.eventTypes) {
        const result = recommend({ city, date: "2026-11-14", eventType, category, budget: 1200000 });
        assert.ok(["found", "partial", "all_filtered", "no_category"].includes(result.status));
        for (const card of result.cards) {
          assert.ok(card.facts.differentiators.length > 0, `${card.id}: empty differentiators`);
          assert.ok(card.factChips.length >= 2, `${card.id}: too few chips`);
        }
        checked += 1;
      }
    }
  }
  assert.ok(checked > 300, `expected a full sweep, ran ${checked} queries`);
});
