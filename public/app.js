"use strict";

const $ = (selector) => document.querySelector(selector);
const money = (value) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value);
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const dateLabel = (value) =>
  new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
const DEFAULT_QUERY = {
  city: "Алматы",
  date: "2026-10-17",
  eventType: "корпоратив",
  category: "Ведущий",
  budget: 1500000,
};
const DEMOS = {
  dense: DEFAULT_QUERY,
  rare: {
    ...DEFAULT_QUERY,
    category: "Флорист",
    eventType: "свадьба",
    budget: 500000,
  },
  empty: { ...DEFAULT_QUERY, date: "2026-12-25", budget: 100000 },
};
const STORAGE_KEY = "pitchers.saved.v1";
const REASONS = {
  busy: "Заняты на дату",
  over_budget: "Дороже бюджета",
  format: "Другой формат",
  language: "Другой язык",
  hours: "Не хватает часов",
};
const SOURCES = {
  llm: "AI-объяснения",
  cache: "AI-объяснения из кэша",
  template: "По фактам каталога",
};
const state = {
  meta: null,
  result: null,
  view: location.hash === "#saved" ? "saved" : "search",
  saved: {},
  loading: false,
  error: null,
  requestId: 0,
  hideNames: false,
};
let controller;
let toastTimer;
let formRevision = 0;

function visibleText(text) {
  if (!state.hideNames) return text;
  const profiles = [
    ...(state.result?.cards ?? []),
    ...(state.result?.excludedList ?? []),
    ...Object.values(state.saved).map(({ card }) => card),
  ];
  const identities = [
    ...new Set(profiles.flatMap(({ id, name }) => [id, name]).filter(Boolean)),
  ].sort((a, b) => b.length - a.length);
  return identities.reduce(
    (value, identity) => value.replaceAll(identity, "[имя скрыто]"),
    String(text),
  );
}

function node(tag, className = "", text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function icon(name) {
  const element = node("i");
  element.dataset.lucide = name;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function refreshIcons() {
  window.lucide?.createIcons({
    attrs: { "aria-hidden": "true", focusable: "false" },
  });
}

function actionButton(text, iconName, handler, className = "secondary-button") {
  const button = node("button", className);
  button.type = "button";
  if (iconName) button.append(icon(iconName));
  if (text) button.append(node("span", "", text));
  button.addEventListener("click", handler);
  return button;
}

function announce(text) {
  clearTimeout(toastTimer);
  $("#toast").textContent = text;
  $("#toast").hidden = false;
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 3500);
}

function loadSaved() {
  try {
    const entries = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(entries)) return;
    for (const entry of entries.slice(0, 100)) {
      const card = entry?.card;
      if (
        typeof card?.id === "string" &&
        typeof card.name === "string" &&
        typeof card.explanation === "string" &&
        Array.isArray(card.categories) &&
        Array.isArray(card.facts?.languages) &&
        Array.isArray(card.facts?.formats) &&
        card.flags &&
        /^\d{4}-\d{2}-\d{2}$/.test(entry.query?.date) &&
        Number.isFinite(Date.parse(entry.query.date))
      ) {
        state.saved[card.id] = entry;
      }
    }
  } catch {
    /* Storage may be unavailable or contain an older schema. */
  }
}

function updateSavedButtons() {
  $("#saved-count").textContent = Object.keys(state.saved).length;
  document.querySelectorAll("[data-save-id]").forEach((button) => {
    const saved = Boolean(state.saved[button.dataset.saveId]);
    const label = saved ? "Убрать из избранного" : "Добавить в избранное";
    button.setAttribute("aria-pressed", String(saved));
    button.setAttribute("aria-label", label);
    button.title = label;
    button.replaceChildren(icon(saved ? "bookmark-check" : "bookmark"));
    if (button.dataset.showLabel)
      button.append(node("span", "", saved ? "В избранном" : "В избранное"));
  });
  refreshIcons();
}

function toggleSaved(card, query) {
  const removed = Boolean(state.saved[card.id]);
  if (removed) delete state.saved[card.id];
  else state.saved[card.id] = { card, query };
  let persisted = true;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.values(state.saved)),
    );
  } catch {
    persisted = false;
  }
  if (state.view === "saved") renderSaved();
  updateSavedButtons();
  announce(
    persisted
      ? removed
        ? "Карточка удалена из избранного"
        : "Карточка добавлена в избранное"
      : "Избранное сохранено только до закрытия страницы",
  );
}

