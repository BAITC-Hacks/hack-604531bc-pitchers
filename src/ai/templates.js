const moneyFormatter = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });

export const formatMoney = (value) => moneyFormatter.format(value).replace(/\u00a0/g, " ");
export const forbiddenPhrase = /отличный выбор|идеальн(?:ый выбор|о подойд[её]т)|прекрасно подойд[её]т|профессионал своего дела/iu;
export const normalizeText = (text) => text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/\s+/g, " ").trim();

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

export function profileWitnesses(facts) {
  const result = [];
  if (Number.isFinite(facts.maxHours)) {
    result.push({ kind: "number", field: "maxHours", value: facts.maxHours, phrase: `лимит присутствия ${facts.maxHours} ч` });
  }
  const snippet = snippetFrom(facts);
  if (snippet) result.push({ kind: "quote", value: snippet, phrase: `в описании: «${snippet}»` });
  if (Number.isFinite(facts.priceFrom)) {
    result.push({ kind: "number", field: "priceFrom", value: facts.priceFrom,
      phrase: `${facts.flags.priceImputed ? "оценочная цена" : "цена"} от ${formatMoney(facts.priceFrom)} ₸` });
  }
  return result;
}

export function differsFrom(witness, facts) {
  return witness.kind === "quote"
    ? !normalizeText(String(facts.descriptionSnippet ?? "")).includes(normalizeText(witness.value))
    : facts[witness.field] !== witness.value;
}

export function cardEvidence(result) {
  return Object.fromEntries(result.cards.map((card) => {
    const peers = result.cards.filter((other) => other.id !== card.id);
    const available = profileWitnesses(card.facts);
    const witnesses = [];
    for (const peer of peers) {
      if (witnesses.some((witness) => differsFrom(witness, peer.facts))) continue;
      const witness = available.find((item) => differsFrom(item, peer.facts));
      if (witness) witnesses.push(witness);
    }
    const base = explanationEvidence(card.facts, result.query);
    const differentiator = base.differentiator || witnesses[0]?.phrase || (peers.length
      ? "различия по имеющимся фактам не подтверждены" : available[0]?.phrase || base.detail);
    const details = [base.detail];
    for (const witness of witnesses) {
      if (!normalizeText(differentiator + details.join("; ")).includes(normalizeText(witness.phrase))) {
        details.push(witness.phrase);
      }
    }
    return [card.id, { differentiator, detail: details.join("; "), witnesses,
      distinguishable: peers.every((peer) => witnesses.some((witness) => differsFrom(witness, peer.facts))) }];
  }));
}

export function commonFacts(result) {
  if (!result.cards.length) return null;
  const { city, date, eventType, language, hours } = result.query;
  const parts = [city, `свободны по календарю на ${date.split("-").reverse().join(".")}`, `формат «${eventType}»`];
  if (language) parts.push(`язык: ${language}`);
  if (hours) parts.push(`подходят для запроса на ${hours} ч`);
  return { city, date, eventType, ...(language ? { language } : {}), ...(hours ? { hours } : {}), text: parts.join("; ") + "." };
}

export function templateExplanation(facts, query, evidence = explanationEvidence(facts, query)) {
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
  const { differentiator, detail } = evidence;
  const sentences = [prefix + details.join(", "), [differentiator, detail].filter(Boolean).join("; ")];
  return sentences.map((text) => text.charAt(0).toUpperCase() + text.slice(1) + ".").join(" ");
}

export function templateExplanations(result) {
  const evidence = cardEvidence(result);
  return Object.fromEntries(result.cards.map(({ id, facts }) => [id, templateExplanation(facts, result.query, evidence[id])]));
}
