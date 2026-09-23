/**
 * Generates docs/selfcheck.md and docs/metrics.md from a real run,
 * so the numbers in the repository can be read without starting anything.
 * Usage: node scripts/report.js
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { catalogueFacets, loadContractors } from "../src/engine/data.js";
import { FILTER_REASONS } from "../src/engine/filters.js";
import { recommend } from "../src/engine/recommend.js";
import { runSelfcheck } from "../src/api/selfcheck.js";

const STRICT_TAGS = new Set([
  "cheapest", "onlyKazakh", "noHourLimit", "mostHours", "mostSpecialized", "onlyMentionsEventType",
]);
const SWEEP_DATES = ["2026-10-17", "2026-11-14", "2026-12-26"];
const SWEEP_BUDGET = 1200000;

const docPath = (name) => fileURLToPath(new URL(`../docs/${name}`, import.meta.url));
const percent = (part, total) => (total === 0 ? "0%" : `${Math.round((part / total) * 1000) / 10}%`);
const stamp = () => new Date().toISOString().slice(0, 19).replace("T", " ");

function selfcheckReport(checks) {
  const passed = checks.filter((check) => check.passed).length;
  const rows = checks
    .map((check) => `| ${check.title} | ${check.passed ? "✅" : "❌"} | ${check.detail.replace(/\|/g, "\\|")} | ${Math.round(check.ms)} |`)
    .join("\n");

  return `# Отчёт самопроверки

Сгенерировано: \`node scripts/report.js\`, ${stamp()} UTC. Это вывод живого \`GET /api/selfcheck\`
на реальных данных каталога — те же десять проверок доступны в работающем сервисе.

**Итог: ${passed} из ${checks.length}.**

| Проверка | Результат | Детали | мс |
| --- | --- | --- | --- |
${rows}

Проверки отражают требования кейса: занятый на дату не попадает в выдачу, повтор запроса
даёт тот же порядок, смена даты меняет выдачу и это видно в причинах, три исхода различимы
и объяснены, объяснения попарно различимы и без общих фраз, каждый запрос быстрее 10 секунд.
`;
}

function metricsReport() {
  const contractors = loadContractors();
  const facets = catalogueFacets(contractors);

  const statuses = { found: 0, partial: 0, all_filtered: 0, no_category: 0 };
  const reasons = Object.fromEntries(FILTER_REASONS.map((reason) => [reason, 0]));
  const durations = [];
  let queries = 0;
  let cards = 0;
  let cardsWithDifferentiator = 0;
  let strictOnly = 0;
  let withActions = 0;

  for (const city of facets.cities) {
    for (const category of facets.categories) {
      for (const eventType of facets.eventTypes) {
        for (const date of SWEEP_DATES) {
          const started = performance.now();
          const result = recommend({ city, date, eventType, category, budget: SWEEP_BUDGET });
          durations.push(performance.now() - started);
          queries += 1;
          statuses[result.status] += 1;
          for (const reason of FILTER_REASONS) reasons[reason] += result.excluded[reason];
          if (result.actions.length > 0) withActions += 1;
          for (const card of result.cards) {
            cards += 1;
            const tags = card.facts.differentiators;
            if (tags.length > 0) cardsWithDifferentiator += 1;
            if (tags.some((tag) => STRICT_TAGS.has(tag))) strictOnly += 1;
          }
        }
      }
    }
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const slowest = sorted[sorted.length - 1];
  const excludedTotal = Object.values(reasons).reduce((sum, value) => sum + value, 0);

  const statusRows = Object.entries(statuses)
    .map(([status, count]) => `| \`${status}\` | ${count} | ${percent(count, queries)} |`)
    .join("\n");
  const reasonRows = FILTER_REASONS.map(
    (reason) => `| \`${reason}\` | ${reasons[reason]} | ${percent(reasons[reason], excludedTotal)} |`,
  ).join("\n");

  return `# Метрики движка

Сгенерировано: \`node scripts/report.js\`, ${stamp()} UTC. Прогон по всему каталогу:
города (${facets.cities.length}) × категории (${facets.categories.length}) × форматы (${facets.eventTypes.length})
× даты (${SWEEP_DATES.join(", ")}), бюджет ${SWEEP_BUDGET.toLocaleString("ru-RU")} ₸ — **${queries} запросов**.
Без LLM: измеряется только детерминированное ядро.

## Исходы

| Статус | Запросов | Доля |
| --- | --- | --- |
${statusRows}

Каждый исход сопровождается русским сообщением с числами, а \`partial\` и \`all_filtered\` —
ещё и подсказками. Хотя бы одно готовое действие («Показать на другую дату», «Показать
в другом городе») предложено в ${withActions} запросах из ${queries} — ${percent(withActions, queries)}.

## Причины отсева

Всего отсеяно кандидатов: ${excludedTotal}. У каждого ровно одна причина — первая непройденная.

| Причина | Случаев | Доля |
| --- | --- | --- |
${reasonRows}

Нули у \`language\` и \`hours\` — свойство этого прогона, а не кода: язык и длительность
необязательны и в свипе не задавались, поэтому соответствующие фильтры не включались.
Их работу покрывают тесты в \`tests/\`.

## Различимость карточек

| Показатель | Значение |
| --- | --- |
| Карточек показано | ${cards} |
| С непустым списком отличий | ${cardsWithDifferentiator} (${percent(cardsWithDifferentiator, cards)}) |
| Отличие найдено строгим правилом | ${strictOnly} (${percent(strictOnly, cards)}) |
| Отличие найдено запасной лестницей | ${cards - strictOnly} (${percent(cards - strictOnly, cards)}) |

Строгие правила — «самый доступный», «больше всех часов», «единственный с казахским» и ещё три.
Когда ни одно не срабатывает, движок спускается по измеримым измерениям: ранг цены, уникальный
лимит часов, язык, ширина профиля, лучший компонент рейтинга, редкое слово из описания.
Поэтому карточку нельзя перепутать с соседней даже со скрытыми именами.

## Скорость ядра

| Показатель | Значение |
| --- | --- |
| Медиана | ${median.toFixed(2)} мс |
| Самый медленный запрос | ${slowest.toFixed(2)} мс |
| Профилей в каталоге | ${contractors.length} |

Время объяснений сюда не входит: предел AI — 8 секунд, внешний предел сервера — 9 секунд,
а при недоступной модели ответ собирается из фактов локально.
`;
}

const checks = await runSelfcheck();
writeFileSync(docPath("selfcheck.md"), selfcheckReport(checks), "utf8");
writeFileSync(docPath("metrics.md"), metricsReport(), "utf8");

console.log(`docs/selfcheck.md — ${checks.filter((check) => check.passed).length}/${checks.length}`);
console.log("docs/metrics.md — метрики по каталогу обновлены");
