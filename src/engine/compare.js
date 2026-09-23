/**
 * Side-by-side comparison of the same query on two dates.
 * Deterministic: it only re-runs recommend() and diffs the two card lists.
 */
import { ValidationError, recommend } from "./recommend.js";

const formatDate = (date) => date.split("-").reverse().join(".");

/** Russian needs three forms: 1 подрядчик, 2 подрядчика, 5 подрядчиков. */
function pluralize(count, one, few, many) {
  const mod100 = count % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = count % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Why a card present on the first date is gone on the second one. */
function dropReason(card, second) {
  const excluded = second.excludedList.find((item) => item.id === card.id);
  if (excluded) return excluded.detail;
  return "не вошёл в топ-3";
}

function buildMessage(second, droppedOut, newcomers) {
  const date = formatDate(second.query.date);
  if (droppedOut.length === 0 && newcomers.length === 0) {
    return `На ${date} выдача не изменилась.`;
  }

  const parts = [];
  if (droppedOut.length > 0) {
    const verb = pluralize(droppedOut.length, "выпал", "выпали", "выпали");
    const noun = pluralize(droppedOut.length, "подрядчик", "подрядчика", "подрядчиков");
    const who = droppedOut.map((item) => `${item.name} — ${item.detail}`).join(", ");
    parts.push(`На ${date} из выдачи ${verb} ${droppedOut.length} ${noun}: ${who}`);
  }
  if (newcomers.length > 0) {
    const verb = pluralize(newcomers.length, "добавился", "добавились", "добавились");
    const who = newcomers.map((item) => item.name).join(", ");
    parts.push(droppedOut.length > 0 ? `${verb}: ${who}` : `На ${date} ${verb}: ${who}`);
  }
  return `${parts.join("; ")}.`;
}

/**
 * @param {Query} query the first date is taken from query.date
 * @param {string} date2 the second date, validated by recommend()
 * @returns {{ a: EngineResult, b: EngineResult, diff: object, message: string }}
 */
export function compareDates(query, date2) {
  const second = String(date2 ?? "").trim();
  if (!second) throw new ValidationError("Не заполнено поле «вторая дата».");

  const a = recommend(query);
  const b = recommend({ ...a.query, date: second });

  const inB = new Set(b.cards.map((card) => card.id));
  const inA = new Set(a.cards.map((card) => card.id));

  const droppedOut = a.cards
    .filter((card) => !inB.has(card.id))
    .map((card) => ({ id: card.id, name: card.name, detail: dropReason(card, b) }));
  const newcomers = b.cards.filter((card) => !inA.has(card.id)).map((card) => ({ id: card.id, name: card.name }));

  return { a, b, diff: { droppedOut, newcomers }, message: buildMessage(b, droppedOut, newcomers) };
}

export default compareDates;
