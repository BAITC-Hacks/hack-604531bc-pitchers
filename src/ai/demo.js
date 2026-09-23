import assert from "node:assert/strict";
import { recommend } from "../engine/recommend.js";
import { createExplainer } from "./explain.js";

const live = process.argv.includes("--live");
const explain = createExplainer({
  ...(live ? {} : { apiKey: "", model: "offline-template" }),
  onFallback(reason) {
    if (live || reason !== "no_api_key") console.error(`Резервные объяснения: ${reason}`);
  },
});
const base = { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 };
const scenarios = [
  ["Плотная категория", base],
  ["Та же категория в декабре", { ...base, date: "2026-12-26" }],
  ["Редкая категория", { ...base, category: "Флорист", eventType: "свадьба", budget: 500000 }],
  ["Категории нет в городе", { ...base, city: "Астана", category: "Декоратор" }],
  ["Все отфильтрованы", { ...base, date: "2026-12-25", budget: 100000 }],
];

for (const [title, query] of scenarios) {
  const started = performance.now();
  const result = await explain(recommend(query));
  console.log(`\n${title}: ${result.status} (${Math.round(performance.now() - started)} мс)`);
  console.log(result.message);
  for (const card of result.cards) {
    console.log(`${card.name} (${card.id}), synthetic=${card.flags.synthetic}, ${card.explanationSource}`);
    console.log(card.explanation);
  }
  const repeat = await explain(recommend(query));
  const comparable = (value) => value.cards.map(({ id, explanation }) => ({ id, explanation }));
  assert.deepEqual(comparable(repeat), comparable(result));
}
console.log("\nПовторяемость порядка и объяснений: OK");
