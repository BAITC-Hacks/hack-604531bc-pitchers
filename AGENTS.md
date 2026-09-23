# AGENTS.md — Smart contractor matching (HackAlem AI, task #79-lite)

Read this file fully before any change. Work ONLY in the folder you own (see Ownership).
Do not refactor or reformat files you do not own. Do not add dependencies without need.

## Product in one paragraph
A customer already has a city catalogue of event contractors. Given city, date, event type,
contractor category and budget (optional: duration in hours, language), the service returns
up to 3 contractor cards. Each card has a concrete 1–2 sentence explanation of why this
contractor is here. The explanation is the value, not the sorting.
Jury priority: explanation quality > honest handling of rare / busy / empty cases > speed > UI.

## Stack
- Node.js 24, ES modules (`"type": "module"`), Express, `csv-parse`, `dotenv`, `openai` SDK.
- Frontend: plain HTML + CSS + vanilla JS in `/public` (no build step).
- No database. Data is loaded from CSV into memory on startup.
- Code, identifiers, commits: English. All user-facing text: Russian.

## Structure and ownership
```
data/contractors.csv          # original dataset (do not edit)
data/synthetic.csv            # our extra profiles, same columns, synthetic=true (optional)
src/engine/                   # OWNER: Damir — data, filters, scoring, statuses, facts
  data.js                     # load + normalize CSV
  filters.js                  # hard filters with exclusion reasons
  score.js                    # deterministic scoring
  recommend.js                # recommend(query) -> EngineResult
src/ai/                       # OWNER: AI dev — explanations
  templates.js                # fallback explanation from facts (no LLM)
  explain.js                  # explain(engineResult) -> cards with explanation
  cache.js                    # file cache .cache/explanations.json
src/server.js                 # OWNER: Frontend dev — Express API
public/                       # OWNER: Frontend dev — index.html, app.js, styles.css
scripts/demo.js               # OWNER: Damir — demo queries + determinism check
README.md                     # OWNER: AI dev
```

## Data model (after normalization in src/engine/data.js)
```js
Contractor = {
  id: "HK-39372",
  name: "…",                       // anon_name
  categories: ["Ведущий"],          // split by "|"
  city: "Алматы" | "Астана" | "Зарубежье",
  priceFrom: 200000,                // price_from_kzt, KZT per event
  formats: ["свадьба", "той", …],   // event_formats split by "|"
  languages: ["русский", …],        // split by "|"
  maxHours: 8 | null,               // null = not tied to presence (florist, decorator…)
  busyDates: Set<"YYYY-MM-DD">,     // busy_dates split by "|"
  description: "…",
  flags: { synthetic: bool, cityImputed: bool, priceImputed: bool }
}
```
Date window of calendars: 2026-09-23 … 2026-12-31. A date outside the window is a validation error.

## Query
```js
Query = { city, date: "YYYY-MM-DD", eventType, category, budget, hours?: number, language?: string }
```

## Engine rules (src/engine) — deterministic, no LLM, no randomness
1. Candidates = contractors where `city === query.city` AND `categories` includes `query.category`.
   - If none → status `no_category`. Also report in which other cities this category exists (counts).
2. Hard filters, applied IN THIS ORDER; each excluded contractor gets exactly one reason — the FIRST failed filter:
   `busy` (date in busyDates) → `over_budget` (priceFrom > budget) → `format` (eventType not in formats)
   → `language` (only if query.language given and not in languages)
   → `hours` (only if query.hours given and maxHours !== null and maxHours < hours).
3. Score each passed contractor, all components in 0..1, then round to 4 decimals:
   - `relevance` 0.35 — share of keywords for eventType found in description (lowercase, see KEYWORDS below);
   - `budget` 0.25 — `1 - priceFrom / budget`;
   - `specialization` 0.15 — `1 / formats.length` normalized to 0..1 across candidates (fewer formats = more specialized);
   - `hours` 0.15 — if query.hours: `maxHours === null ? 1 : min(1, (maxHours - hours) / hours + 0.5)`; else 0.5;
   - `dataQuality` 0.10 — real & not imputed = 1; imputed city or price = 0.5; synthetic = 0.
   Sort by score desc, tie-break by `id` asc. Take top 3.