function saveButton(card, query, withLabel = false) {
  const button = actionButton(
    "",
    "bookmark",
    () => toggleSaved(card, query),
    withLabel ? "primary-button" : "icon-button",
  );
  button.dataset.saveId = card.id;
  if (withLabel) button.dataset.showLabel = "true";
  return button;
}

function flagList(card) {
  const list = node("div", "flag-list");
  if (card.flags.synthetic)
    list.append(node("span", "badge", "Синтетический профиль"));
  if (card.flags.priceImputed)
    list.append(node("span", "badge", "Цена оценочная"));
  if (card.flags.cityImputed)
    list.append(node("span", "badge badge-neutral", "Город уточнён"));
  list.hidden = !list.childElementCount;
  return list;
}

function renderCard(card, query, index) {
  const article = node("article", "vendor-card");
  article.dataset.id = card.id;
  const top = node("div", "card-top");
  top.append(
    node("span", "rank", String(index + 1).padStart(2, "0")),
    saveButton(card, query),
  );
  const identity = node("div", "card-identity");
  const displayName = state.hideNames
    ? `Подрядчик ${String.fromCharCode(65 + index)}`
    : card.name;
  const initials = state.hideNames
    ? String.fromCharCode(65 + index)
    : card.name
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word[0])
        .join("");
  const avatar = node("div", "avatar", initials);
  avatar.setAttribute("aria-hidden", "true");
  identity.append(avatar, node("h3", "", displayName));
  const meta = node(
    "p",
    "card-meta",
    `${card.categories.join(", ")} · ${card.city}`,
  );
  identity.append(meta, flagList(card));
  const reason = node("div", "card-reason");
  const reasonLabel = node("div", "reason-label");
  reasonLabel.append(icon("sparkles"), node("span", "", "Почему в подборке"));
  reason.append(
    reasonLabel,
    node("p", "explanation", visibleText(card.explanation)),
  );
  const facts = node("ul", "card-facts");
  const hours = node("li");
  hours.append(
    icon("clock-3"),
    node(
      "span",
      "",
      card.facts.maxHours === null
        ? "Без привязки к часам"
        : `До ${card.facts.maxHours} ч на событии`,
    ),
  );
  const language = node("li");
  language.append(
    icon("languages"),
    node(
      "span",
      "",
      card.facts.languages.map(capitalize).join(", ") || "Языки не указаны",
    ),
  );
  facts.append(hours, language);
  if (state.view === "saved") {
    const date = node("li");
    date.append(
      icon("calendar-days"),
      node("span", "", `Подборка на ${dateLabel(query.date)}`),
    );
    facts.append(date);
  }
  const bottom = node("div", "card-bottom");
  const price = node("div", "card-price");
  if (Number.isFinite(card.priceFrom))
    price.append(
      node("span", "", "от"),
      document.createTextNode(`${money(card.priceFrom)} ₸`),
    );
  else price.textContent = "Цена не указана";
  const profile = actionButton(
    "Профиль",
    null,
    () => openProfile(card, query, displayName),
    "profile-button",
  );
  profile.append(icon("arrow-up-right"));
  bottom.append(price, profile);
  article.append(top, identity, reason, facts, bottom);
  return article;
}

