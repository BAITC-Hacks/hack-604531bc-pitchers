"use strict";

const form = document.querySelector("#search-form");
const parseForm = document.querySelector("#parse-form");
const results = document.querySelector("#results");
const fields = document.querySelector("#query-fields");
const parseFeedback = document.querySelector("#parse-feedback");
const formFeedback = document.querySelector("#form-feedback");
const metaFeedback = document.querySelector("#meta-feedback");
const retryMeta = document.querySelector("#retry-meta");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const queryFields = ["city", "date", "eventType", "category", "budget", "hours", "language"];
const demos = [
  {
    city: "Алматы",
    date: "2026-10-17",
    eventType: "корпоратив",
    category: "Ведущий",
    budget: 1500000,
  },
  { city: "Алматы", date: "2026-10-17", eventType: "свадьба", category: "Флорист", budget: 500000 },
  {
    city: "Астана",
    date: "2026-10-17",
    eventType: "свадьба",
    category: "Декоратор",
    budget: 1000000,
  },
];
const statuses = {
  found: { label: "Подрядчики найдены", icon: "circle-check" },
  partial: { label: "Есть несколько вариантов", icon: "circle-alert" },
  no_category: { label: "В городе нет этой категории", icon: "map-pin" },
  all_filtered: { label: "Нужно изменить условия", icon: "list-filter" },
};
const reasons = {
  busy: "Заняты на эту дату",
  over_budget: "Выше бюджета",
  format: "Другой формат",
  language: "Не подходит язык",
  hours: "Не подходит длительность",
};
const scoreParts = [
  ["relevance", "Смысл описания", 35],
  ["budget", "Бюджет", 25],
  ["specialization", "Специализация", 15],
  ["hours", "Часы", 15],
  ["dataQuality", "Качество данных", 10],
];
const money = (value) => `${new Intl.NumberFormat("ru-RU").format(value)} ₸`;
const dateLabel = (value) => String(value).split("-").reverse().join(".");
let activeActions = [];
let lastQuery = null;
let busy = false;
let ready = false;
let identities = [];
let namePattern = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#icon-${name}`);
  svg.append(use);
  return svg;
}

function notice(node, text = "", tone = "info") {
  node.querySelector(".notice").textContent = text;
  node.classList.toggle("is-visible", Boolean(text));
  node.dataset.tone = tone;
  node.setAttribute("aria-hidden", String(!text));
}

