import { pathToFileURL } from "node:url";
import { recommend } from "../engine/recommend.js";
import { createCache } from "./cache.js";
import { createExplainer, validExplanations } from "./explain.js";
import { DEMO_SCENARIOS } from "./scenarios.js";

export async function warmCache({ filePath, refresh = false, explainerOptions = {}, scenarios = DEMO_SCENARIOS, log = console.log } = {}) {
  const diskCache = createCache({ filePath });
  let fallbackReason;
  const explain = createExplainer({ ...explainerOptions,
    cache: refresh ? { get: () => undefined, set: (...args) => diskCache.set(...args) } : diskCache,
    onFallback: (reason) => { fallbackReason = reason; },
  });
  const summary = { ready: 0, empty: 0, failed: 0, total: scenarios.length };
  const comparable = (result) => result.cards.map(({ id, explanation }) => ({ id, explanation }));
  for (const { title, query } of scenarios) {
    fallbackReason = undefined;
    const started = performance.now();
    const engine = recommend(query);
    const result = await explain(engine);
    if (!result.cards.length) {
      summary.empty += 1;
      log(`${title}: ${result.status}; карточек нет, LLM не требуется.`);
      continue;
    }
    const texts = Object.fromEntries(result.cards.map((card) => [card.id, card.explanation]));
    if (result.cards.some((card) => !["llm", "cache"].includes(card.explanationSource)) || !validExplanations(texts, engine)) {
      summary.failed += 1;
      log(`${title}: НЕ ГОТОВО, ${fallbackReason ?? "invalid_response"}; шаблон не сохранён в кэш.`);
      continue;
    }
    // A new reader with networking disabled verifies persistence, not the in-memory hit.
    const read = createExplainer({ ...explainerOptions, apiKey: "", client: undefined,
      cache: createCache({ filePath }), onFallback: () => {},
    });
    const persisted = await read(engine);
    const saved = persisted.cards.every((card) => card.explanationSource === "cache")
      && JSON.stringify(comparable(result)) === JSON.stringify(comparable(persisted));
    if (!saved) {
      summary.failed += 1;
      log(`${title}: НЕ ГОТОВО, ответ LLM не подтверждён в файловом кэше.`);
      continue;
    }
    summary.ready += 1;
    log(`${title}: ${result.cards[0].explanationSource}; ${result.cards.length} карточек, ${Math.round(performance.now() - started)} мс; файловый кэш подтверждён.`);
  }
  log(`\nГотово с LLM-кэшем: ${summary.ready}; без карточек: ${summary.empty}; не готово: ${summary.failed}; всего: ${summary.total}.`);
  if (summary.failed) log("Прогрев НЕ завершён. Не выдавайте резервные шаблоны за ответы модели.");
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await warmCache({ refresh: process.argv.includes("--refresh"),
      explainerOptions: process.argv.includes("--check") ? { apiKey: "" } : {},
    });
    if (result.failed) process.exitCode = 1;
  } catch { console.error("Прогрев не завершён: проверьте настройки и доступ к каталогу."); process.exitCode = 1; }
}
