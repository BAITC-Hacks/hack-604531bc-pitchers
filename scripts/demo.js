/**
 * Demo queries for the jury plus a determinism check:
 * every query runs twice and the order of card ids must match.
 */
import { recommend, ValidationError } from "../src/engine/recommend.js";

const QUERIES = [
  { title: "Плотная категория", city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 },
  { title: "Та же категория в пик сезона", city: "Алматы", date: "2026-12-26", eventType: "корпоратив", category: "Ведущий", budget: 1500000 },
  { title: "Редкая категория", city: "Алматы", date: "2026-10-17", eventType: "свадьба", category: "Флорист", budget: 500000 },
  { title: "Большой бюджет", city: "Алматы", date: "2026-12-19", eventType: "корпоратив", category: "Банкетный зал", budget: 3000000 },
  { title: "Категории нет в городе", city: "Астана", date: "2026-10-17", eventType: "свадьба", category: "Декоратор", budget: 1000000 },
];

const formatMoney = (value) =>
  value === null ? "цена не указана" : `от ${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ")} ₸`;

const describe = (query) =>
  `${query.category}, ${query.city}, ${query.eventType}, ${query.date}, бюджет ${formatMoney(query.budget).slice(3)}`;

const mismatches = [];

for (const [index, { title, ...query }] of QUERIES.entries()) {
  console.log(`\n${index + 1}) ${title} — ${describe(query)}`);

  let first;
  let second;
  try {
    first = recommend(query);
    second = recommend(query);
  } catch (error) {
    if (!(error instanceof ValidationError)) throw error;
    console.log(`   Ошибка запроса: ${error.message}`);
    mismatches.push(`${index + 1}) ${title}: ${error.message}`);
    continue;
  }

  console.log(`   status:  ${first.status}`);
  console.log(`   message: ${first.message}`);
  if (first.cards.length === 0) {
    console.log("   карточек нет");
  }
  for (const card of first.cards) {
    console.log(`   - ${card.name} (${card.id}), ${formatMoney(card.priceFrom)}, score ${card.score}`);
  }

  const firstIds = first.cards.map((card) => card.id);
  const secondIds = second.cards.map((card) => card.id);
  if (firstIds.join(",") !== secondIds.join(",")) {
    mismatches.push(`${index + 1}) ${title}: [${firstIds.join(", ")}] != [${secondIds.join(", ")}]`);
  }
}

console.log("");
if (mismatches.length === 0) {
  console.log("Детерминизм: OK");
} else {
  console.log("Детерминизм: расхождения");
  for (const line of mismatches) console.log(`  - ${line}`);
  process.exitCode = 1;
}