4. Status: 3 cards → `found`; 1–2 → `partial`; 0 with candidates → `all_filtered`.
5. For `partial` and `all_filtered` return `excluded` counts per reason and `hints`:
   - `nearestFreeDate`: closest date within ±14 days where at least one candidate passes all filters;
   - `minBudgetNeeded`: min priceFrom among candidates that are free on the date and fit format/language/hours.
6. Facts per card (used by explanations, never invent anything beyond facts):
   `priceFrom, budget, headroomKzt, headroomPct, formats, languages, maxHours, matchedKeywords,
   descriptionSnippet (≤140 chars around first matched keyword, else first sentence), flags,
   differentiators` — what this card has that the other shown cards do not
   (e.g. `cheapest`, `onlyKazakh`, `mostHours`, `mostSpecialized`, `onlyMentionsEventType`, `noHourLimit`).

KEYWORDS (lowercase stems):
```js
{ "свадьба": ["свадьб","венчан","церемон","молодожен"],
  "той": ["той","казахск","национальн","традиц","узату","беташар"],
  "корпоратив": ["корпоратив","компани","тимбилд","сотрудник","новогодн"],
  "конференция": ["конференц","форум","делов","презентац","спикер"],
  "юбилей": ["юбилей","годовщин"],
  "день рождения": ["день рождени","детск","праздник"] }
```

## Contract: engine → ai → server
```js
EngineResult = {
  status: "found" | "partial" | "no_category" | "all_filtered",
  query,
  candidatesTotal: number,
  excluded: { busy, over_budget, format, language, hours },   // counts
  excludedList: [{ id, name, reason, detail }],  // every excluded candidate, reason order then id asc
  cards: [{ id, name, categories, city, priceFrom, flags, score, scoreParts, facts, factChips }],
  commonFacts: ["все свободны 17.10.2026", …],   // Russian, what ALL shown cards share; [] without cards
  otherCities: [{ city, count }],        // for no_category
  hints: { nearestFreeDate?, minBudgetNeeded? },
  actions: [{ label, query }],           // ready-to-send follow-up queries, built from hints + otherCities
  message: "…"                           // Russian, deterministic, built by engine
}
explain(EngineResult) -> same object, each card gets `explanation: string` and `explanationSource: "llm" | "template" | "cache"`
```
`excludedList[].detail` — one concrete Russian phrase per reason, all numbers taken from the data:
`занят 17.10.2026` · `от 2 000 000 ₸ при бюджете 1 500 000 ₸` · `не берёт формат «той»`
· `не работает на казахском` · `до 6 ч при нужных 8`.

`actions[].query` is a complete Query the UI can send back unchanged:
- `nearestFreeDate` → «Показать на 18.12.2026» (same query, new date);
- `minBudgetNeeded` (only when above the asked budget) → «Показать с бюджетом от 650 000 ₸»;
- each `otherCities` entry → «Показать в Алматы (3)» (same query, new city).

`cards[].factChips` — 2–4 short strings derived from `facts` (price share of budget, differentiators,
matched keywords, hours), deduplicated, in this order. They are UI labels; the explanation stays the
main text of the card.

`facts.differentiators` is **never empty**. Strict tags come first: `cheapest`, `onlyKazakh`,
`noHourLimit`, `mostHours`, `mostSpecialized`, `onlyMentionsEventType`. When a card earns none of
them, exactly one fallback tag is produced by walking measurable dimensions in a fixed order —
`priceRank:2of3` → `uniqueHours:6` → `onlyLanguage:английский` → `mostLanguages:3` →
`uniqueFormatCount:4` → `bestScore:relevance` → `realProfile` / `syntheticProfile` →
`uniqueWord:<слово>` (a word no other shown card uses, the rarest one in the catalogue) →
`rareWord:<слово>` → `equalOnAllDimensions`. A single shown card gets `onlyFit`.
Tags after `:` carry a value; consumers must skip tags they do not know.

