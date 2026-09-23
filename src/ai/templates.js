const moneyFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

export const formatMoney = (value) => moneyFormatter.format(value).replace(/\u00a0/g, " ");
export const forbiddenPhrase = /отличный выбор|идеальн(?:ый выбор|о подойд[её]т)|прекрасно подойд[её]т|профессионал своего дела/iu;

function snippetFrom(facts) {
  let text = String(facts.descriptionSnippet ?? "").replace(/\s+/g, " ").trim();
  if (!text || forbiddenPhrase.test(text)) return "";
  // The engine may supply a window starting/ending in the middle of a word.
  if (text.startsWith("…")) text = text.replace(/^…\S*\s*/, "");
  if (text.endsWith("…")) text = text.replace(/\s+\S*…$/, "…");
  const keyword = (facts.matchedKeywords ?? []).find((stem) => text.toLowerCase().includes(stem));
  if (keyword) {
    const index = text.toLowerCase().indexOf(keyword);
    const start = Math.max(text.lastIndexOf(",", index), text.lastIndexOf(";", index)) + 1;
    const suffix = text.slice(start).trim();
    const clauses = suffix.split(/[,;]|[.!?](?=\s|$)/u).map((part) => part.trim()).filter(Boolean);
    text = clauses[0] ?? suffix;
    if (text.length < 25 && clauses[1]) text += `, ${clauses[1]}`;
  }
  text = text.split(/(?<=[.!?])\s+(?=[А-ЯЁA-Z])/u)[0].replace(/[.!?]+$/, "");
  if (/^(привет|здравствуй|добрый день|добро пожаловать|меня зовут)/iu.test(text)) return "";
  return text.replace(/[«»]/g, '"');
}

export function explanationEvidence(facts, query) {
  const tags = new Set(facts.differentiators ?? []);
  const differences = [
    ["onlyKazakh", "среди показанных только этот профиль указывает казахский язык"],
    ["mostHours", `самый большой лимит присутствия среди показанных: ${facts.maxHours} ч`],
    ["mostSpecialized", `самая узкая специализация среди показанных: форматов ${facts.formats.length}`],
    ["cheapest", "самая низкая начальная цена среди показанных"],
    ["noHourLimit", "работа не привязана к часам присутствия на площадке"],
    ["onlyMentionsEventType", `только у этого профиля среди показанных найдены ключевые слова формата «${query.eventType}»`],
  ];
  const differentiator = differences.find(([tag]) => tags.has(tag))?.[1] ?? "";
  const snippet = snippetFrom(facts);
  const hours = facts.maxHours === null ? "работа не привязана к часам присутствия" : `лимит присутствия ${facts.maxHours} ч`;
  const detail = snippet ? `в описании: «${snippet}»` : `языки: ${facts.languages.join(", ")}; ${hours}`;
  return { differentiator, detail };
}

export function templateExplanation(facts, query) {
  const date = query.date.split("-").reverse().join(".");
  const prefix = facts.flags.synthetic ? "Синтетический профиль; " : "";
  const price = Number.isFinite(facts.priceFrom)
    ? `${facts.flags.priceImputed ? "оценочная цена" : "цена"} от ${formatMoney(facts.priceFrom)} ₸`
    : "цена не указана, соответствие бюджету нужно уточнить";
  const details = [`свободен по календарю на ${date}`, `формат «${query.eventType}»`, price];
  if (Number.isFinite(facts.headroomKzt)) details.push(`остаток бюджета ${formatMoney(facts.headroomKzt)} ₸`);
  if (query.language) details.push(`язык: ${query.language}`);
  if (query.hours) {
    details.push(facts.maxHours === null ? "работа не привязана к часам присутствия" : `лимит ${facts.maxHours} ч при запросе ${query.hours} ч`);
  }
  const { differentiator, detail } = explanationEvidence(facts, query);
  const sentences = [prefix + details.join(", "), [differentiator, detail].filter(Boolean).join("; ")];
  return sentences.map((text) => text.charAt(0).toUpperCase() + text.slice(1) + ".").join(" ");
}

export function templateExplanations(result) {
  return Object.fromEntries(result.cards.map(({ id, facts }) => [id, templateExplanation(facts, result.query)]));
}
