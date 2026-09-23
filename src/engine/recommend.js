/**
 * Engine entry point: query -> EngineResult.
 * Deterministic end to end — the same query always produces the same object.
 */
import { DATE_WINDOW, catalogueFacets, getContractors } from "./data.js";
import { FILTER_REASONS, applyFilters, countExcluded, passesAll } from "./filters.js";
import { WEIGHTS, scoreCandidates } from "./score.js";

const MAX_CARDS = 3;
const HINT_WINDOW_DAYS = 14;
const SNIPPET_LIMIT = 140;
const DAY_MS = 86400000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Thrown for bad input; the server turns it into 400 with this Russian message. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

// --- formatting helpers (all user-facing text is Russian) ------------------

const CITY_IN = { "Алматы": "в Алматы", "Астана": "в Астане", "Зарубежье": "за рубежом" };
const cityIn = (city) => CITY_IN[city] ?? `в городе ${city}`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

const toUtc = (date) => {
  const [year, month, day] = date.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
};
const toIso = (ms) => new Date(ms).toISOString().slice(0, 10);
const isRealDate = (date) => DATE_PATTERN.test(date) && toIso(toUtc(date)) === date;
const inWindow = (date) => date >= DATE_WINDOW.min && date <= DATE_WINDOW.max;

const formatDate = (date) => date.split("-").reverse().join(".");
const formatMoney = (value) => `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`;
const plural = (count, one, many) => (count % 10 === 1 && count % 100 !== 11 ? one : many);
const round4 = (value) => Math.round(value * 1e4) / 1e4;

// --- query validation ------------------------------------------------------

function requireText(value, field) {
  const text = String(value ?? "").trim();
  if (!text) throw new ValidationError(`Не заполнено поле «${field}».`);
  return text;
}

function requireKnown(value, allowed, field) {
  const text = requireText(value, field);
  const match = allowed.find((item) => item.toLowerCase() === text.toLowerCase());
  if (!match) throw new ValidationError(`Неизвестное значение «${text}» в поле «${field}».`);
  return match;
}

function positiveNumber(value, field, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ValidationError(`Поле «${field}» должно быть положительным числом.`);
  }
  if (max !== undefined && parsed > max) {
    throw new ValidationError(`Поле «${field}» не может быть больше ${max}.`);
  }
  return parsed;
}

const isBlank = (value) => value === undefined || value === null || value === "";

/**
 * An unknown city / event type / language is a client bug, so it fails loudly.
 * An unknown category is a legitimate product answer instead: status `no_category`.
 */
export function normalizeQuery(rawQuery, facets) {
  const query = rawQuery ?? {};

  const date = requireText(query.date, "дата");
  if (!isRealDate(date)) {
    throw new ValidationError(`Некорректная дата «${date}», ожидается формат ГГГГ-ММ-ДД.`);
  }
  if (!inWindow(date)) {
    throw new ValidationError(
      `Дата ${formatDate(date)} вне календаря подрядчиков: ` +
        `${formatDate(DATE_WINDOW.min)} — ${formatDate(DATE_WINDOW.max)}.`,
    );
  }
  if (isBlank(query.budget)) throw new ValidationError("Не заполнено поле «бюджет».");

  return {
    city: requireKnown(query.city, facets.cities, "город"),
    date,
    eventType: requireKnown(query.eventType, facets.eventTypes, "тип мероприятия"),
    category: requireText(query.category, "категория"),
    budget: positiveNumber(query.budget, "бюджет"),
    ...(isBlank(query.hours) ? {} : { hours: positiveNumber(query.hours, "длительность", 24) }),
    ...(isBlank(query.language) ? {} : { language: requireKnown(query.language, facets.languages, "язык") }),
  };
}

// --- facts -----------------------------------------------------------------

