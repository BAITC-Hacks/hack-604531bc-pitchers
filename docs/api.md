# API

Все примеры ниже — из реального прогона `npm start` на порту 3000. Длинные массивы усечены знаком `…`, остальное приведено как есть. Тексты ответов на русском, ошибки валидации возвращаются с кодом 400 и полем `error`.

## GET /api/meta

Заполняет селекты формы. Значения `city`, `eventType`, `category`, `language` в запросах на подбор должны браться отсюда.

```bash
curl http://localhost:3000/api/meta
```

```json
{
  "cities": ["Алматы", "Астана", "Зарубежье"],
  "categories": ["Банкетный зал", "Ведущий", "Ведущий церемонии", "…"],
  "eventTypes": ["день рождения", "конференция", "корпоратив", "свадьба", "той", "юбилей"],
  "languages": ["английский", "казахский", "русский"],
  "dateRange": { "min": "2026-09-23", "max": "2026-12-31" },
  "catalogue": { "total": 66 }
}
```

## POST /api/recommend

Тело — `Query`: обязательны `city`, `date` (ГГГГ-ММ-ДД в границах `dateRange`), `eventType`, `category`, `budget`; необязательны `hours` и `language`. Ответ — `EngineResult` плюс `elapsedMs`.

### status: found

```bash
curl -X POST http://localhost:3000/api/recommend \
  -H "Content-Type: application/json" \
  -d '{"city":"Алматы","date":"2026-10-17","eventType":"корпоратив","category":"Ведущий","budget":1500000}'
```

```jsonc
{
  "status": "found",
  "query": { "city": "Алматы", "date": "2026-10-17", "eventType": "корпоратив", "category": "Ведущий", "budget": 1500000 },
  "candidatesTotal": 10,
  "excluded": { "busy": 5, "over_budget": 1, "format": 1, "language": 0, "hours": 0 },
  "excludedList": [
    { "id": "HK-27222", "name": "Сон Гоку", "reason": "busy", "detail": "занят 17.10.2026" }
    // …ещё 6 записей: по одной причине на каждого отсеянного
  ],
  "commonFacts": [
    "все свободны 17.10.2026",
    "все работают с форматом «корпоратив»",
    "все укладываются в бюджет 1 500 000 ₸",
    "все говорят на: русский",
    "все профили реальные, не синтетические"
  ],
  "cards": [
    {
      "id": "HK-35215",
      "name": "Кики",
      "categories": ["Ведущий"],
      "city": "Алматы",
      "priceFrom": 900000,
      "flags": { "synthetic": false, "cityImputed": false, "priceImputed": false },
      "score": 0.495,
      "scoreParts": { "relevance": 0.2, "budget": 0.4, "specialization": 1, "hours": 0.5, "dataQuality": 1 },
      "facts": {
        "priceFrom": 900000, "budget": 1500000, "headroomKzt": 600000, "headroomPct": 40,
        "formats": ["свадьба", "той", "юбилей", "корпоратив"],
        "languages": ["русский"], "maxHours": 10,
        "matchedKeywords": ["тимбилд"],
        "descriptionSnippet": "…поминальный обед, памятные годовщины, юбилеи, той обрезания, тимбилдинги…",
        "flags": { "synthetic": false, "cityImputed": false, "priceImputed": false },
        "differentiators": ["cheapest", "mostHours"]
      },
      "factChips": ["900 000 ₸ — 60% бюджета", "самый доступный из показанных", "больше всех часов — до 10 ч", "в описании: тимбилд"],
      "explanation": "Самый большой лимит присутствия среди показанных: 10 ч, в описании: «тимбилдинги, конференции и крупные события». Цена от 900 000 ₸.",
      "explanationSource": "llm"
    }
    // …ещё 2 карточки
  ],
  "rankRationale": [
    {
      "ahead": "HK-35215", "behind": "HK-44733", "scoreDelta": 0.0167, "decisivePart": "budget",
      "text": "№1 впереди №2 на 0.0167: запас бюджета — 900 000 ₸ против 1 000 000 ₸ (0.4 против 0.3333). Совпали: качество данных, часы, совпадение с описанием, специализация."
    },
    {
      "ahead": "HK-44733", "behind": "HK-77838", "scoreDelta": 0.07, "decisivePart": "relevance",
      "text": "№2 впереди №3 на 0.07: совпадение с описанием — упоминает «компани», у второй совпадений нет (0.2 против 0). Совпали: запас бюджета, качество данных, часы, специализация."
    }
  ],
  "otherCities": [],
  "hints": {},
  "actions": [],
  "message": "Из 10 подрядчиков категории «Ведущий» в Алматы подходят ровно 3 — показываем всех.",
  "elapsedMs": 2723
}
```