function openProfile(card, query, displayName = card.name) {
  const content = $("#profile-content");
  content.replaceChildren();
  const header = node("div", "dialog-header");
  header.append(
    node(
      "p",
      "",
      state.hideNames ? "ПРОФИЛЬ КАТАЛОГА" : `ПРОФИЛЬ КАТАЛОГА · ${card.id}`,
    ),
  );
  const close = actionButton(
    "",
    "x",
    () => $("#profile-dialog").close(),
    "icon-button",
  );
  close.setAttribute("aria-label", "Закрыть профиль");
  close.title = "Закрыть профиль";
  header.append(close);
  const body = node("div", "dialog-body");
  const title = node("h2", "", displayName);
  title.id = "profile-title";
  body.append(
    title,
    node("p", "card-meta", `${card.categories.join(", ")} · ${card.city}`),
    flagList(card),
  );
  body.append(node("p", "dialog-explanation", visibleText(card.explanation)));
  const data = node("dl", "profile-data");
  const fields = [
    [
      "Соответствие запросу",
      Number.isFinite(card.score)
        ? `${(card.score * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} из 100`
        : "Не указано",
    ],
    [
      "Стоимость за событие",
      Number.isFinite(card.priceFrom)
        ? `От ${money(card.priceFrom)} ₸${card.flags.priceImputed ? " (оценочная)" : ""}`
        : "Не указана",
    ],
    ["Дата подбора", `${dateLabel(query.date)} 2026`],
    ["Языки", card.facts.languages.map(capitalize).join(", ") || "Не указаны"],
    [
      "Длительность",
      card.facts.maxHours === null
        ? "Без привязки к присутствию"
        : `До ${card.facts.maxHours} ч`,
    ],
    ["Форматы", card.facts.formats.map(capitalize).join(", ")],
    [
      "Источник объяснения",
      SOURCES[card.explanationSource] || "По фактам каталога",
    ],
  ];
  for (const [label, value] of fields) {
    const pair = node("div");
    pair.append(node("dt", "", label), node("dd", "", value));
    data.append(pair);
  }
  body.append(data);
  if (card.factChips?.length) {
    const chips = node("div", "profile-chips");
    for (const chip of card.factChips)
      chips.append(node("span", "profile-chip", visibleText(chip)));
    body.append(chips);
  }
  if (card.facts.descriptionSnippet) {
    const description = node("div", "profile-description");
    description.append(
      node("h3", "", "Из описания профиля"),
      node("p", "", visibleText(card.facts.descriptionSnippet)),
    );
    body.append(description);
  }
  const footer = node("div", "dialog-footer");
  footer.append(
    node("small", "", "Контакты и бронирование отсутствуют в демо-каталоге."),
    saveButton(card, query, true),
  );
  content.append(header, body, footer);
  updateSavedButtons();
  $("#profile-dialog").showModal();
}

function resetResults() {
  for (const id of [
    "cards",
    "result-context",
    "result-notice",
    "result-actions",
    "exclusion-details",
  ])
    $(`#${id}`).replaceChildren();
  for (const id of [
    "result-context",
    "result-notice",
    "result-footer",
    "export-button",
    "result-count",
  ])
    $(`#${id}`).hidden = true;
}

function renderLoading() {
  resetResults();
  $("#results").setAttribute("aria-busy", "true");
  $("#results-title").textContent = "Собираем подборку";
  $("#results-kicker").textContent = "ПЕРСОНАЛЬНАЯ ПОДБОРКА";
  for (let i = 0; i < 3; i += 1) {
    const card = node("div", "skeleton-card");
    card.setAttribute("aria-hidden", "true");
    card.append(
      node("div", "skeleton-avatar"),
      node("div", "skeleton-line short"),
      node("div", "skeleton-line"),
      node("div", "skeleton-gap"),
    );
    for (let j = 0; j < 5; j += 1)
      card.append(node("div", `skeleton-line${j === 4 ? " short" : ""}`));
    $("#cards").append(card);
  }
}

function emptyState(iconName, heading, text) {
  const box = node("div", "empty-state");
  const mark = node("span", "empty-icon");
  mark.append(icon(iconName));
  box.append(mark, node("h3", "", heading), node("p", "", text));
  return box;
}

function renderError() {
  resetResults();
  $("#results").setAttribute("aria-busy", "false");
  $("#results-title").textContent = "Не удалось получить подборку";
  const notice = $("#result-notice");
  notice.hidden = false;
  notice.dataset.state = "error";
  notice.textContent = state.error;
  const empty = emptyState(
    "wifi-off",
    "Запрос не завершён",
    "Параметры события сохранены.",
  );
  empty.append(
    actionButton("Повторить запрос", "rotate-cw", () =>
      state.meta ? submitForm() : initialize(),
    ),
  );
  $("#cards").append(empty);
  refreshIcons();
}

