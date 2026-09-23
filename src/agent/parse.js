/**
 * Free-text request -> Query, via function calling with a strict enum schema.
 * The model only fills fields; every value is validated against the catalogue afterwards,
 * so nothing outside the data can reach the engine.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DATE_WINDOW, catalogueFacets } from "../engine/data.js";
import { LlmUnavailableError, MODEL, getClient } from "./llm.js";

const TIMEOUT_MS = 8000;
const REQUIRED_FIELDS = ["city", "date", "eventType", "category", "budget"];
const CACHE_FILE = fileURLToPath(new URL("../../.cache/parse.json", import.meta.url));
const FALLBACK_HINT = "Не удалось разобрать запрос — используйте форму.";

const formatDate = (date) => date.split("-").reverse().join(".");

const QUESTIONS = {
  city: (facets) => `В каком городе мероприятие? Доступны: ${facets.cities.join(", ")}.`,
  date: () =>
    `На какую дату? Календарь подрядчиков: ${formatDate(DATE_WINDOW.min)} — ${formatDate(DATE_WINDOW.max)}.`,
  eventType: (facets) => `Какой тип мероприятия? Например: ${facets.eventTypes.slice(0, 3).join(", ")}.`,
  category: (facets) => `Какая категория подрядчика нужна? Например: ${facets.categories.slice(0, 3).join(", ")}.`,
  budget: () => "Какой у вас бюджет в тенге?",
};

// --- cache (sha256 of text + model; the same phrase always parses the same way) ---

function readCache() {
  try {
    return existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};
  } catch {
    return {};
  }
}

const cache = readCache();

function writeCache() {
  try {
    mkdirSync(fileURLToPath(new URL("../../.cache/", import.meta.url)), { recursive: true });
    writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // A missing cache file must never break a request.
  }
}

const cacheKey = (text) => createHash("sha256").update(`${MODEL}\n${text}`).digest("hex");

// --- schema -----------------------------------------------------------------

function buildTool(facets) {
  return {
    type: "function",
    function: {
      name: "set_query",
      description: "Заполнить поля запроса на подбор подрядчика по тексту пользователя.",
      parameters: {
        type: "object",
        properties: {
          city: { type: "string", enum: facets.cities, description: "Город мероприятия." },
          date: {
            type: "string",
            description:
              `Дата в формате ГГГГ-ММ-ДД. Год по умолчанию 2026. «14 ноября» -> 2026-11-14. ` +
              `Допустимый диапазон: ${DATE_WINDOW.min} — ${DATE_WINDOW.max}.`,
          },
          eventType: { type: "string", enum: facets.eventTypes, description: "Тип мероприятия." },
          category: { type: "string", enum: facets.categories, description: "Категория подрядчика." },
          budget: {
            type: "number",
            description: "Бюджет в тенге, целое число. «800 тысяч» -> 800000, «1,5 млн» -> 1500000.",
          },
          hours: { type: "number", description: "Длительность в часах, если названа." },
          language: { type: "string", enum: facets.languages, description: "Язык, если назван." },
        },
        required: [],
        additionalProperties: false,
      },
    },
  };
}

const SYSTEM_PROMPT = [
  "Ты разбираешь запрос на подбор подрядчика для мероприятия в Казахстане.",
  "Заполняй только те поля, которые прямо следуют из текста. Ничего не додумывай.",
  "Если поле не названо — не включай его в вызов функции.",
  "Значения city, eventType, category, language бери строго из перечисленных вариантов.",
].join(" ");

// --- validation of the model output ----------------------------------------

const canonical = (value, allowed) => {
  const text = String(value ?? "").trim().toLowerCase();
  return allowed.find((item) => item.toLowerCase() === text);
};

const positive = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

function validDate(value) {
  const date = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  if (date < DATE_WINDOW.min || date > DATE_WINDOW.max) return undefined;
  return date;
}

/** Keeps only values that exist in the catalogue; anything else is treated as not said. */
function sanitize(raw, facets) {
  const query = {};
  const city = canonical(raw.city, facets.cities);
  const eventType = canonical(raw.eventType, facets.eventTypes);
  const category = canonical(raw.category, facets.categories);
  const language = canonical(raw.language, facets.languages);
  const date = validDate(raw.date);
  const budget = positive(raw.budget);
  const hours = positive(raw.hours);

  if (city) query.city = city;
  if (date) query.date = date;
  if (eventType) query.eventType = eventType;
  if (category) query.category = category;
  if (budget !== undefined) query.budget = Math.round(budget);
  if (hours !== undefined) query.hours = hours;
  if (language) query.language = language;
  return query;
}

// --- LLM call ---------------------------------------------------------------

async function extract(text, facets) {
  const key = cacheKey(text);
  if (cache[key]) return cache[key];

  let completion;
  try {
    completion = await getClient().chat.completions.create(
      {
        model: MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        tools: [buildTool(facets)],
        tool_choice: { type: "function", function: { name: "set_query" } },
      },
      { timeout: TIMEOUT_MS, maxRetries: 1 },
    );
  } catch (error) {
    if (error instanceof LlmUnavailableError) throw error;
    throw new LlmUnavailableError(`${FALLBACK_HINT} (${error.message})`);
  }

  const call = completion.choices?.[0]?.message?.tool_calls?.[0];
  if (!call) throw new LlmUnavailableError(FALLBACK_HINT);

  let raw;
  try {
    raw = JSON.parse(call.function.arguments || "{}");
  } catch {
    throw new LlmUnavailableError(FALLBACK_HINT);
  }

  cache[key] = raw;
  writeCache();
  return raw;
}

/**
 * @param {string} text free-form Russian request
 * @param {Partial<Query>} [partialQuery] values already chosen in the form; the text wins over them
 * @returns {Promise<{ query: Partial<Query>, missing: string[], question: string | null }>}
 */
export async function parseRequest(text, partialQuery = {}) {
  const request = String(text ?? "").trim();
  if (!request) throw new LlmUnavailableError("Пустой запрос — опишите мероприятие словами или используйте форму.");

  const facets = catalogueFacets();
  const fromText = sanitize(await extract(request, facets), facets);
  const fromForm = sanitize(partialQuery ?? {}, facets);
  const query = { ...fromForm, ...fromText };

  const missing = REQUIRED_FIELDS.filter((field) => query[field] === undefined);
  return {
    query,
    missing,
    question: missing.length > 0 ? QUESTIONS[missing[0]](facets) : null,
  };
}
