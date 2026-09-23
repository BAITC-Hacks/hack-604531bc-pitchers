import { pathToFileURL } from "node:url";
import { recommend } from "../src/engine/recommend.js";
import { createExplainer, pairwiseDistinct } from "../src/ai/explain.js";
import { DEMO_SCENARIOS } from "../src/ai/scenarios.js";

export function blindView(result) {
  const identities = result.cards.flatMap(({ id, name }) => [id, name]).filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const redact = (text) => identities.reduce((value, identity) => {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return value.replace(new RegExp(escaped, "giu"), "[имя скрыто]");
  }, text);
  const redacted = { ...result, cards: result.cards.map((card) => ({ ...card,
    facts: { ...card.facts, descriptionSnippet: redact(card.facts.descriptionSnippet ?? "") },
  })) };
  const texts = Object.fromEntries(result.cards.map((card) => [card.id, redact(card.explanation)]));
  return {
    distinct: pairwiseDistinct(texts, redacted),
    lines: result.cards.map((card, index) => `${String.fromCharCode(65 + index)} [${card.explanationSource}]: ${texts[card.id]}`),
  };
}

export async function runBlindTest({ live = false, explain, scenarios = DEMO_SCENARIOS, log = console.log } = {}) {
  explain ??= createExplainer(live ? {} : { apiKey: "", model: "offline-template" });
  log(live ? "Режим: LLM и проверенный кэш; резерв обозначен template." : "Режим: шаблоны, без вызова LLM.");
  let passed = true;
  for (const { title, query } of scenarios) {
    const result = await explain(recommend(query));
    log(`\n${title}: ${result.status}`);
    log(result.message);
    if (result.commonFacts) log(result.commonFacts.text);
    if (!result.cards.length) {
      log("Карточек нет: проверка различимости не требуется.");
      continue;
    }
    const view = blindView(result);
    for (const line of view.lines) log(line);
    if (result.cards.length === 1) log("Одна карточка: попарное сравнение не требуется.");
    else log(view.distinct ? "Попарная различимость без имён: OK" : "Попарная различимость: НЕ ПРОЙДЕНА, фактов недостаточно.");
    passed &&= view.distinct;
    if (live && result.cards.some((card) => card.explanationSource === "template")) {
      log("Настоящий ответ LLM не получен; этот сценарий пока не готов к показу LLM.");
      passed = false;
    }
  }
  return passed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { if (!await runBlindTest({ live: process.argv.includes("--live") })) process.exitCode = 1; }
  catch { console.error("Слепая проверка не завершена."); process.exitCode = 1; }
}