function renderResults() {
  if (state.view !== "search") return;
  if (state.loading) {
    renderLoading();
    refreshIcons();
    return;
  }
  if (state.error) {
    renderError();
    return;
  }
  const result = state.result;
  if (!result) return;
  resetResults();
  $("#results").setAttribute("aria-busy", "false");
  const titles = {
    found: "3 подходящих подрядчика",
    partial:
      result.cards.length === 1 ? "Найден 1 подрядчик" : "Найдены 2 подрядчика",
    no_category: "Категории нет в городе",
    all_filtered: "Пока нет совпадений",
  };
  $("#results-title").textContent = titles[result.status];
  $("#results-kicker").textContent = "ПЕРСОНАЛЬНАЯ ПОДБОРКА";
  $("#result-count").hidden = false;
  $("#result-count").textContent = result.cards.length;
  const notice = $("#result-notice");
  notice.hidden = result.status === "found";
  notice.dataset.state = result.status;
  notice.textContent = result.message;
  const commonText = Array.isArray(result.commonFacts)
    ? result.commonFacts.join("; ")
    : result.commonFacts?.text;
  if (commonText && result.cards.length) {
    $("#result-context").hidden = false;
    $("#result-context").append(
      icon("circle-check"),
      node("span", "", commonText),
    );
  }
  result.cards.forEach((card, index) =>
    $("#cards").append(renderCard(card, result.query, index)),
  );
  if (!result.cards.length) {
    const noCategory = result.status === "no_category";
    const text = noCategory
      ? `${result.query.category} · ${result.query.city}`
      : `${result.query.category} · ${dateLabel(result.query.date)} · до ${money(result.query.budget)} ₸`;
    const empty = emptyState(
      noCategory ? "map-pinned" : "calendar-search",
      noCategory
        ? "В каталоге нет этой категории"
        : "По этим условиям нет свободных профилей",
      text,
    );
    const breakdown = node("div", "reason-breakdown");
    for (const [key, count] of Object.entries(result.excluded)) {
      if (!count) continue;
      const badge = node("span", "reason-count");
      badge.append(
        node("b", "", count),
        document.createTextNode(REASONS[key] || key),
      );
      breakdown.append(badge);
    }
    empty.append(breakdown);
    $("#cards").append(empty);
  }
  for (const action of result.actions || []) {
    $("#result-actions").append(
      actionButton(action.label, "arrow-right", () => {
        setForm(action.query);
        markActiveDemo(null);
        requestRecommendations(action.query);
      }),
    );
  }
  if (result.excludedList?.length) {
    const details = node("details");
    const summary = node("summary");
    summary.append(
      icon("chevron-down"),
      node(
        "span",
        "",
        `Почему не вошли остальные · ${result.excludedList.length}`,
      ),
    );
    const list = node("ul", "exclusion-list");
    for (const excluded of result.excludedList) {
      const item = node("li");
      item.append(
        node("span", "", visibleText(excluded.name)),
        node("span", "", excluded.detail),
      );
      list.append(item);
    }
    details.append(summary, list);
    $("#exclusion-details").append(details);
  }
  if (result.cards.length) {
    $("#export-button").hidden = false;
    $("#result-footer").hidden = false;
    const sources = [
      ...new Set(
        result.cards.map(
          (card) => SOURCES[card.explanationSource] || SOURCES.template,
        ),
      ),
    ];
    $("#explanation-source").replaceChildren(
      icon("database"),
      node("span", "", sources.join(" · ")),
    );
    $("#elapsed-time").textContent =
      `${(result.elapsedMs / 1000).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} с`;
  }
  updateSavedButtons();
}

function renderSaved() {
  resetResults();
  $("#results").setAttribute("aria-busy", "false");
  $("#results-kicker").textContent = "ВАШ СПИСОК";
  $("#results-title").textContent = "Сохранённые подрядчики";
  const entries = Object.values(state.saved);
  $("#result-count").hidden = false;
  $("#result-count").textContent = entries.length;
  $("#export-button").hidden = !entries.length;
  entries.forEach(({ card, query }, index) =>
    $("#cards").append(renderCard(card, query, index)),
  );
  if (!entries.length) {
    const empty = emptyState(
      "bookmark",
      "Избранное пока пусто",
      "Здесь пока нет сохранённых подрядчиков.",
    );
    empty.append(
      actionButton("Перейти к подбору", "arrow-right", () => {
        location.hash = "search";
      }),
    );
    $("#cards").append(empty);
  }
  updateSavedButtons();
}

