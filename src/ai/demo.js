import assert from "node:assert/strict";
import { recommend } from "../engine/recommend.js";
import { createExplainer } from "./explain.js";
import { DEMO_SCENARIOS } from "./scenarios.js";

const live = process.argv.includes("--live");
const explain = createExplainer({
  ...(live ? {} : { apiKey: "", model: "offline-template" }),
  onFallback(reason) {
    if (live || reason !== "no_api_key") console.error(`Резервные объяснения: ${reason}`);
  },
});
for (const { title, query } of DEMO_SCENARIOS) {
  const started = performance.now();
  const result = await explain(recommend(query));
  console.log(`\n${title}: ${result.status} (${Math.round(performance.now() - started)} мс)`);
  console.log(result.message);
  if (result.commonFacts) console.log(result.commonFacts.text);
  for (const card of result.cards) {
    console.log(`${card.name} (${card.id}), synthetic=${card.flags.synthetic}, ${card.explanationSource}`);
    console.log(card.explanation);
  }
  const repeat = await explain(recommend(query));
  const comparable = (value) => value.cards.map(({ id, explanation }) => ({ id, explanation }));
  if (result.cards.some((card) => card.explanationSource === "template")
    && repeat.cards.some((card) => card.explanationSource === "llm")) {
    console.log("LLM восстановился: временный шаблон заменён проверенным ответом.");
  } else {
    assert.deepEqual(comparable(repeat), comparable(result));
  }
}
console.log("\nПовторяемость порядка и объяснений: OK");