/** <=140 chars around the first matched keyword; without a match — the first sentence. */
function descriptionSnippet(description, matchedKeywords) {
  const text = String(description ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";

  const index = matchedKeywords.length > 0 ? text.toLowerCase().indexOf(matchedKeywords[0]) : -1;
  if (index === -1) {
    const sentence = text.split(/(?<=[.?!])\s/)[0];
    return sentence.length <= SNIPPET_LIMIT ? sentence : `${sentence.slice(0, SNIPPET_LIMIT - 1).trimEnd()}…`;
  }

  const start = Math.max(0, index - Math.floor((SNIPPET_LIMIT - matchedKeywords[0].length) / 2));
  const prefix = start > 0 ? "…" : "";
  // The ellipses count towards the 140 chars, so reserve room for them before slicing.
  const room = SNIPPET_LIMIT - prefix.length - 1;
  const end = start + room;
  return `${prefix}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** What this card has that the OTHER shown cards do not. One card has nothing to contrast with. */
function differentiatorsFor(entry, shown) {
  if (shown.length < 2) return [];

  const others = shown.filter((item) => item.contractor.id !== entry.contractor.id);
  const { contractor, matchedKeywords } = entry;
  const tags = [];

  const otherPrices = others.map((item) => item.contractor.priceFrom).filter((price) => price !== null);
  if (
    contractor.priceFrom !== null &&
    otherPrices.length === others.length &&
    otherPrices.every((price) => contractor.priceFrom < price)
  ) {
    tags.push("cheapest");
  }
  if (
    contractor.languages.includes("казахский") &&
    others.every((item) => !item.contractor.languages.includes("казахский"))
  ) {
    tags.push("onlyKazakh");
  }
  if (contractor.maxHours === null && others.some((item) => item.contractor.maxHours !== null)) {
    tags.push("noHourLimit");
  }
  const otherHours = others.map((item) => item.contractor.maxHours).filter((value) => value !== null);
  if (
    contractor.maxHours !== null &&
    otherHours.length === others.length &&
    otherHours.every((value) => contractor.maxHours > value)
  ) {
    tags.push("mostHours");
  }
  if (others.every((item) => contractor.formats.length < item.contractor.formats.length)) {
    tags.push("mostSpecialized");
  }
  if (matchedKeywords.length > 0 && others.every((item) => item.matchedKeywords.length === 0)) {
    tags.push("onlyMentionsEventType");
  }
  return tags;
}

// --- fallback differentiators ----------------------------------------------

const WORD_PATTERN = /[a-zа-яё]{5,}/gi;
const SCORE_PARTS = ["relevance", "budget", "specialization", "hours", "dataQuality"];
const wordsOf = (description) => new Set(String(description ?? "").toLowerCase().match(WORD_PATTERN) ?? []);

const frequencyCache = new WeakMap();

/** How many profiles in the whole catalogue use each word — lets us pick the rarest one. */
function documentFrequency(contractors) {
  let frequency = frequencyCache.get(contractors);
  if (frequency === undefined) {
    frequency = new Map();
    for (const contractor of contractors) {
      for (const word of wordsOf(contractor.description)) {
        frequency.set(word, (frequency.get(word) ?? 0) + 1);
      }
    }
    frequencyCache.set(contractors, frequency);
  }
  return frequency;
}

/** Rarest word across the catalogue, ties broken alphabetically — deterministic either way. */
function rarestWord(words, frequency) {
  return [...words].sort(
    (a, b) => (frequency.get(a) ?? 0) - (frequency.get(b) ?? 0) || a.localeCompare(b, "ru"),
  )[0];
}

/**
 * Runs only when no strict differentiator applies: walks measurable dimensions in a fixed order
 * (price rank, hours, languages, formats, best score component, data origin, rare wording)
 * so every shown card always carries at least one concrete difference.
 */
function fallbackDifferentiator(entry, others, contractors) {
  const { contractor, scoreParts } = entry;
  const shownWithPrice = [entry, ...others].filter((item) => item.contractor.priceFrom !== null);

  if (contractor.priceFrom !== null && shownWithPrice.length === others.length + 1) {
    const prices = shownWithPrice.map((item) => item.contractor.priceFrom).sort((a, b) => a - b);
    if (new Set(prices).size === prices.length) {
      return `priceRank:${prices.indexOf(contractor.priceFrom) + 1}of${prices.length}`;
    }
  }
  if (contractor.maxHours !== null && others.every((item) => item.contractor.maxHours !== contractor.maxHours)) {
    return `uniqueHours:${contractor.maxHours}`;
  }
  const ownLanguages = contractor.languages.filter((language) =>
    others.every((item) => !item.contractor.languages.includes(language)),
  );
  if (ownLanguages.length > 0) return `onlyLanguage:${[...ownLanguages].sort((a, b) => a.localeCompare(b, "ru"))[0]}`;
  if (others.every((item) => contractor.languages.length > item.contractor.languages.length)) {
    return `mostLanguages:${contractor.languages.length}`;
  }
  if (others.every((item) => item.contractor.formats.length !== contractor.formats.length)) {
    return `uniqueFormatCount:${contractor.formats.length}`;
  }
  const bestPart = SCORE_PARTS.find((part) => others.every((item) => scoreParts[part] > item.scoreParts[part]));
  if (bestPart) return `bestScore:${bestPart}`;

  if (!contractor.flags.synthetic && others.some((item) => item.contractor.flags.synthetic)) return "realProfile";
  if (contractor.flags.synthetic && others.some((item) => !item.contractor.flags.synthetic)) return "syntheticProfile";

  const frequency = documentFrequency(contractors);
  const ownWords = wordsOf(contractor.description);
  const otherWords = new Set(others.flatMap((item) => [...wordsOf(item.contractor.description)]));
  const unique = [...ownWords].filter((word) => !otherWords.has(word));
  if (unique.length > 0) return `uniqueWord:${rarestWord(unique, frequency)}`;
  if (ownWords.size > 0) return `rareWord:${rarestWord(ownWords, frequency)}`;
  return "equalOnAllDimensions";
}

/** Strict tags first; if a card has none, the ladder above guarantees exactly one. */
function allDifferentiators(entry, shown, contractors) {
  // A single card has no siblings to contrast with, but being the only fit is itself a fact.
  if (shown.length < 2) return ["onlyFit"];
  const strict = differentiatorsFor(entry, shown);
  if (strict.length > 0) return strict;
  const others = shown.filter((item) => item.contractor.id !== entry.contractor.id);
  return [fallbackDifferentiator(entry, others, contractors)];
}

const LANGUAGE_WITH = { "казахский": "с казахским", "русский": "с русским", "английский": "с английским" };

const SCORE_PART_CHIPS = {
  relevance: "лучше всех совпадает с описанием",
  budget: "самый большой запас бюджета",
  specialization: "самый узкий профиль",
  hours: "лучше всех по часам",
  dataQuality: "самые полные данные в каталоге",
};

const DIFFERENTIATOR_CHIPS = {
  cheapest: () => "самый доступный из показанных",
  onlyKazakh: () => "единственный с казахским",
  mostHours: (facts) => `больше всех часов — до ${facts.maxHours} ч`,
  mostSpecialized: (facts) => `узкий профиль — ${facts.formats.length} ${plural(facts.formats.length, "формат", "формата")}`,
  onlyMentionsEventType: (_facts, query) => `единственный упоминает «${query.eventType}»`,
  noHourLimit: () => "без ограничения по часам",
  onlyFit: () => "единственный подходящий вариант",
  equalOnAllDimensions: () => "по всем признакам как у остальных",
  realProfile: () => "реальный профиль каталога",
  syntheticProfile: () => "синтетический профиль",
  priceRank: (_facts, _query, value) => `${value.replace("of", "-я цена из ")}`,
  uniqueHours: (_facts, _query, value) => `единственный с лимитом ${value} ч`,
  onlyLanguage: (_facts, _query, value) => `единственный ${LANGUAGE_WITH[value] ?? `с языком «${value}»`}`,
  mostLanguages: (_facts, _query, value) => `больше всех языков — ${value}`,
  uniqueFormatCount: (_facts, _query, value) => `форматов: ${value}`,
  bestScore: (_facts, _query, value) => SCORE_PART_CHIPS[value],
  uniqueWord: (_facts, _query, value) => `только у него: ${value}`,
  rareWord: (_facts, _query, value) => `редкое в каталоге: ${value}`,
};

/** Tags may carry a value after ":" (`priceRank:2of3`); unknown tags are simply skipped. */
function differentiatorChip(tag, facts, query) {
  const separator = tag.indexOf(":");
  const name = separator === -1 ? tag : tag.slice(0, separator);
  const value = separator === -1 ? "" : tag.slice(separator + 1);
  return DIFFERENTIATOR_CHIPS[name]?.(facts, query, value);
}

/** 2–4 short strings for the card header. Price and hours are always available, so 2 is the floor. */
function factChips(facts, query) {
  const chips = [];
  if (facts.priceFrom !== null) {
    chips.push(`${formatMoney(facts.priceFrom)} — ${Math.round((facts.priceFrom / query.budget) * 100)}% бюджета`);
  }
  for (const tag of facts.differentiators) {
    const chip = differentiatorChip(tag, facts, query);
    if (chip) chips.push(chip);
  }
  if (facts.matchedKeywords.length > 0) {
    chips.push(`в описании: ${facts.matchedKeywords.slice(0, 2).join(", ")}`);
  }
  chips.push(facts.maxHours === null ? "без ограничения по часам" : `до ${facts.maxHours} ч`);

  return [...new Set(chips)].slice(0, 4);
}

function buildCard(entry, shown, query, contractors) {
  const { contractor, score, scoreParts, matchedKeywords } = entry;
  const headroomKzt = contractor.priceFrom === null ? null : query.budget - contractor.priceFrom;

  return {
    id: contractor.id,
    name: contractor.name,
    categories: contractor.categories,
    city: contractor.city,
    priceFrom: contractor.priceFrom,
    flags: contractor.flags,
    score,
    scoreParts,
    facts: {
      priceFrom: contractor.priceFrom,
      budget: query.budget,
      headroomKzt,
      headroomPct: headroomKzt === null ? null : Math.round((headroomKzt / query.budget) * 100),
      formats: contractor.formats,
      languages: contractor.languages,
      maxHours: contractor.maxHours,
      matchedKeywords,
      descriptionSnippet: descriptionSnippet(contractor.description, matchedKeywords),
      flags: contractor.flags,
      differentiators: allDifferentiators(entry, shown, contractors),
    },
  };
}

function withFactChips(card, query) {
  return { ...card, factChips: factChips(card.facts, query) };
}

// --- common facts ----------------------------------------------------------

/** What every shown card shares — the context the per-card differentiators are read against. */
// --- ranking rationale -----------------------------------------------------

const PART_LABELS = {
  relevance: "совпадение с описанием",
  budget: "запас бюджета",
  specialization: "специализация",
  hours: "часы",
  dataQuality: "качество данных",
};

const hoursLabel = (value) => (value === null ? "без лимита" : `до ${value} ч`);

const qualityLabel = (flags) => {
  if (flags.synthetic) return "синтетический профиль";
  if (flags.priceImputed && flags.cityImputed) return "город и цена восстановлены";
  if (flags.priceImputed) return "цена оценочная";
  if (flags.cityImputed) return "город уточнён";
  return "данные полные";
};

/** The concrete fact behind a score component, so the comparison is checkable. */
function partEvidence(part, ahead, behind) {
  if (part === "budget") {
    return `${formatMoney(ahead.priceFrom)} против ${formatMoney(behind.priceFrom)}`;
  }
  if (part === "relevance") {
    const found = ahead.facts.matchedKeywords;
    const other = behind.facts.matchedKeywords;
    return other.length === 0
      ? `упоминает ${found.map((word) => `«${word}»`).join(", ")}, у второй совпадений нет`
      : `совпадений ${found.length} против ${other.length}`;
  }
  if (part === "specialization") {
    const count = ahead.facts.formats.length;
    return `${count} ${plural(count, "формат", "формата")} против ${behind.facts.formats.length}`;
  }
  if (part === "hours") return `${hoursLabel(ahead.facts.maxHours)} против ${hoursLabel(behind.facts.maxHours)}`;
  return `${qualityLabel(ahead.flags)} против «${qualityLabel(behind.flags)}»`;
}

/**
 * Why each shown card is ranked above the next one, in plain Russian.
 * Positions instead of names, so the text stays usable with names hidden.
 */
function buildRankRationale(cards) {
  const rationale = [];

  for (let index = 1; index < cards.length; index += 1) {
    const ahead = cards[index - 1];
    const behind = cards[index];
    const scoreDelta = round4(ahead.score - behind.score);

    const contributions = Object.keys(WEIGHTS)
      .map((part) => ({ part, delta: round4((ahead.scoreParts[part] - behind.scoreParts[part]) * WEIGHTS[part]) }))
      .sort((a, b) => b.delta - a.delta || a.part.localeCompare(b.part));
    const decisive = contributions.find((item) => item.delta > 0);
    const equal = contributions.filter((item) => item.delta === 0).map((item) => item.part);

    let text;
    if (!decisive) {
      text = `№${index} и №${index + 1} набрали одинаковый балл ${ahead.score} — порядок определён по id.`;
    } else {
      const label = PART_LABELS[decisive.part];
      const values = `${ahead.scoreParts[decisive.part]} против ${behind.scoreParts[decisive.part]}`;
      const same = equal.length > 0 ? ` Совпали: ${equal.map((part) => PART_LABELS[part]).join(", ")}.` : "";
      text =
        `№${index} впереди №${index + 1} на ${scoreDelta}: ${label} — ` +
        `${partEvidence(decisive.part, ahead, behind)} (${values}).${same}`;
    }

    rationale.push({
      ahead: ahead.id,
      behind: behind.id,
      scoreDelta,
      decisivePart: decisive?.part ?? null,
      text,
    });
  }

  return rationale;
}

// --- common facts ----------------------------------------------------------

function buildCommonFacts(cards, query) {
  if (cards.length === 0) return [];
  const facts = [`все свободны ${formatDate(query.date)}`, `все работают с форматом «${query.eventType}»`];

  if (cards.every((card) => card.priceFrom !== null)) {
    facts.push(`все укладываются в бюджет ${formatMoney(query.budget)}`);
  }
  if (query.language) {
    facts.push(`все работают ${LANGUAGE_IN[query.language.toLowerCase()] ?? `на языке «${query.language}»`}`);
  }
  if (query.hours) facts.push(`все закрывают ${query.hours} ч`);

  const shared = cards[0].facts.languages.filter((language) =>
    cards.every((card) => card.facts.languages.includes(language)) && language !== query.language,
  );
  if (shared.length > 0) facts.push(`все говорят на: ${shared.join(", ")}`);
  if (cards.every((card) => !card.flags.synthetic)) facts.push("все профили реальные, не синтетические");

  return facts;
}

// --- excluded list ---------------------------------------------------------

const LANGUAGE_IN = { "казахский": "на казахском", "русский": "на русском", "английский": "на английском" };

const EXCLUSION_DETAIL = {
  busy: (contractor, query) => `занят ${formatDate(query.date)}`,
  over_budget: (contractor, query) =>
    `от ${formatMoney(contractor.priceFrom)} при бюджете ${formatMoney(query.budget)}`,
  format: (contractor, query) => `не берёт формат «${query.eventType}»`,
  language: (contractor, query) =>
    `не работает ${LANGUAGE_IN[query.language.toLowerCase()] ?? `на языке «${query.language}»`}`,
  hours: (contractor, query) => `до ${contractor.maxHours} ч при нужных ${query.hours}`,
};

/** Every excluded candidate with its single reason, ordered by reason then by id. */
function buildExcludedList(excluded, query) {
  return excluded
    .map(({ contractor, reason }) => ({
      id: contractor.id,
      name: contractor.name,
      reason,
      detail: EXCLUSION_DETAIL[reason](contractor, query),
    }))
    .sort(
      (a, b) =>
        FILTER_REASONS.indexOf(a.reason) - FILTER_REASONS.indexOf(b.reason) ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
}

// --- actions ---------------------------------------------------------------

/** Ready-to-send follow-up queries built from hints and otherCities. */
function buildActions(query, hints, otherCities) {
  const actions = [];
  if (hints.nearestFreeDate) {
    actions.push({
      label: `Показать на ${formatDate(hints.nearestFreeDate)}`,
      query: { ...query, date: hints.nearestFreeDate },
    });
  }
  if (hints.minBudgetNeeded !== undefined && hints.minBudgetNeeded > query.budget) {
    actions.push({
      label: `Показать с бюджетом от ${formatMoney(hints.minBudgetNeeded)}`,
      query: { ...query, budget: hints.minBudgetNeeded },
    });
  }
  for (const { city, count } of otherCities) {
    actions.push({ label: `Показать ${cityIn(city)} (${count})`, query: { ...query, city } });
  }
  return actions;
}

// --- hints -----------------------------------------------------------------

/** Closest date within +-14 days (and inside the calendar window) where at least one candidate fits. */
function nearestFreeDate(candidates, query) {
  for (let offset = 1; offset <= HINT_WINDOW_DAYS; offset += 1) {
    for (const shift of [-offset, offset]) {
      const date = toIso(toUtc(query.date) + shift * DAY_MS);
      if (!inWindow(date)) continue;
      if (candidates.some((contractor) => passesAll(contractor, { ...query, date }))) return date;
    }
  }
  return undefined;
}

/** Cheapest candidate that is free on the date and fits format / language / hours. */
function minBudgetNeeded(candidates, query) {
  const withoutBudget = { ...query, budget: undefined };
  const prices = candidates
    .filter((contractor) => contractor.priceFrom !== null && passesAll(contractor, withoutBudget))
    .map((contractor) => contractor.priceFrom);
  return prices.length > 0 ? Math.min(...prices) : undefined;
}

function buildHints(candidates, query) {
  const nearest = nearestFreeDate(candidates, query);
  const minBudget = minBudgetNeeded(candidates, query);
  return {
    ...(nearest === undefined ? {} : { nearestFreeDate: nearest }),
    ...(minBudget === undefined ? {} : { minBudgetNeeded: minBudget }),
  };
}

// --- messages --------------------------------------------------------------

function breakdown(excluded, query) {
  const counts = countExcluded(excluded);
  const phrases = {
    busy: (n) => `${n} ${plural(n, "занят", "заняты")} ${formatDate(query.date)}`,
    over_budget: (n) => `${n} дороже бюджета ${formatMoney(query.budget)}`,
    format: (n) => `${n} не ${plural(n, "работает", "работают")} с форматом «${query.eventType}»`,
    language: (n) => `${n} не ${plural(n, "работает", "работают")} на языке «${query.language}»`,
    hours: (n) => `${n} не ${plural(n, "закрывает", "закрывают")} ${query.hours} ч`,
  };
  return Object.entries(phrases)
    .filter(([reason]) => counts[reason] > 0)
    .map(([reason, phrase]) => phrase(counts[reason]))
    .join(", ");
}

function hintSentences(hints, query) {
  const sentences = [];
  if (hints.nearestFreeDate) {
    sentences.push(`Ближайшая подходящая дата — ${formatDate(hints.nearestFreeDate)}.`);
  }
  if (hints.minBudgetNeeded !== undefined && hints.minBudgetNeeded > query.budget) {
    sentences.push(`На эту дату минимальный бюджет — ${formatMoney(hints.minBudgetNeeded)}.`);
  }
  return sentences;
}

function buildMessage({ status, query, candidatesTotal, passedCount, excluded, otherCities, hints }) {
  const where = cityIn(query.city);
  const pool = `${candidatesTotal} ${plural(candidatesTotal, "подрядчика", "подрядчиков")} категории «${query.category}»`;

  if (status === "no_category") {
    const elsewhere =
      otherCities.length > 0
        ? ` ${otherCities.map((item) => `${capitalize(cityIn(item.city))} — ${item.count}`).join(", ")}.`
        : " В других городах её тоже нет.";
    return `${capitalize(where)} нет подрядчиков категории «${query.category}».${elsewhere}`;
  }

  if (status === "found") {
    const fits =
      passedCount > MAX_CARDS
        ? `подходят ${passedCount} — показываем ${MAX_CARDS} лучших`
        : `подходят ровно ${MAX_CARDS} — показываем всех`;
    return `Из ${pool} ${where} ${fits}.`;
  }

  if (status === "partial") {
    return (
      `Из ${pool} ${where} ${plural(passedCount, "подходит", "подходят")} только ${passedCount}: ` +
      `${breakdown(excluded, query)}.`
    );
  }

  return [
    `Из ${pool} ${where} не подходит ни один: ${breakdown(excluded, query)}.`,
    ...hintSentences(hints, query),
  ].join(" ");
}

// --- entry point -----------------------------------------------------------

/**
 * @param {Query} rawQuery
 * @param {{ contractors?: Contractor[] }} [options]
 * @returns {EngineResult}
 */
export function recommend(rawQuery, options = {}) {
  const contractors = options.contractors ?? getContractors();
  const query = normalizeQuery(rawQuery, catalogueFacets(contractors));

  const inCategory = contractors.filter((contractor) =>
    contractor.categories.some((category) => category.toLowerCase() === query.category.toLowerCase()),
  );
  const candidates = inCategory.filter((contractor) => contractor.city === query.city);

  if (candidates.length === 0) {
    const counts = new Map();
    for (const contractor of inCategory) {
      counts.set(contractor.city, (counts.get(contractor.city) ?? 0) + 1);
    }
    const otherCities = [...counts.entries()]
      .map(([city, count]) => ({ city, count }))
      .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city, "ru"));

    return {
      status: "no_category",
      query,
      candidatesTotal: 0,
      excluded: countExcluded([]),
      excludedList: [],
      cards: [],
      commonFacts: [],
      rankRationale: [],
      otherCities,
      hints: {},
      actions: buildActions(query, {}, otherCities),
      message: buildMessage({ status: "no_category", query, candidatesTotal: 0, otherCities }),
    };
  }

  const { passed, excluded } = applyFilters(candidates, query);
  const shown = scoreCandidates(passed, query).slice(0, MAX_CARDS);
  const status = shown.length >= MAX_CARDS ? "found" : shown.length > 0 ? "partial" : "all_filtered";
  const hints = status === "found" ? {} : buildHints(candidates, query);

  const cards = shown.map((entry) => withFactChips(buildCard(entry, shown, query, contractors), query));

  return {
    status,
    query,
    candidatesTotal: candidates.length,
    excluded: countExcluded(excluded),
    excludedList: buildExcludedList(excluded, query),
    cards,
    commonFacts: buildCommonFacts(cards, query),
    rankRationale: buildRankRationale(cards),
    otherCities: [],
    hints,
    actions: buildActions(query, hints, []),
    message: buildMessage({
      status,
      query,
      candidatesTotal: candidates.length,
      passedCount: passed.length,
      excluded,
      otherCities: [],
      hints,
    }),
  };
}