Engine `message` examples (Russian, always concrete numbers):
- partial: «Из 10 ведущих в Алматы 9 заняты 26.12.2026 — показываем единственного свободного.»
- all_filtered: «В Алматы 8 банкетных залов, но ни один не подходит: 5 заняты на эту дату, 3 дороже бюджета. Ближайшая дата со свободным залом — 19.12.2026.»
- no_category: «В Астане нет подрядчиков категории «Декоратор». В Алматы — 3.»

## Explanations (src/ai)
- ONE LLM call for all cards of a query, JSON output `{ "<id>": "<explanation>" }`, temperature 0.
- The model receives ONLY query + facts of all shown cards and must mention at least one concrete
  number or detail from facts and at least one differentiator. 1–2 sentences, Russian.
- Forbidden: generic phrases («отличный выбор», «идеально подойдёт», «профессионал своего дела»),
  anything not present in facts. If flags.synthetic → never present it as a real reviewed profile.
- Cache key = sha256(JSON of query + card ids + model). Same query → same text.
- Timeout 6 s or invalid JSON → `templates.js` builds the explanation from facts. Never fail the request.

## LLM config (.env, never committed; each teammate uses their OWN key)
```
LLM_API_KEY=...                      # OpenAI key, or NVIDIA key from build.nvidia.com
LLM_BASE_URL=                        # empty for OpenAI; https://integrate.api.nvidia.com/v1 for NVIDIA
LLM_MODEL=...                        # fast small model available in the account
PORT=3000
```
```js
import OpenAI from "openai";
const client = new OpenAI({ apiKey: process.env.LLM_API_KEY, baseURL: process.env.LLM_BASE_URL || undefined });
```

## API (src/server.js)
- `GET  /api/meta` → `{ cities, categories, eventTypes, languages, dateRange, catalogue: { total } }` built from data.
- `POST /api/recommend` body = Query → EngineResult after explain + `elapsedMs`. Validation errors → 400 with Russian message.
- `POST /api/compare` (src/api/compare.js) body = `{ query, date2 }` → `{ a, b, diff: { droppedOut, newcomers }, message, elapsedMs }`,
  both results explained; a failing explanation layer degrades to cards without `explanation`.
- `GET  /api/selfcheck` (src/api/selfcheck.js) → array of 10 `{ id, title, passed, detail, ms }` — the case
  requirements verified against live data.
- `POST /api/parse`, `GET /api/parse/status` (src/agent/) → free-text query parsing; 503 when no LLM key.
- Serve `/public` statically. Target response < 10 s.
- Request/response examples for every endpoint: `docs/api.md`.

## UI (public/) — clean and minimal, explanations first
- Form: city, date (min 2026-09-23, max 2026-12-31), event type, category, budget ₸; optional hours, language.
- Three demo buttons prefill queries: «Плотная категория», «Редкая категория», «Без результата».
- Four visually distinct states: found / partial (show message why fewer) / no_category / all_filtered (show breakdown + hints). Never an empty screen.
- Card: name, category, city, «от 350 000 ₸», explanation (largest text on the card), badges:
  «синтетический профиль», «цена оценочная», «город уточнён» from flags.
- Neutral palette + one accent (#0D676B), system font stack, 8 px spacing grid, cards with soft shadow, mobile-friendly.

## Git
- Commit small and often, message in English: `feat(engine): add hard filters with reasons`.
- `git pull --rebase` before every push. Never commit `.env`, `node_modules`, `.cache`.
- Each teammate commits their own part (personal contribution is required by the rules).
