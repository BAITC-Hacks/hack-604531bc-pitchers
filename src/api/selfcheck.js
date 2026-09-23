import { Router } from "express";
import { DATE_WINDOW, getContractors } from "../engine/data.js";
import { recommend } from "../engine/recommend.js";
import { compareDates } from "../engine/compare.js";

// A missing AI module must not prevent the server's recommendation fallback from starting.
const aiModule = import("../ai/explain.js").catch(() => null);
const forbiddenPhrase = /отличный выбор|идеальн(?:ый выбор|о подойд[её]т)|прекрасно подойд[её]т|профессионал своего дела/iu;

const REQUEST_LIMIT_MS = 10000;
const DEMO = { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 };
const SCENARIOS = [
  ["Демо №1", DEMO],
  ["Повтор демо №1", DEMO],
  ["Ведущие 26.12", { ...DEMO, date: "2026-12-26" }],
  ["Флористы", { ...DEMO, eventType: "свадьба", category: "Флорист", budget: 500000 }],
  ["Декораторы в Астане", { ...DEMO, city: "Астана", eventType: "свадьба", category: "Декоратор", budget: 1000000 }],
  ["Банкетные залы 19.12", { ...DEMO, date: "2026-12-19", category: "Банкетный зал", budget: 3000000 }],
];

const ids = (result) => result.cards.map((card) => card.id);
const sameIds = (a, b) => JSON.stringify(ids(a)) === JSON.stringify(ids(b));
const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const normalize = (text) => text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/gu, " ").trim();
const roundMs = (ms) => Math.round(ms * 100) / 100;

function numericDetails(text) {
  // Treat grouped money as one number, and compare tokens (100 is not 1000).
  const compact = text.replace(/(?<=\d)[ \u00a0\u202f](?=\d)/g, "");
  return new Set((compact.match(/\d+(?:[.,]\d+)?/g) ?? []).map((value) => Number(value.replace(",", "."))));
}

function distinctWithoutValidator(cards) {
  const texts = cards.map((card) => normalize(card.explanation));
  const numbers = texts.map(numericDetails);
  return texts.every((text, index) => {
    const peers = texts.filter((_, other) => other !== index);
    const uniqueNumber = [...numbers[index]].some((value) =>
      numbers.every((other, peer) => peer === index || !other.has(value)),
    );
    const quotes = [...text.matchAll(/«([^»]+)»|“([^”]+)”|"([^"\n]+)"/g)]
      .map((match) => (match[1] ?? match[2] ?? match[3]).trim()).filter(Boolean);
    return uniqueNumber || quotes.some((quote) => peers.every((peer) => !peer.includes(quote)));
  });
}