`rankRationale` объясняет **порядок**, а не карточку: по одной записи на соседнюю пару, с названием
решающего компонента рейтинга и фактом за ним. Позиции (№1, №2), а не имена — текст остаётся верным,
когда интерфейс скрывает личности. При равных баллах так и написано: порядок определён по `id`.

`explanationSource`: `llm` — принятый ответ модели, `cache` — сохранённый ответ модели, `template` — локальный резерв из фактов. Шаблоны не кэшируются.

### status: partial

Тот же запрос на 26.12.2026.

```jsonc
{
  "status": "partial",
  "candidatesTotal": 10,
  "excluded": { "busy": 9, "over_budget": 0, "format": 0, "language": 0, "hours": 0 },
  "excludedList": [
    { "id": "HK-27222", "name": "Сон Гоку", "reason": "busy", "detail": "занят 26.12.2026" }
    // …всего 9 записей
  ],
  "cards": [
    {
      "id": "HK-44923", "name": "Мицури Канроджи", "priceFrom": 650000, "score": 0.4667,
      "scoreParts": { "relevance": 0, "budget": 0.5667, "specialization": 1, "hours": 0.5, "dataQuality": 1 },
      "factChips": ["650 000 ₸ — 43% бюджета", "единственный подходящий вариант", "до 8 ч"],
      "explanation": "Языки: русский; лимит присутствия 8 ч. Цена от 650 000 ₸.",
      "explanationSource": "cache"
    }
  ],
  "hints": { "nearestFreeDate": "2026-12-25", "minBudgetNeeded": 650000 },
  "message": "Из 10 подрядчиков категории «Ведущий» в Алматы подходит только 1: 9 заняты 26.12.2026."
}
```

### status: all_filtered

Кандидаты есть, но не проходит никто. Возвращаются подсказки и готовые действия.

```bash
curl -X POST http://localhost:3000/api/recommend -H "Content-Type: application/json" \
  -d '{"city":"Алматы","date":"2026-12-19","eventType":"корпоратив","category":"Банкетный зал","budget":3000000}'
```

```json
{
  "status": "all_filtered",
  "candidatesTotal": 7,
  "excluded": { "busy": 7, "over_budget": 0, "format": 0, "language": 0, "hours": 0 },
  "cards": [],
  "hints": { "nearestFreeDate": "2026-12-16" },
  "actions": [
    {
      "label": "Показать на 16.12.2026",
      "query": { "city": "Алматы", "date": "2026-12-16", "eventType": "корпоратив", "category": "Банкетный зал", "budget": 3000000 }
    }
  ],
  "message": "Из 7 подрядчиков категории «Банкетный зал» в Алматы не подходит ни один: 7 заняты 19.12.2026. Ближайшая подходящая дата — 16.12.2026."
}
```

### status: no_category

В этом городе категории нет вообще. Сервис показывает, где она есть.

