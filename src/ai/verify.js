import assert from "node:assert/strict";
import { once } from "node:events";
import { recommend } from "../engine/recommend.js";

// Isolate the smoke check from credentials and live-model cache entries.
process.env.LLM_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_MODEL = "http-verification-offline";

const { app } = await import("../server.js");
const { validExplanations } = await import("./explain.js");
const { commonFacts: expectedCommonFacts } = await import("./templates.js");
const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const baseURL = `http://127.0.0.1:${server.address().port}`;
const base = { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 };
const scenarios = [
  ["Плотная категория", base, "found", 3],
  ["Другая дата", { ...base, date: "2026-12-26" }, "partial", 1],
  ["Редкая категория", { ...base, category: "Флорист", eventType: "свадьба", budget: 500000 }, "partial", 1],
  ["Нет категории", { ...base, city: "Астана", category: "Декоратор" }, "no_category", 0],
  ["Все отфильтрованы", { ...base, date: "2026-12-25", budget: 100000 }, "all_filtered", 0],
];

async function request(query) {
  return fetch(`${baseURL}/api/recommend`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(query), signal: AbortSignal.timeout(10000),
  });
}

try {
  const metaResponse = await fetch(`${baseURL}/api/meta`, { signal: AbortSignal.timeout(10000) });
  assert.equal(metaResponse.status, 200);
  const meta = await metaResponse.json();
  assert.ok(meta.cities.includes(base.city));
  assert.ok(meta.categories.includes(base.category));
  assert.deepEqual(meta.dateRange, { min: "2026-09-23", max: "2026-12-31" });
  console.log("Метаданные каталога: OK");

  for (const [label, query, expectedStatus, expectedCount] of scenarios) {
    const started = performance.now();
    const response = await request(query);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.status, expectedStatus);
    assert.equal(result.cards.length, expectedCount);
    assert.ok(result.message.trim());
    assert.ok(Number.isFinite(result.elapsedMs) && result.elapsedMs < 10000);
    const engine = recommend(query);
    const { elapsedMs, commonFacts, ...withoutTiming } = result;
    if (result.cards.length) assert.deepEqual(commonFacts, expectedCommonFacts(engine));
    const plainCards = result.cards.map(({ explanation, explanationSource, ...card }) => {
      assert.ok(["template", "cache"].includes(explanationSource));
      assert.ok(explanation.trim());
      return card;
    });
    const { commonFacts: engineCommonFacts, ...engineWithoutCommonFacts } = engine;
    assert.deepEqual({ ...withoutTiming, cards: plainCards }, engineWithoutCommonFacts);
    assert.deepEqual(commonFacts, engineCommonFacts);
    assert.ok(validExplanations(Object.fromEntries(result.cards.map((card) => [card.id, card.explanation])), engine));
    const repeatedResponse = await request(query);
    assert.equal(repeatedResponse.status, 200);
    const repeated = await repeatedResponse.json();
    const comparable = (value) => value.cards.map(({ id, explanation }) => ({ id, explanation }));
    assert.deepEqual(comparable(result), comparable(repeated));
    console.log(`${label}: ${result.status}, карточек ${result.cards.length}, ${Math.round(performance.now() - started)} мс (с повтором)`);
  }

  for (const invalid of [{ ...base, date: "2027-01-01" }, { ...base, budget: -1 }]) {
    const response = await request(invalid);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /[а-яё]/iu);
  }
  const malformed = await fetch(`${baseURL}/api/recommend`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: "{", signal: AbortSignal.timeout(10000),
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /JSON/);
  console.log("Ошибки ввода: HTTP 400 с понятным сообщением");
  console.log("HTTP-проверка, сохранение контракта и повторяемость: OK");
} finally {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}