function setView(view) {
  state.view = view;
  const saved = view === "saved";
  $(".workspace").classList.toggle("is-saved", saved);
  document.querySelectorAll(".search-only").forEach((element) => {
    element.hidden = saved;
  });
  document.querySelectorAll("[data-view]").forEach((link) => {
    const active = link.dataset.view === view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#page-title").replaceChildren(
    document.createTextNode(
      saved ? "Избранные подрядчики" : "Подбор подрядчиков",
    ),
    node("span", "title-dot", "."),
  );
  $("#breadcrumb-view").textContent = saved ? "Избранное" : "Подбор";
  if (saved) renderSaved();
  else renderResults();
}

function markActiveDemo(name) {
  document.querySelectorAll("[data-demo]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.demo === name);
    button.setAttribute("aria-pressed", String(button.dataset.demo === name));
  });
}

function updateBudgetCaption() {
  const value = Number($("#budget").value);
  $("#budget-caption").textContent =
    Number.isFinite(value) && value > 0
      ? `${money(value)} ₸ за событие`
      : "Бюджет за одно событие";
}

function setForm(query) {
  formRevision += 1;
  for (const key of [
    "city",
    "date",
    "eventType",
    "category",
    "budget",
    "language",
    "hours",
  ])
    $(`#${key}`).value = query[key] ?? "";
  $("#mobile-filter-summary").textContent =
    `${query.city} · ${dateLabel(query.date)} · ${capitalize(query.eventType)}`;
  if (query.hours || query.language) $(".extra-filters").open = true;
  $("#draft-status").hidden = true;
  updateBudgetCaption();
}

function readForm() {
  const data = new FormData($("#query-form"));
  const query = Object.fromEntries(data.entries());
  query.budget = Number(query.budget);
  if (query.hours) query.hours = Number(query.hours);
  else delete query.hours;
  if (!query.language) delete query.language;
  return query;
}

async function requestRecommendations(query) {
  const requestId = ++state.requestId;
  controller?.abort();
  controller = new AbortController();
  const signal = controller.signal;
  const timeout = setTimeout(
    () => controller?.signal === signal && controller.abort(),
    11000,
  );
  state.loading = true;
  state.error = null;
  $("#draft-status").hidden = true;
  $("#mobile-filter-summary").textContent =
    `${query.city} · ${dateLabel(query.date)} · ${capitalize(query.eventType)}`;
  renderResults();
  try {
    const response = await fetch("/api/recommend", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(query),
      signal,
    });
    const result = await response.json();
    if (!response.ok)
      throw new Error(result.error || "Сервер не смог обработать запрос.");
    if (
      !Array.isArray(result.cards) ||
      !["found", "partial", "no_category", "all_filtered"].includes(
        result.status,
      )
    )
      throw new Error("Сервер вернул неполный ответ.");
    if (requestId !== state.requestId) return;
    state.result = result;
  } catch (error) {
    if (requestId !== state.requestId) return;
    state.result = null;
    state.error = signal.aborted
      ? "Сервер не ответил вовремя. Попробуйте ещё раз."
      : error instanceof TypeError
        ? "Нет связи с сервером. Проверьте подключение и повторите запрос."
        : error instanceof SyntaxError
          ? "Получен некорректный ответ сервера. Повторите запрос."
          : error.message;
  } finally {
    clearTimeout(timeout);
    if (requestId === state.requestId) {
      state.loading = false;
      renderResults();
    }
  }
}

function submitForm() {
  if (!state.meta || !$("#query-form").reportValidity()) return;
  const query = readForm();
  $("#filters").classList.add("is-collapsed");
  $("#toggle-filters").setAttribute("aria-expanded", "false");
  requestRecommendations(query);
}

