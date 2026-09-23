"use strict";

const form = document.querySelector("#search-form");
const parseForm = document.querySelector("#parse-form");
const results = document.querySelector("#results");
const fields = document.querySelector("#query-fields");
const parseFeedback = document.querySelector("#parse-feedback");
const metaFeedback = document.querySelector("#meta-feedback");
const retryMeta = document.querySelector("#retry-meta");
const demos = [
  { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 },
  { city: "Алматы", date: "2026-10-17", eventType: "свадьба", category: "Флорист", budget: 500000 },
  { city: "Астана", date: "2026-10-17", eventType: "свадьба", category: "Декоратор", budget: 1000000 },
];
const statuses = { found: "Найдены подходящие варианты", partial: "Есть несколько вариантов", no_category: "Категории пока нет в городе", all_filtered: "Нужно изменить параметры" };
const reasons = { busy: "Заняты на эту дату", over_budget: "Выше бюджета", format: "Другой формат мероприятия", language: "Не подходит язык", hours: "Не подходит длительность" };
const money = (value) => `${new Intl.NumberFormat("ru-RU").format(value)} ₸`;
const dateLabel = (value) => String(value).split("-").reverse().join(".");
let activeActions = [];
let lastQuery = null;
let busy = false;
let ready = false;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function request(path, body) {
  let response;
  try {
    response = await fetch(path, { signal: AbortSignal.timeout(30000), ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) });
  } catch {
    throw new Error("Сервер не отвечает. Проверьте соединение и попробуйте ещё раз.");
  }
  let data;
  try { data = await response.json(); } catch { throw new Error("Сервер вернул непонятный ответ. Попробуйте ещё раз."); }
  if (!response.ok) {
    const prefix = response.status === 400 ? "Проверьте параметры. " : response.status === 503 ? "Сервис временно недоступен. Можно заполнить форму вручную. " : "";
    throw new Error(prefix + (data.error || "Не удалось выполнить запрос. Попробуйте ещё раз."));
  }
  return data;
}

function setBusy(value) {
  busy = value;
  fields.disabled = !ready || value;
  parseForm.querySelector("button").disabled = !ready || value;
  document.querySelectorAll("[data-demo], [data-action], [data-retry]").forEach((button) => { button.disabled = !ready || value; });
  document.querySelector("#search-button").firstChild.textContent = value ? "Подбираем… " : "Подобрать подрядчиков ";
}

function readQuery() {
  const query = {};
  for (const name of ["city", "date", "eventType", "category", "budget", "hours", "language"]) {
    const value = form.elements.namedItem(name).value;
    if (value !== "") query[name] = ["budget", "hours"].includes(name) ? Number(value) : value;
  }
  return query;
}

function fillForm(query, clear = false) {
  for (const name of ["city", "date", "eventType", "category", "budget", "hours", "language"]) {
    if (clear || query[name] !== undefined) form.elements.namedItem(name).value = query[name] ?? "";
  }
}

async function loadMeta() {
  retryMeta.hidden = true;
  metaFeedback.hidden = false;
  metaFeedback.textContent = "Загружаем каталог…";
  try {
    const meta = await request("/api/meta");
    for (const [name, key] of [["city", "cities"], ["category", "categories"], ["eventType", "eventTypes"], ["language", "languages"]]) {
      if (!Array.isArray(meta[key])) throw new Error("Каталог недоступен. Попробуйте загрузить его ещё раз.");
      const select = form.elements.namedItem(name);
      select.replaceChildren(new Option(name === "language" ? "Любой" : "Выберите…", ""));
      meta[key].forEach((value) => select.add(new Option(value, value)));
    }
    form.elements.date.min = meta.dateRange?.min || "2026-09-23";
    form.elements.date.max = meta.dateRange?.max || "2026-12-31";
    fillForm(demos[0], true);
    ready = true;
    metaFeedback.hidden = true;
  } catch (error) {
    metaFeedback.textContent = error.message;
    retryMeta.hidden = false;
  } finally { setBusy(false); }
}

function loading() {
  results.setAttribute("aria-busy", "true");
  results.replaceChildren(element("p", "loading-label", "Сравниваем подрядчиков и готовим объяснения…"));
  const cards = element("div", "cards");
  cards.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index++) {
    const card = element("div", "card skeleton-card");
    card.append(element("div", "skeleton-line short"), element("div", "skeleton-line medium"));
    const copy = element("div", "skeleton-copy");
    copy.append(element("div", "skeleton-line"), element("div", "skeleton-line"), element("div", "skeleton-line medium"));
    card.append(copy);
    cards.append(card);
  }
  results.append(cards);
}

function nameNode(name, index) {
  const node = element("span");
  node.append(element("span", "real-name", name), element("span", "anonymous", `Подрядчик ${index + 1}`));
  return node;
}

function renderCard(card, index) {
  const article = element("article", "card");
  const top = element("div", "card-top");
  const heading = element("h3", "card-name");
  heading.append(nameNode(card.name, index));
  const badges = element("div", "badges");
  const flags = card.flags || card.facts?.flags || {};
  for (const [key, label] of [["synthetic", "Синтетический профиль"], ["priceImputed", "Оценочная цена"], ["cityImputed", "Город уточнён"]]) {
    if (flags[key]) badges.append(element("span", "badge", label));
  }
  top.append(heading, badges);
  const meta = element("div", "card-meta");
  meta.append(element("span", "", `${(card.categories || []).join(", ")} · ${card.city}`), element("span", "price", Number.isFinite(card.priceFrom) ? `от ${money(card.priceFrom)}` : "Цена не указана"));
  const chips = element("div", "chips");
  (card.factChips || []).forEach((chip) => chips.append(element("span", "", chip)));
  const explanation = element("p", "explanation", card.explanation || "Объяснение пока недоступно. Сравните условия подрядчика ниже.");
  // Explanations can mention a name too; anonymize it with the same toggle.
  if (card.name && card.explanation?.includes(card.name)) {
    explanation.replaceChildren();
    const parts = card.explanation.split(card.name);
    parts.forEach((part, partIndex) => { if (partIndex) explanation.append(nameNode(card.name, index)); explanation.append(document.createTextNode(part)); });
  }
  article.append(top, meta, explanation, chips);
  if (Number.isFinite(card.score)) article.append(element("p", "score", `Оценка соответствия: ${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(card.score * 100)} из 100`));
  return article;
}