async function request(path, body) {
  let response;
  try {
    response = await fetch(path, {
      signal: AbortSignal.timeout(30000),
      ...(body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  } catch {
    throw new Error("Сервер не отвечает. Проверьте соединение и попробуйте ещё раз.");
  }
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error("Не удалось прочитать ответ сервера. Попробуйте ещё раз.");
  }
  if (!response.ok) {
    const error = new Error(data.error || "Не удалось выполнить запрос. Попробуйте ещё раз.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function setBusy(value, operation = "search") {
  busy = value;
  fields.disabled = !ready || value;
  document.querySelector("#search-button").disabled = !ready || value;
  parseForm.querySelector("button").disabled = !ready || value;
  document.querySelector("#free-text").disabled = value;
  parseForm.setAttribute("aria-busy", String(value && operation === "parse"));
  document.querySelectorAll("[data-demo], [data-action], [data-retry]").forEach((button) => {
    button.disabled = !ready || value;
  });
  document.querySelector("#search-button-label").textContent =
    value && operation === "search" ? "Подбираем подрядчиков…" : "Найти подрядчиков";
  document.querySelector("#parse-button-label").textContent =
    value && operation === "parse" ? "Разбираем описание…" : "Подобрать";
}

function readQuery() {
  const query = {};
  for (const name of queryFields) {
    const value = form.elements.namedItem(name).value;
    if (value !== "") query[name] = ["budget", "hours"].includes(name) ? Number(value) : value;
  }
  return query;
}

function refreshQuery() {
  const query = readQuery();
  document.querySelectorAll("[data-demo]").forEach((button) => {
    const demo = demos[Number(button.dataset.demo)];
    button.setAttribute(
      "aria-pressed",
      String(queryFields.every((key) => (query[key] ?? "") === (demo[key] ?? ""))),
    );
  });
  const preview = {
    city: query.city || "Выберите город",
    category: query.category || "Выберите категорию",
    date: query.date ? dateLabel(query.date) : "Укажите дату",
    budget: query.budget ? money(query.budget) : "Укажите бюджет",
  };
  for (const [name, value] of Object.entries(preview)) {
    const node = document.querySelector(`#preview-${name}`);
    if (node) node.textContent = value;
  }
}

function fillForm(query, clear = false, highlight = false) {
  for (const name of queryFields) {
    if (!clear && query[name] === undefined) continue;
    const input = form.elements.namedItem(name);
    const next = String(query[name] ?? "");
    if (highlight && input.value !== next && !reduceMotion.matches) {
      input.closest(".field").classList.add("field-updated");
    }
    input.value = next;
  }
  refreshQuery();
}

async function loadMeta() {
  retryMeta.hidden = true;
  notice(metaFeedback, "Загружаем каталог…");
  try {
    const meta = await request("/api/meta");
    for (const [name, key] of [
      ["city", "cities"],
      ["category", "categories"],
      ["eventType", "eventTypes"],
      ["language", "languages"],
    ]) {
      if (!Array.isArray(meta[key]))
        throw new Error("Каталог недоступен. Попробуйте загрузить его ещё раз.");
      const select = form.elements.namedItem(name);
      select.replaceChildren(new Option(name === "language" ? "Любой" : "Выберите…", ""));
      meta[key].forEach((value) => select.add(new Option(value, value)));
    }
    form.elements.date.min = meta.dateRange?.min || "2026-09-23";
    form.elements.date.max = meta.dateRange?.max || "2026-12-31";
    fillForm(demos[0], true);
    ready = true;
    notice(metaFeedback);
  } catch (error) {
    notice(metaFeedback, error.message, "error");
    retryMeta.hidden = false;
  } finally {
    setBusy(false);
  }
}

function loading() {
  activeActions = [];
  results.setAttribute("aria-busy", "true");
  const label = element("p", "loading-label", "Сравниваем условия и готовим подборку…");
  label.prepend(icon("list-filter"));
  const cards = element("div", "cards");
  cards.setAttribute("aria-hidden", "true");
  for (let index = 0; index < 3; index++) {
    const card = element("div", "card skeleton-card");
    const top = element("div", "skeleton-top");
    const title = element("div", "skeleton-title");
    title.append(element("div", "skeleton-line short"), element("div", "skeleton-line medium"));
    top.append(element("div", "skeleton-avatar"), title);
    const copy = element("div", "skeleton-copy");
    copy.append(
      element("div", "skeleton-line"),
      element("div", "skeleton-line"),
      element("div", "skeleton-line medium"),
    );
    card.append(top, copy, element("div", "skeleton-line medium"));
    cards.append(card);
  }
  results.replaceChildren(label, cards);
}

function nameNode(name, index, avatar = false) {
  const node = element("span");
  const real = avatar
    ? String(name)
        .trim()
        .split(/\s+/u)
        .slice(0, 2)
        .map((part) => [...part][0])
        .join("")
        .toLocaleUpperCase("ru")
    : name;
  node.append(
    element("span", "real-name", real),
    element(
      "span",
      "anonymous",
      avatar ? String(index + 1).padStart(2, "0") : `Подрядчик ${index + 1}`,
    ),
  );
  return node;
}

function preparePrivacy(data) {
  const unique = new Map();
  [...data.cards, ...(data.excludedList || [])].forEach((item) => {
    if (item.name && !unique.has(item.id || item.name))
      unique.set(item.id || item.name, { name: item.name, index: unique.size });
  });
  identities = [...unique.values()];
  const names = [...new Set(identities.map((item) => item.name))].sort(
    (a, b) => b.length - a.length,
  );
  namePattern = names.length
    ? new RegExp(names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu")
    : null;
}

// Keep real and anonymous text in the same render; the global switch cannot flash names.
function privateText(value) {
  const fragment = document.createDocumentFragment();
  const text = String(value ?? "");
  let offset = 0;
  if (namePattern) {
    for (const match of text.matchAll(namePattern)) {
      fragment.append(document.createTextNode(text.slice(offset, match.index)));
      const person = identities.find(
        (item) => item.name.toLocaleLowerCase("ru") === match[0].toLocaleLowerCase("ru"),
      );
      fragment.append(nameNode(match[0], person.index));
      offset = match.index + match[0].length;
    }
  }
  fragment.append(document.createTextNode(text.slice(offset)));
  return fragment;
}

function renderCard(card, index) {
  const article = element("article", "card result-card");
  article.style.setProperty("--card-index", index);
  const top = element("div", "card-top");
  const avatar = element("div", "avatar");
  avatar.setAttribute("aria-hidden", "true");
  avatar.append(nameNode(card.name || "?", index, true));
  const identity = element("div", "identity");
  const headingRow = element("div", "identity-heading");
  const heading = element("h3", "card-name");
  heading.append(nameNode(card.name || "Без имени", index));
  const badges = element("div", "badges");
  const flags = card.flags || card.facts?.flags || {};
  for (const [key, label] of [
    ["synthetic", "Синтетический профиль"],
    ["priceImputed", "Оценочная цена"],
    ["cityImputed", "Город уточнён"],
  ]) {
    if (!flags[key]) continue;
    const badge = element("span", `badge${key === "synthetic" ? " badge-synthetic" : ""}`, label);
    badge.prepend(icon("badge-info"));
    badges.append(badge);
  }
  headingRow.append(heading, badges);
  const meta = element("div", "card-meta");
  const city = element("span", "city", card.city);
  city.prepend(icon("map-pin"));
  meta.append(element("span", "", (card.categories || []).join(", ")), city);
  identity.append(headingRow, meta);
  const price = element("div", "card-price");
  price.append(
    element(
      "span",
      "price",
      Number.isFinite(card.priceFrom) ? `от ${money(card.priceFrom)}` : "Цена не указана",
    ),
    element("span", "price-caption", "за мероприятие"),
  );
  top.append(avatar, identity, price);
  const explanation = element("p", "explanation");
  explanation.append(
    privateText(
      card.explanation || "Объяснение пока недоступно. Сравните условия подрядчика ниже.",
    ),
  );
  const chips = element("div", "chips");
  (card.factChips || []).forEach((value) => {
    const chip = element("span", "chip");
    chip.append(privateText(value));
    chips.append(chip);
  });
  const scoreDetails = element("details", "score-details");
  const scoreSummary = element("summary", "", "Как посчитан рейтинг");
  const scoreGrid = element("div", "score-grid");
  scoreParts.forEach(([key, label, weight]) => {
    const value = Math.max(0, Math.min(1, Number(card.scoreParts?.[key]) || 0));
    const row = element("div", "score-row");
    const heading = element("div", "score-row-heading");
    heading.append(
      element("span", "", label),
      element("span", "", `${Math.round(value * 100)}% · вес ${weight}%`),
    );
    const track = element("div", "score-track");
    const fill = element("span", "score-fill");
    fill.style.width = `${value * 100}%`;
    track.setAttribute("role", "progressbar");
    track.setAttribute("aria-label", label);
    track.setAttribute("aria-valuemin", "0");
    track.setAttribute("aria-valuemax", "100");
    track.setAttribute("aria-valuenow", String(Math.round(value * 100)));
    track.append(fill);
    row.append(heading, track);
    scoreGrid.append(row);
  });
  scoreDetails.append(scoreSummary, scoreGrid);
  const footer = element("div", "card-footer");
  if (card.facts?.languages?.length) {
    const languages = element("span", "languages", card.facts.languages.join(" · "));
    languages.prepend(icon("languages"));
    footer.append(languages);
  }
  if (Number.isFinite(card.score))
    footer.append(
      element(
        "span",
        "score",
        `Соответствие: ${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(card.score * 100)} / 100`,
      ),
    );
  article.append(top, explanation, chips, scoreDetails);
  if (footer.childElementCount) article.append(footer);
  return article;
}

function commonFactsText(commonFacts) {
  if (Array.isArray(commonFacts)) return commonFacts.filter(Boolean).join(" · ");
  if (typeof commonFacts?.text === "string") return commonFacts.text;
  return "";
}

function renderActionButtons(data) {
  activeActions = data.actions || [];
  const actions = element("div", "actions summary-actions");
  activeActions.forEach((action, index) => {
    const button = element("button", "button button-outline", action.label);
    button.type = "button";
    button.dataset.action = index;
    button.append(icon("arrow-right"));
    actions.append(button);
  });
  return actions;
}

function renderComparison(data, panel) {
  const section = element("section", "comparison-result");
  section.append(element("h3", "", "Сравнение дат"), element("p", "comparison-message", data.message));
  const columns = element("div", "comparison-columns");
  for (const [label, result] of [
    ["Текущая дата", data.a],
    ["Другая дата", data.b],
  ]) {
    const column = element("div", "comparison-column");
    column.append(
      element("span", "eyebrow", label),
      element("strong", "", dateLabel(result?.query?.date || "")),
      element("span", "", `Подрядчиков: ${result?.cards?.length || 0}`),
    );
    columns.append(column);
  }
  section.append(columns);
  panel.replaceChildren(section);
  panel.hidden = false;
}

function renderCompareControls(container, query) {
  if (!query?.date) return;
  const section = element("section", "compare-tools");
  const formNode = element("form", "compare-form");
  const label = element("label", "", "Сравнить с другой датой");
  label.htmlFor = "compare-date";
  const date = element("input");
  date.id = "compare-date";
  date.name = "date2";
  date.type = "date";
  date.required = true;
  date.min = form.elements.date.min || "2026-09-23";
  date.max = form.elements.date.max || "2026-12-31";
  date.value = query.date;
  const button = element("button", "button button-outline", "Сравнить");
  button.type = "submit";
  const panel = element("div", "compare-panel");
  panel.hidden = true;
  formNode.append(label, date, button);
  section.append(formNode, panel);
  formNode.addEventListener("submit", async (event) => {
    event.preventDefault();
    button.disabled = true;
    button.textContent = "Сравниваем…";
    panel.hidden = false;
    panel.replaceChildren(element("p", "notice", "Сравниваем выдачу на двух датах…"));
    try {
      renderComparison(await request("/api/compare", { query, date2: date.value }), panel);
    } catch (error) {
      panel.replaceChildren(
        element("p", "notice compare-error", `Сравнение недоступно. ${error.message}`),
      );
    } finally {
      button.disabled = false;
      button.textContent = "Сравнить";
    }
  });
  container.append(section);
}

function renderExclusions(data) {
  const excluded = data.excludedList || [];
  const counts = data.excluded || {};
  const total =
    excluded.length || Object.values(counts).reduce((sum, count) => sum + Number(count || 0), 0);
  if (!total) return;
  const section = element("section", "exclusions");
  const toggle = element("button", "disclosure");
  toggle.type = "button";
  toggle.dataset.disclosure = "true";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-controls", "excluded-body");
  const chevron = icon("chevron-down");
  chevron.classList.add("chevron");
  toggle.append(
    icon("list-filter"),
    element("span", "", "Почему не попали"),
    element("span", "count", total),
    chevron,
  );
  const panel = element("div", "disclosure-panel");
  panel.id = "excluded-body";
  panel.inert = true;
  const content = element("div", "disclosure-content");
  for (const [reason, label] of Object.entries(reasons)) {
    const items = excluded.filter((item) => item.reason === reason);
    const count = items.length || counts[reason];
    if (!count) continue;
    const group = element("section", "reason-group");
    const title = element("h3", "", label);
    title.append(element("span", "", count));
    const list = element("ul");
    items.forEach((item) => {
      const line = element("li");
      const name = element("span", "excluded-name");
      name.append(privateText(item.name));
      const detail = element("span");
      detail.append(privateText(item.detail || label));
      line.append(name, detail);
      list.append(line);
    });
    group.append(title, list);
    content.append(group);
  }
  panel.append(content);
  section.append(toggle, panel);
  results.append(section);
}

function renderResult(data) {
  if (!statuses[data.status] || !Array.isArray(data.cards))
    throw new Error("Не удалось прочитать результат подбора. Попробуйте ещё раз.");
  preparePrivacy(data);
  const summary = element("div", "summary");
  const top = element("div", "summary-top");
  const status = element("span", `status status-${data.status}`, statuses[data.status].label);
  status.prepend(icon(statuses[data.status].icon));
  top.append(status, element("span", "result-count", `В подборке: ${data.cards.length}`));
  if (Number.isFinite(data.elapsedMs)) {
    const time = element(
      "span",
      "timing",
      `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(data.elapsedMs / 1000)} с`,
    );
    time.prepend(icon("clock-3"));
    top.append(time);
  }
  const message = element("p");
  message.append(privateText(data.message || statuses[data.status].label));
  summary.append(top, message);
  const common = commonFactsText(data.commonFacts);
  if (common) {
    const facts = element("p", "common-facts");
    facts.prepend(icon("circle-check"));
    facts.append(privateText(common));
    summary.append(facts);
  }
  if (data.query) {
    const context = element("div", "query-context");
    for (const [symbol, value] of [
      ["map-pin", data.query.city],
      ["calendar-days", dateLabel(data.query.date)],
      ["wallet", money(data.query.budget)],
    ]) {
      const item = element("span", "", value);
      item.prepend(icon(symbol));
      context.append(item);
    }
    summary.append(context);
  }
  const summaryActions = renderActionButtons(data);
  if (summaryActions.childElementCount) summary.append(summaryActions);
  renderCompareControls(summary, data.query);
  results.replaceChildren(summary);
  if (data.cards.length) {
    const cards = element("div", "cards");
    data.cards.forEach((card, index) => cards.append(renderCard(card, index)));
    results.append(cards);
  } else {
    const empty = element("div", "empty-state");
    empty.dataset.state = data.status;
    const symbol = element("div", "state-symbol");
    symbol.append(icon(data.status === "no_category" ? "map-pin" : "search-x"));
    empty.append(
      symbol,
      element(
        "h3",
        "",
        data.status === "no_category" ? "Расширим географию поиска?" : "Немного изменим запрос?",
      ),
      element(
        "p",
        "",
        data.status === "no_category"
          ? "В этом городе нужной категории пока нет. Рассмотрите другой город или выберите другую категорию."
          : "Подрядчики есть, но никто не подошёл по всем условиям. Попробуйте другую дату или измените параметры.",
      ),
    );
    const breakdown = element("div", "filter-breakdown");
    for (const [reason, label] of Object.entries(reasons)) {
      if (data.excluded?.[reason])
        breakdown.append(element("span", "", `${label}: ${data.excluded[reason]}`));
    }
    if (breakdown.childElementCount) empty.append(breakdown);
    results.append(empty);
  }
  const hints = element("div", "hints");
  if (data.hints?.nearestFreeDate) {
    const hint = element("p", "", `Ближайшая дата: ${dateLabel(data.hints.nearestFreeDate)}`);
    hint.prepend(icon("calendar-days"));
    hints.append(hint);
  }
  if (Number.isFinite(data.hints?.minBudgetNeeded)) {
    const hint = element("p", "", `Минимальный бюджет: ${money(data.hints.minBudgetNeeded)}`);
    hint.prepend(icon("wallet"));
    hints.append(hint);
  }
  (data.otherCities || []).forEach((item) =>
    hints.append(element("p", "", `${item.city}: ${item.count} в каталоге`)),
  );
  if (hints.childElementCount) results.append(hints);
  renderExclusions(data);
}

async function search(query) {
  if (busy) return;
  lastQuery = structuredClone(query);
  notice(formFeedback);
  setBusy(true);
  loading();
  if (window.matchMedia("(max-width: 760px)").matches)
    document
      .querySelector(".results-heading")
      .scrollIntoView({ behavior: reduceMotion.matches ? "auto" : "smooth", block: "start" });
  try {
    renderResult(await request("/api/recommend", query));
  } catch (error) {
    if (error.status === 400)
      notice(formFeedback, `Проверьте параметры. ${error.message}`, "error");
    const panel = element("div", "error-panel");
    panel.dataset.status = error.status || "network";
    panel.setAttribute("role", "alert");
    const symbol = element("div", "state-symbol");
    symbol.append(icon(error.status === 503 ? "server-off" : "circle-alert"));
    panel.append(
      symbol,
      element(
        "h3",
        "",
        error.status === 503
          ? "Сервис временно недоступен"
          : error.status === 400
            ? "Уточните параметры запроса"
            : "Подбор пока недоступен",
      ),
      element("p", "", error.message),
    );
    const retry = element("button", "button button-outline", "Попробовать ещё раз");
    retry.type = "button";
    retry.dataset.retry = "true";
    retry.prepend(icon("rotate-ccw"));
    panel.append(retry);
    results.replaceChildren(panel);
  } finally {
    results.setAttribute("aria-busy", "false");
    setBusy(false);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  notice(parseFeedback);
  search(readQuery());
});
form.addEventListener("input", () => {
  refreshQuery();
  notice(formFeedback);
});
form.addEventListener("change", refreshQuery);
form.addEventListener("animationend", (event) => {
  if (event.animationName === "field-flash")
    event.target.closest(".field")?.classList.remove("field-updated");
});
parseForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (busy) return;
  const partialQuery = readQuery();
  setBusy(true, "parse");
  notice(parseFeedback);
  try {
    const data = await request("/api/parse", {
      text: document.querySelector("#free-text").value.trim(),
      partialQuery,
    });
    if (!data.query || typeof data.query !== "object")
      throw new Error("Не удалось разобрать описание. Заполните форму вручную.");
    fillForm(data.query, false, true);
    notice(formFeedback);
    notice(
      parseFeedback,
      data.question || "Параметры заполнены. Всё верно? Можно запускать подбор.",
    );
  } catch (error) {
    const message =
      error.status === 503
        ? "Разбор текста временно недоступен. Заполните параметры вручную — подбор подрядчиков продолжает работать."
        : error.message;
    notice(parseFeedback, message, error.status === 503 ? "warning" : "error");
  } finally {
    setBusy(false);
  }
});
document.querySelectorAll("[data-demo]").forEach((button) =>
  button.addEventListener("click", () => {
    const query = demos[Number(button.dataset.demo)];
    fillForm(query, true);
    notice(parseFeedback);
    search(query);
  }),
);
results.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (action && !busy) {
    const query = activeActions[Number(action.dataset.action)].query;
    fillForm(query, true);
    search(query);
  }
  if (event.target.closest("[data-retry]") && lastQuery) search(lastQuery);
  const toggle = event.target.closest("[data-disclosure]");
  if (toggle) {
    const open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", String(open));
    const panel = document.getElementById(toggle.getAttribute("aria-controls"));
    panel.classList.toggle("is-open", open);
    panel.inert = !open;
  }
});
const hideNames = document.querySelector("#hide-names");
const syncPrivacy = () => document.body.classList.toggle("names-hidden", hideNames.checked);
hideNames.addEventListener("change", syncPrivacy);
window.addEventListener("pageshow", syncPrivacy);
syncPrivacy();
retryMeta.addEventListener("click", loadMeta);
document.querySelector("#selfcheck-button")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const panel = document.querySelector("#selfcheck-panel");
  button.disabled = true;
  button.textContent = "Проверяем…";
  panel.hidden = false;
  panel.replaceChildren(element("p", "notice", "Запускаем проверку требований…"));
  try {
    const data = await request("/api/selfcheck");
    const checks = Array.isArray(data) ? data : data.checks || data.results || data.items || [];
    const list = element("ul", "selfcheck-list");
    checks.forEach((check) => {
      const passed = Boolean(check.ok ?? check.passed ?? check.success);
      const item = element("li", passed ? "is-passed" : "is-failed");
      item.append(
        element("strong", "", `${passed ? "✓" : "✗"} ${check.label || check.name || "Проверка"}`),
        element("span", "", check.detail || check.message || ""),
      );
      list.append(item);
    });
    panel.replaceChildren(
      checks.length ? list : element("p", "notice", "Сервер не вернул список проверок."),
    );
  } catch (error) {
    panel.replaceChildren(
      element("p", "notice compare-error", `Проверка недоступна. ${error.message}`),
    );
  } finally {
    button.disabled = false;
    button.textContent = "Проверка требований";
  }
});
loadMeta();