async function measure(label, operation, timeoutMs) {
  const started = performance.now();
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("selfcheck_timeout")), timeoutMs);
      }),
    ]);
    return { label, value, ms: performance.now() - started };
  } catch (error) {
    return {
      label,
      error: error?.message === "selfcheck_timeout"
        ? `«${label}»: превышено время ожидания ${timeoutMs} мс.`
        : `«${label}»: не удалось выполнить проверку движка или объяснений.`,
      ms: performance.now() - started,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Run against live modules by default; overrides keep regression tests offline. */
export async function runSelfcheck(options = {}) {
  const ai = await aiModule;
  const engine = options.recommend ?? recommend;
  const explain = options.explain ?? ai?.explain;
  const compare = options.compareDates ?? compareDates;
  const catalogue = options.getContractors ?? getContractors;
  const validator = Object.hasOwn(options, "pairwiseDistinct") ? options.pairwiseDistinct : ai?.pairwiseDistinct;
  const timeoutMs = options.timeoutMs ?? REQUEST_LIMIT_MS;

  // Independent scenarios share the wall-clock budget, but each measures its own pipeline.
  const jobs = await Promise.all([
    ...SCENARIOS.map(([label, query]) => measure(label, async () => {
      const result = await engine({ ...query });
      const explained = await explain(structuredClone(result));
      if (!Array.isArray(explained?.cards) || !sameIds(result, explained)) {
        throw new Error("Explanation layer changed the selected cards");
      }
      return explained;
    }, timeoutMs)),
    measure("Сравнение дат", () => compare({ ...DEMO }, "2026-12-26"), timeoutMs),
    measure("Каталог", catalogue, timeoutMs),
  ]);
  const [first, repeated, december, rare, absent, halls, comparison, contractors] = jobs;
  const requests = jobs.slice(0, -1);
  const queries = jobs.slice(0, SCENARIOS.length);

  function check(id, title, dependencies, evaluate) {
    const started = performance.now();
    let outcome;
    try {
      const failures = dependencies.filter((job) => job.error);
      outcome = failures.length
        ? { passed: false, detail: failures.map((job) => job.error).join(" ") }
        : evaluate();
    } catch {
      outcome = { passed: false, detail: "Ответ не содержит данных, необходимых для этой проверки." };
    }
    return {
      id, title, passed: Boolean(outcome.passed), detail: outcome.detail,
      // Includes the slowest prerequisite; scenarios execute concurrently.
      ms: roundMs(Math.max(0, ...dependencies.map((job) => job.ms)) + performance.now() - started),
    };
  }

  return [
    check("determinism", "Детерминизм демо №1", [first, repeated], () => ({
      passed: first.value.cards.length > 0 && sameIds(first.value, repeated.value),
      detail: `Первый запуск: ${ids(first.value).join(", ") || "нет карточек"}; повтор: ${ids(repeated.value).join(", ") || "нет карточек"}.`,
    })),
    check("availability", "Все показанные подрядчики свободны", [...queries, comparison, contractors], () => {
      const byId = new Map(contractors.value.map((contractor) => [contractor.id, contractor]));
      const results = [...queries.map((job) => job.value), comparison.value.a, comparison.value.b];
      const problems = [];
      let count = 0;
      for (const result of results) {
        for (const card of result.cards) {
          count += 1;
          const contractor = byId.get(card.id);
          if (!contractor) problems.push(`${card.id}: нет в каталоге`);
          else if (contractor.busyDates.has(result.query.date)) problems.push(`${card.id}: занят ${result.query.date}`);
        }
      }
      return {
        passed: count > 0 && problems.length === 0,
        detail: problems.length ? problems.join("; ") : `Проверено карточек по календарям: ${count}; занятых — 0.`,
      };
    }),
    check("date_change", "Смена даты на 26.12 меняет выдачу", [first, december, comparison], () => {
      const { a, b, diff } = comparison.value;
      const dropped = diff.droppedOut;
      const actualDropped = ids(a).filter((id) => !ids(b).includes(id));
      const busy = dropped.filter((item) => actualDropped.includes(item.id)
        && /занят/iu.test(item.detail)
        && b.excludedList.some((excluded) => excluded.id === item.id && excluded.reason === "busy"));
      return {
        passed: !sameIds(first.value, december.value) && sameIds(first.value, a) && sameIds(december.value, b)
          && actualDropped.length > 0 && dropped.length === actualDropped.length
          && actualDropped.every((id) => dropped.some((item) => item.id === id)) && busy.length > 0,
        detail: `Выпали из выдачи: ${dropped.map((item) => `${item.id} — ${item.detail}`).join("; ") || "никто"}.`,
      };
    }),
    check("dense_category", "Плотная категория: три карточки", [first], () => ({
      passed: first.value.status === "found" && first.value.cards.length === 3,
      detail: `Статус: ${first.value.status}; карточек: ${first.value.cards.length}.`,
    })),
    check("rare_category", "Редкая категория: объяснено, почему меньше трёх", [rare], () => {
      const result = rare.value;
      const message = result.message ?? "";
      const reasons = {
        busy: "занят[а-яё]*",
        over_budget: "дороже\\s+бюджета",
        format: "не\\s+работа[а-яё]*\\s+с\\s+форматом",
        language: "не\\s+работа[а-яё]*\\s+на\\s+языке",
        hours: "не\\s+закрыва[а-яё]*\\s+\\d+(?:[.,]\\d+)?\\s*ч",
      };
      const excludedReason = Object.entries(reasons).some(([reason, phrase]) => {
        const count = result.excluded[reason];
        return count > 0 && new RegExp(`(?<!\\d)${count}\\s+${phrase}`, "iu").test(message);
      });
      const smallCatalogue = result.candidatesTotal < 3
        && new RegExp(`(?:из|всего|только)\\s+${result.candidatesTotal}\\s+(?:подрядчик|флорист|профил|кандидат)`, "iu").test(message);
      return {
        passed: result.status === "partial" && result.cards.length > 0 && result.cards.length < 3
          && nonempty(message) && (excludedReason || smallCatalogue),
        detail: `Карточек: ${result.cards.length}. ${message || "Объяснение отсутствует."}`,
      };
    }),
    check("no_category", "Декораторы в Астане: нет категории", [absent], () => ({
      passed: absent.value.status === "no_category" && absent.value.cards.length === 0 && nonempty(absent.value.message),
      detail: `Статус: ${absent.value.status}. ${absent.value.message || "Сообщение отсутствует."}`,
    })),
    check("all_filtered", "Банкетные залы 19.12: отказ с подсказками", [halls], () => {
      const result = halls.value;
      const hints = result.hints ?? {};
      const date = hints.nearestFreeDate;
      const timestamp = Date.parse(`${date}T00:00:00Z`);
      const dayOffset = Math.abs(timestamp - Date.parse(`${result.query.date}T00:00:00Z`)) / 86400000;
      const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(date ?? "") && Number.isFinite(timestamp)
        && new Date(timestamp).toISOString().slice(0, 10) === date
        && date >= DATE_WINDOW.min && date <= DATE_WINDOW.max && dayOffset > 0 && dayOffset <= 14;
      const hasBudget = Number.isFinite(hints.minBudgetNeeded) && hints.minBudgetNeeded > result.query.budget;
      return {
        passed: result.status === "all_filtered" && result.cards.length === 0 && (hasDate || hasBudget),
        detail: `Статус: ${result.status}; ближайшая дата: ${hints.nearestFreeDate ?? "нет"}; минимальный бюджет: ${hints.minBudgetNeeded ?? "нет"}.`,
      };
    }),
    check("latency", "Каждый запрос быстрее 10 000 мс", requests, () => ({
      passed: requests.every((job) => job.ms < REQUEST_LIMIT_MS),
      detail: requests.map((job) => `${job.label}: ${roundMs(job.ms)} мс`).join("; "),
    })),
    check("distinct_explanations", "Объяснения демо №1 попарно различимы", [first], () => {
      const result = first.value;
      const complete = result.cards.length === 3 && result.cards.every((card) => nonempty(card.explanation));
      const texts = Object.fromEntries(result.cards.map((card) => [card.id, card.explanation]));
      const passed = complete && (typeof validator === "function" ? validator(texts, result) : distinctWithoutValidator(result.cards));
      return {
        passed,
        detail: passed ? `У всех ${result.cards.length} карточек подтверждены отличия в объяснениях.`
          : "Не у каждой карточки есть отличающее её число или цитата; проверьте тексты объяснений.",
      };
    }),
    check("no_generic_phrases", "В объяснениях нет запрещённых общих фраз", queries, () => {
      const cards = queries.flatMap((job) => job.value.cards);
      const problems = cards.filter((card) => !nonempty(card.explanation) || forbiddenPhrase.test(normalize(card.explanation)));
      return {
        passed: cards.length > 0 && problems.length === 0,
        detail: problems.length ? `Пустой текст или запрещённая фраза у карточек: ${[...new Set(problems.map((card) => card.id))].join(", ")}.`
          : `Проверено объяснений: ${cards.length}; запрещённых фраз — 0.`,
      };
    }),
  ];
}

export const selfcheckRouter = Router();
selfcheckRouter.get("/api/selfcheck", async (_request, response) => {
  response.set("Cache-Control", "no-store");
  response.json(await runSelfcheck());
});

export default selfcheckRouter;