function renderResult(data) {
  if (!statuses[data.status] || !Array.isArray(data.cards)) throw new Error("Не удалось прочитать результат подбора. Попробуйте ещё раз.");
  const summary = element("div", "summary");
  const top = element("div", "summary-top");
  top.append(element("span", `status status-${data.status}`, statuses[data.status]));
  if (Number.isFinite(data.elapsedMs)) top.append(element("span", "timing", `${(data.elapsedMs / 1000).toFixed(1)} с`));
  summary.append(top, element("p", "", data.message || statuses[data.status]));
  results.replaceChildren(summary);
  if (data.cards.length) {
    const cards = element("div", "cards");
    data.cards.forEach((card, index) => cards.append(renderCard(card, index)));
    results.append(cards);
  } else {
    const empty = element("div", "empty-state");
    const symbol = element("div", "empty-symbol", "⌕");
    symbol.setAttribute("aria-hidden", "true");
    empty.append(symbol, element("h3", "", data.status === "no_category" ? "Поищем в другом городе?" : "Попробуем другие условия?"), element("p", "", data.status === "no_category" ? "В этом городе пока нет нужной категории. Можно рассмотреть подрядчиков из других городов." : "Подрядчики есть, но сейчас никто не соответствует всем параметрам. Измените дату, бюджет или другие условия."));
    results.append(empty);
  }
  const hints = element("div", "hints");
  if (data.hints?.nearestFreeDate) hints.append(element("p", "", `Ближайшая свободная дата: ${dateLabel(data.hints.nearestFreeDate)}`));
  if (Number.isFinite(data.hints?.minBudgetNeeded)) hints.append(element("p", "", `Минимальный бюджет: ${money(data.hints.minBudgetNeeded)}`));
  (data.otherCities || []).forEach((item) => hints.append(element("p", "", `${item.city}: ${item.count} в каталоге`)));
  if (hints.childElementCount) results.append(hints);
  activeActions = data.actions || [];
  const actions = element("div", "actions");
  activeActions.forEach((action, index) => { const button = element("button", "secondary", action.label); button.type = "button"; button.dataset.action = index; actions.append(button); });
  if (actions.childElementCount) results.append(actions);
  const excluded = data.excludedList || [];
  const counts = data.excluded || {};
  const total = excluded.length || Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
  if (total) {
    const details = element("details", "exclusions");
    details.append(element("summary", "", `Почему не попали · ${total}`));
    for (const [reason, label] of Object.entries(reasons)) {
      const items = excluded.filter((item) => item.reason === reason);
      const count = items.length || counts[reason];
      if (!count) continue;
      const group = element("section", "reason-group");
      group.append(element("h3", "", `${label} · ${count}`));
      const list = element("ul");
      items.forEach((item) => { const line = element("li"); line.append(nameNode(item.name, excluded.indexOf(item)), document.createTextNode(` — ${item.detail || label}`)); list.append(line); });
      group.append(list);
      details.append(group);
    }
    results.append(details);
  }
}

async function search(query) {
  if (busy) return;
  lastQuery = structuredClone(query);
  setBusy(true);
  loading();
  try { renderResult(await request("/api/recommend", query)); }
  catch (error) {
    const panel = element("div", "error-panel");
    panel.setAttribute("role", "alert");
    panel.append(element("h3", "", "Не удалось завершить подбор"), element("p", "", error.message));
    const retry = element("button", "secondary", "Попробовать ещё раз");
    retry.type = "button";
    retry.dataset.retry = "true";
    panel.append(retry);
    results.replaceChildren(panel);
  } finally { results.setAttribute("aria-busy", "false"); setBusy(false); }
}

form.addEventListener("submit", (event) => { event.preventDefault(); parseFeedback.hidden = true; search(readQuery()); });
parseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const partialQuery = readQuery();
  setBusy(true);
  parseFeedback.hidden = false;
  parseFeedback.textContent = "Разбираем описание мероприятия…";
  try {
    const data = await request("/api/parse", { text: document.querySelector("#free-text").value.trim(), partialQuery });
    if (!data.query || typeof data.query !== "object") throw new Error("Не удалось разобрать описание. Заполните форму вручную.");
    fillForm(data.query);
    parseFeedback.textContent = data.question || "Параметры заполнены. Проверьте их и запустите подбор.";
  } catch (error) { parseFeedback.textContent = error.message; }
  finally { setBusy(false); }
});
document.querySelectorAll("[data-demo]").forEach((button) => button.addEventListener("click", () => {
  const query = demos[Number(button.dataset.demo)];
  fillForm(query, true);
  parseFeedback.hidden = true;
  search(query);
}));
results.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (action && !busy) { const query = activeActions[Number(action.dataset.action)].query; fillForm(query, true); search(query); }
  if (event.target.closest("[data-retry]") && lastQuery) search(lastQuery);
});
document.querySelector("#hide-names").addEventListener("change", (event) => document.body.classList.toggle("names-hidden", event.target.checked));
retryMeta.addEventListener("click", loadMeta);
loadMeta();
