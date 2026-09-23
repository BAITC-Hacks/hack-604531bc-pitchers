import test from "node:test";
import assert from "node:assert/strict";
import { blindView, runBlindTest } from "../../scripts/blind-test.js";
import { createCache } from "./cache.js";
import { createExplainer } from "./explain.js";
import { DEMO_SCENARIOS } from "./scenarios.js";
import { recommend } from "../engine/recommend.js";

const offline = () => createExplainer({ apiKey: "", cache: createCache({ filePath: null }) });

test("blind script checks all five demos without logging names or IDs", async () => {
  const lines = [];
  assert.equal(await runBlindTest({ explain: offline(), log: (line) => lines.push(line) }), true);
  const output = lines.join("\n");
  assert.match(output, /Попарная различимость без имён: OK/);
  assert.match(output, /Одна карточка/);
  assert.match(output, /Карточек нет/);
  for (const scenario of DEMO_SCENARIOS) {
    assert.ok(output.includes(scenario.title));
    for (const card of recommend(scenario.query).cards) {
      assert.ok(!output.includes(card.id));
      assert.ok(!output.includes(card.name));
    }
  }
});

test("names hidden inside explanation quotes are not accepted as unique evidence", () => {
  const result = recommend(DEMO_SCENARIOS[0].query);
  const facts = { ...result.cards[0].facts, differentiators: [] };
  result.cards = ["Анна", "Ольга"].map((name, index) => ({
    ...result.cards[0], id: `private-${index}`, name,
    facts: { ...facts, descriptionSnippet: `Ведущий ${name}` },
    explanation: `В описании: «Ведущий ${name}». Цена от 900 000 ₸.`, explanationSource: "template",
  }));
  const view = blindView(result);
  assert.equal(view.distinct, false);
  assert.ok(view.lines.every((line) => !/Анна|Ольга|private-/u.test(line)));
});

test("live blind demo never claims templates are real LLM answers", async () => {
  const lines = [];
  assert.equal(await runBlindTest({ live: true, explain: offline(), log: (line) => lines.push(line) }), false);
  assert.ok(lines.some((line) => line.includes("Настоящий ответ LLM не получен")));
});