```json
{
  "status": "no_category",
  "candidatesTotal": 0,
  "cards": [],
  "otherCities": [{ "city": "Алматы", "count": 3 }],
  "actions": [
    {
      "label": "Показать в Алматы (3)",
      "query": { "city": "Алматы", "date": "2026-10-17", "eventType": "свадьба", "category": "Декоратор", "budget": 1000000 }
    }
  ],
  "message": "В Астане нет подрядчиков категории «Декоратор». В Алматы — 3."
}
```

`actions[].query` — готовый `Query`: интерфейс отправляет его обратно без изменений.

### Ошибка валидации

```bash
curl -X POST http://localhost:3000/api/recommend -H "Content-Type: application/json" \
  -d '{"city":"Алматы","date":"2027-01-05","eventType":"корпоратив","category":"Ведущий","budget":1500000}'
```

```json
{ "error": "Дата 05.01.2027 вне календаря подрядчиков: 23.09.2026 — 31.12.2026." }
```

HTTP 400. Так же отвечают неизвестный город, формат или язык и пустой бюджет. Неизвестная категория ошибкой не считается — это статус `no_category`.

## POST /api/compare

Тот же запрос на двух датах: кто выпал и почему, кто добавился.

```bash
curl -X POST http://localhost:3000/api/compare -H "Content-Type: application/json" \
  -d '{"query":{"city":"Алматы","date":"2026-10-17","eventType":"корпоратив","category":"Ведущий","budget":1500000},"date2":"2026-12-26"}'
```

```jsonc
{
  "a": { "status": "found", "cards": [/* выдача на 17.10.2026 */] },
  "b": { "status": "partial", "cards": [/* выдача на 26.12.2026 */] },
  "diff": {
    "droppedOut": [
      { "id": "HK-35215", "name": "Кики", "detail": "занят 26.12.2026" },
      { "id": "HK-44733", "name": "Буллма", "detail": "занят 26.12.2026" },
      { "id": "HK-77838", "name": "Хаул", "detail": "занят 26.12.2026" }
    ],
    "newcomers": [{ "id": "HK-44923", "name": "Мицури Канроджи" }]
  },
  "message": "На 26.12.2026 из выдачи выпали 3 подрядчика: Кики — занят 26.12.2026, Буллма — занят 26.12.2026, Хаул — занят 26.12.2026; добавился: Мицури Канроджи."
}
```

Обе выдачи проходят через слой объяснений; если он недоступен, сравнение возвращается без `explanation`, но с теми же карточками.

## POST /api/parse

Разбор свободного текста в `Query` через function calling. Значения берутся строго из каталога; всё остальное отбрасывается как «не сказано».

```bash
curl -X POST http://localhost:3000/api/parse -H "Content-Type: application/json" \
  -d '{"text":"Нужен фотограф на свадьбу в Алматы 17 октября"}'
```

```json
{
  "query": { "city": "Алматы", "date": "2026-10-17", "eventType": "свадьба", "category": "Фотограф" },
  "missing": ["budget"],
  "question": "Какой у вас бюджет в тенге?"
}
```

Когда всех обязательных полей хватает, `missing` пуст, а `question` равен `null`. Необязательное тело `partialQuery` заполняет пробелы значениями из формы; текст имеет приоритет. Без ключа LLM эндпоинт отвечает 503 и текстом «…используйте форму» — ручная форма остаётся рабочей. Доступность заранее: `GET /api/parse/status`.

## GET /api/selfcheck

Десять проверок требований кейса на живых данных. Каждая — отдельный объект; интерфейс показывает их списком.

```json
[
  {
    "id": "determinism",
    "title": "Детерминизм демо №1",
    "passed": true,
    "detail": "Первый запуск: HK-35215, HK-44733, HK-77838; повтор: HK-35215, HK-44733, HK-77838.",
    "ms": 4.28
  }
]
```

Идентификаторы: `determinism`, `availability`, `date_change`, `dense_category`, `rare_category`, `no_category`, `all_filtered`, `latency`, `distinct_explanations`, `no_generic_phrases`.