async function initialize() {
  try {
    const response = await fetch("/api/meta", {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("Каталог временно недоступен.");
    const meta = await response.json();
    if (
      !["cities", "categories", "eventTypes", "languages"].every((key) =>
        Array.isArray(meta[key]),
      )
    )
      throw new Error("Не удалось загрузить параметры каталога.");
    state.meta = meta;
    for (const [field, values] of [
      ["city", meta.cities],
      ["category", meta.categories],
      ["eventType", meta.eventTypes],
      ["language", meta.languages],
    ]) {
      const select = $(`#${field}`);
      select.replaceChildren();
      if (field === "language") select.append(new Option("Любой язык", ""));
      for (const value of values)
        select.append(new Option(capitalize(value), value));
    }
    $("#date").min = meta.dateRange.min;
    $("#date").max = meta.dateRange.max;
    $("#catalogue-total").textContent = meta.catalogue?.total ?? "";
    $("#query-fields").disabled = false;
    $("#parse-button").disabled = false;
    setForm(DEFAULT_QUERY);
    await requestRecommendations(DEFAULT_QUERY);
  } catch {
    state.loading = false;
    state.error =
      "Не удалось подключиться к каталогу. Проверьте, запущен ли сервер.";
    renderResults();
  }
}

$("#query-form").addEventListener("submit", (event) => {
  event.preventDefault();
  markActiveDemo(null);
  submitForm();
});
$("#query-form").addEventListener("input", () => {
  formRevision += 1;
  $("#draft-status").hidden = false;
  markActiveDemo(null);
  updateBudgetCaption();
});
$("#toggle-filters").addEventListener("click", () => {
  const collapsed = $("#filters").classList.toggle("is-collapsed");
  $("#toggle-filters").setAttribute("aria-expanded", String(!collapsed));
  $("#toggle-filters").setAttribute(
    "aria-label",
    collapsed ? "Развернуть параметры события" : "Свернуть параметры события",
  );
});
document.querySelectorAll("[data-demo]").forEach((button) =>
  button.addEventListener("click", () => {
    if (!state.meta) return;
    setForm(DEMOS[button.dataset.demo]);
    markActiveDemo(button.dataset.demo);
    submitForm();
  }),
);
$("#export-button").addEventListener("click", () => {
  const payload =
    state.view === "saved"
      ? { saved: Object.values(state.saved) }
      : state.result;
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  );
  const link = node("a");
  link.href = url;
  link.download =
    state.view === "saved"
      ? "pitchers-favorites.json"
      : `pitchers-${state.result.query.date}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  announce("Подборка подготовлена к скачиванию");
});
$("#profile-dialog").addEventListener("click", (event) => {
  if (event.target === $("#profile-dialog")) $("#profile-dialog").close();
});
window.addEventListener("hashchange", () =>
  setView(location.hash === "#saved" ? "saved" : "search"),
);
$("#hide-names").addEventListener("change", (event) => {
  state.hideNames = event.target.checked;
  if (state.view === "saved") renderSaved();
  else renderResults();
});
$("#parse-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.meta || $("#parse-button").disabled) return;
  const revision = formRevision;
  const feedback = $("#parse-feedback");
  feedback.hidden = false;
  feedback.textContent = "Распознаём параметры события...";
  $("#parse-button").disabled = true;
  try {
    const response = await fetch("/api/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: $("#free-text").value.trim(),
        partialQuery: readForm(),
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data.error ||
          "Распознавание недоступно; параметры можно указать в форме.",
      );
    if (
      !data.query ||
      typeof data.query !== "object" ||
      Array.isArray(data.query)
    )
      throw new Error("Не удалось распознать параметры события.");
    if (revision !== formRevision) {
      feedback.textContent =
        "Параметры были изменены. Повторите распознавание.";
      return;
    }
    setForm({ ...readForm(), ...data.query });
    markActiveDemo(null);
    $("#draft-status").hidden = false;
    feedback.textContent = data.question || "Параметры заполнены.";
  } catch (error) {
    feedback.textContent =
      error instanceof TypeError || error.name === "TimeoutError"
        ? "Нет ответа сервера; параметры можно указать в форме."
        : error instanceof SyntaxError
          ? "Сервер вернул некорректный ответ."
          : error.message;
  } finally {
    $("#parse-button").disabled = false;
  }
});
loadSaved();
setView(state.view);
refreshIcons();
initialize();
