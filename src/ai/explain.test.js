import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recommend } from "../engine/recommend.js";
import { getContractors } from "../engine/data.js";
import { CACHE_VERSION, cacheKey, createCache, hash } from "./cache.js";
import { createExplainer, pairwiseDistinct, validExplanations } from "./explain.js";
import { cardEvidence, commonFacts, templateExplanation, templateExplanations } from "./templates.js";

const query = { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 };
const memoryCache = () => createCache({ filePath: null });
const offline = (options = {}) => createExplainer({ apiKey: "", cache: memoryCache(), ...options });
const response = (texts) => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(texts) } }] });
function mockClient(create) { return { chat: { completions: { create } } }; }
function fixture() { return recommend(query); }
function explanations(result) { return Object.fromEntries(result.cards.map((card) => [card.id, card.explanation])); }
function scratch(t) {
  const folder = mkdtempSync(join(tmpdir(), "pitchers-ai-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  return join(folder, "explanations.json");
}

test("templates preserve engine contract and distinguish cards without names", async () => {
  const original = fixture();
  const before = structuredClone(original);
  const result = await offline()(original);
  assert.deepEqual(original, before);
  assert.deepEqual(result.cards.map((card) => card.id), original.cards.map((card) => card.id));
  assert.equal(result.message, original.message);
  assert.equal(result.cards.length, 3);
  assert.ok(validExplanations(explanations(result), original));
  const anonymous = result.cards.map((card) => original.cards.reduce(
    (text, shown) => text.replaceAll(shown.name, ""), card.explanation));
  assert.equal(new Set(anonymous).size, 3);
  for (const [index, card] of result.cards.entries()) {
    const { explanation, explanationSource, ...untouched } = card;
    assert.equal(explanationSource, "template");
    assert.ok(explanation.length);
    assert.deepEqual(untouched, original.cards[index]);
  }
});

test("one LLM call sees only query, IDs and facts for all cards", async () => {
  const original = fixture();
  let calls = 0;
  const explain = createExplainer({ cache: memoryCache(), client: mockClient(async (body, options) => {
    calls += 1;
    assert.equal(body.temperature, 0);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(options.maxRetries, 0);
    assert.ok(options.signal instanceof AbortSignal);
    const payload = JSON.parse(body.messages[1].content);
    assert.deepEqual(payload.query, original.query);
    assert.deepEqual(payload.commonFacts, commonFacts(original));
    assert.equal(payload.cards.length, 3);
    for (const card of payload.cards) {
      assert.deepEqual(Object.keys(card).sort(), ["evidence", "facts", "id"]);
      assert.ok(!("name" in card));
      assert.ok(!("score" in card));
    }
    return response(templateExplanations(original));
  }) });
  const first = await explain(original);
  const second = await explain(original);
  assert.equal(calls, 1);
  assert.ok(first.cards.every((card) => card.explanationSource === "llm"));
  assert.ok(second.cards.every((card) => card.explanationSource === "cache"));
  assert.deepEqual(explanations(first), explanations(second));
});

test("simultaneous identical requests share a single LLM call", async () => {
  let calls = 0;
  const original = fixture();
  const explain = createExplainer({ cache: memoryCache(), client: mockClient(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return response(templateExplanations(original));
  }) });
  const [first, second] = await Promise.all([explain(original), explain(original)]);
  assert.equal(calls, 1);
  assert.deepEqual(explanations(first), explanations(second));
});

test("empty outcomes skip both cache and LLM", async () => {
  const fail = () => { assert.fail("must not be called"); };
  const explain = createExplainer({ client: mockClient(fail), cache: { get: fail, set: fail } });
  for (const input of [{ ...query, city: "Астана", category: "Декоратор" }, { ...query, budget: 1 }]) {
    const original = recommend(input);
    assert.equal(original.cards.length, 0);
    assert.deepEqual(await explain(original), original);
  }
});

test("busy date changes cards while engine counts and messages stay intact", async () => {
  const explain = offline();
  const first = await explain(fixture());
  const original = recommend({ ...query, date: "2026-12-26" });
  const second = await explain(original);
  assert.equal(second.status, "partial");
  assert.equal(second.cards.length, 1);
  assert.notDeepEqual(first.cards.map((card) => card.id), second.cards.map((card) => card.id));
  assert.deepEqual(second.excluded, original.excluded);
  assert.equal(second.message, original.message);
  assert.match(second.message, /занят/);
  for (const card of second.cards) {
    assert.ok(!getContractors().find((item) => item.id === card.id).busyDates.has(original.query.date));
    assert.match(second.commonFacts.text, /26\.12\.2026/);
    assert.doesNotMatch(card.explanation, /26\.12\.2026/);
  }
});

test("rare category yields one honest synthetic explanation without comparisons", async () => {
  const original = recommend({ ...query, category: "Флорист", eventType: "свадьба", budget: 500000 });
  const result = await offline()(original);
  assert.equal(result.status, "partial");
  assert.equal(result.cards.length, 1);
  assert.ok(validExplanations(explanations(result), original));
  assert.ok(result.cards[0].flags.synthetic);
  assert.match(result.cards[0].explanation, /Синтетический профиль/);
  assert.doesNotMatch(result.cards[0].explanation, /среди показанных/);
});

test("synthetic, estimated and null price/hour facts are never hidden or invented", () => {
  const original = fixture();
  const facts = structuredClone(original.cards[0].facts);
  facts.flags = { synthetic: true, priceImputed: true, cityImputed: true };
  facts.maxHours = null;
  facts.differentiators = ["noHourLimit"];
  let text = templateExplanation(facts, { ...query, hours: 6 });
  assert.match(text, /Синтетический профиль/);
  assert.match(text, /оценочная цена/iu);
  assert.match(text, /не привязана к часам присутствия/);
  assert.doesNotMatch(text, /безлимит|бесконеч/);
  facts.priceFrom = null;
  facts.headroomKzt = null;
  text = templateExplanation(facts, query);
  assert.match(text, /цена не указана/iu);
  assert.doesNotMatch(text, /остаток бюджета|цена от 0/);
});

test("all documented differentiator tags produce concrete evidence", () => {
  const facts = fixture().cards[0].facts;
  for (const tag of ["cheapest", "onlyKazakh", "mostHours", "mostSpecialized", "onlyMentionsEventType", "noHourLimit"]) {
    const withTag = { ...facts, differentiators: [tag] };
    const text = templateExplanation(withTag, query);
    assert.ok(text.length > 30);
    assert.match(text, /среди показанных|не привязана к часам присутствия/iu);
  }
});

test("API failures never cache templates and subsequent requests retry", async () => {
  const original = fixture();
  for (const [create, attempts] of [
    [async () => { throw Object.assign(new Error("secret error body"), { status: 401 }); }, 1],
    [async () => ({ choices: [{ finish_reason: "stop", message: { content: "not JSON" } }] }), 2],
    [async () => response({}), 2],
    [async () => ({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }), 2],
  ]) {
    let calls = 0;
    const reasons = [];
    const explain = createExplainer({ cache: memoryCache(), onFallback: (reason) => reasons.push(reason),
      client: mockClient(async (...args) => { calls += 1; return create(...args); }) });
    const first = await explain(original);
    const second = await explain(original);
    assert.equal(calls, attempts * 2);
    assert.ok(first.cards.every((card) => card.explanationSource === "template"));
    assert.deepEqual(explanations(first), explanations(second));
    assert.equal(reasons.length, 2);
    assert.ok(!JSON.stringify(reasons).includes("secret"));
  }
});

test("deadline aborts even a never-resolving API without caching fallback", async () => {
  let signal;
  const reasons = [];
  const explain = createExplainer({ timeoutMs: 20, cache: memoryCache(), onFallback: (reason) => reasons.push(reason),
    client: mockClient((_body, options) => { signal = options.signal; return new Promise(() => {}); }) });
  const start = performance.now();
  const result = await explain(fixture());
  assert.ok(performance.now() - start < 1000);
  assert.ok(signal.aborted);
  assert.deepEqual(reasons, ["timeout"]);
  assert.ok(result.cards.every((card) => card.explanationSource === "template"));
});

test("default deadline allows eight seconds and then aborts the API", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  let first;
  const explain = createExplainer({ cache: memoryCache(), client: mockClient((body, options) => {
    assert.ok(options.timeout > 7900 && options.timeout <= 8000);
    assert.equal(body.model, "gpt-4o-mini");
    signal = options.signal;
    return new Promise(() => {});
  }), model: "gpt-4o-mini" });
  const pending = explain(fixture()).then((result) => { first = result; });
  t.mock.timers.tick(7999);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first, undefined);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await pending;
  assert.ok(signal.aborted);
  assert.ok(first.cards.every((card) => card.explanationSource === "template"));
});

test("pairwise validation requires evidence in BOTH directions, not different wording", () => {
  const original = fixture();
  const texts = templateExplanations(original);
  assert.ok(pairwiseDistinct(texts, original));
  const [first, second, third] = original.cards;
  assert.equal(pairwiseDistinct({ ...texts, [third.id]: texts[second.id] }, original), false);
  assert.equal(pairwiseDistinct({ ...texts, [first.id]: "Подрядчик подходит по всем условиям." }, original), false);
  const repeated = Object.fromEntries(original.cards.map((card) => [card.id, Object.values(texts).join(" ")]));
  assert.equal(pairwiseDistinct(repeated, original), false);
  const shared = structuredClone(original);
  shared.cards[1].facts = structuredClone(shared.cards[0].facts);
  assert.equal(pairwiseDistinct(templateExplanations(shared), shared), false);
});

test("one failed validation gets one repair and only the repaired LLM response is cached", async () => {
  const original = fixture();
  let calls = 0;
  const explain = offline({ client: mockClient(async (body) => {
    calls += 1;
    if (calls === 1) return response({});
    assert.equal(body.messages.length, 3);
    assert.match(body.messages[2].content, /Проверка не пройдена/);
    return response(templateExplanations(original));
  }) });
  assert.equal((await explain(original)).cards[0].explanationSource, "llm");
  assert.equal((await explain(original)).cards[0].explanationSource, "cache");
  assert.equal(calls, 2);
});

test("repair uses the remaining deadline, never another eight seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let calls = 0;
  let signal;
  const explain = offline({ client: mockClient((_body, options) => {
    calls += 1;
    signal = options.signal;
    if (calls === 1) return new Promise((resolve) => setTimeout(() => resolve(response({})), 5000));
    assert.equal(options.timeout, 3000);
    return new Promise(() => {});
  }) });
  const pending = explain(fixture());
  t.mock.timers.tick(5000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  t.mock.timers.tick(3000);
  assert.equal((await pending).cards[0].explanationSource, "template");
  assert.equal(signal.aborted, true);
});

test("content validator rejects generic phrases, invented numbers and missing evidence", () => {
  const original = fixture();
  const texts = templateExplanations(original);
  const id = original.cards[0].id;
  for (const changed of [null, [], {}, { ...texts, extra: "unexpected" }, { ...texts, [id]: 3 },
    { ...texts, [id]: "Отличный выбор для мероприятия." },
    { ...texts, [id]: "Свободен по календарю на 17.10.2026. " + texts[id] },
    { ...texts, [id]: texts[id] + " Получил 987654 наград." },
    { ...texts, [id]: texts[id].replace(cardEvidence(original)[id].detail, "Факты отсутствуют") }]) {
    assert.equal(validExplanations(changed, original), false);
  }
});

test("canonical cache key ignores property insertion order but respects date, IDs and model", () => {
  assert.equal(cacheKey(query, ["A"], "mini"), cacheKey(Object.fromEntries(Object.entries(query).reverse()), ["A"], "mini"));
  assert.notEqual(cacheKey(query, ["A"], "mini"), cacheKey({ ...query, date: "2026-12-26" }, ["A"], "mini"));
  assert.notEqual(cacheKey(query, ["A", "B"], "mini"), cacheKey(query, ["B", "A"], "mini"));
  assert.notEqual(cacheKey(query, ["A"], "mini"), cacheKey(query, ["A"], "other"));
  assert.notEqual(cacheKey(query, ["A"], "mini"), hash({ query, cardIds: ["A"], model: "mini" }));
});

test("file cache survives a new explainer and invalidates changed facts", async (t) => {
  const filePath = scratch(t);
  const original = fixture();
  const first = await offline({ cache: createCache({ filePath }),
    client: mockClient(async () => response(templateExplanations(original))) })(original);
  const second = await offline({ cache: createCache({ filePath }) })(original);
  assert.ok(second.cards.every((card) => card.explanationSource === "cache"));
  assert.deepEqual(explanations(first), explanations(second));
  const changed = structuredClone(original);
  changed.cards[0].facts.descriptionSnippet = "Проводит деловые конференции с синхронным переводом.";
  const third = await offline({ cache: createCache({ filePath }) })(changed);
  assert.equal(third.cards[0].explanationSource, "template");
  assert.notEqual(first.cards[0].explanation, third.cards[0].explanation);
  const saved = JSON.parse(readFileSync(filePath, "utf8"));
  assert.equal(saved.version, CACHE_VERSION);
  assert.ok(Object.values(saved.entries).every((entry) => entry.source === "llm"));
});

test("corrupt cache and unwritable paths never break results", async (t) => {
  const filePath = scratch(t);
  for (const contents of ["invalid", "null", "[]", '{"version":1,"entries":[]}']) {
    writeFileSync(filePath, contents);
    const result = await offline({ cache: createCache({ filePath }) })(fixture());
    assert.ok(result.cards.every((card) => card.explanationSource === "template"));
  }
  const explain = offline({ cache: createCache({ filePath: join(filePath, "impossible.json") }),
    client: mockClient(async () => response(templateExplanations(fixture()))) });
  const first = await explain(fixture());
  const second = await explain(fixture());
  assert.deepEqual(explanations(first), explanations(second));
  assert.ok(second.cards.every((card) => card.explanationSource === "cache"));
});

test("diagnostics and cache adapter exceptions cannot break explanations", async () => {
  const fail = () => { throw new Error("failure"); };
  const explain = offline({ cache: { get: fail, set: fail }, onFallback: fail });
  const result = await explain(fixture());
  assert.equal(result.cards.length, 3);
  assert.ok(result.cards.every((card) => card.explanationSource === "template"));
});

test("templates remain valid across all source profiles and description shapes", async () => {
  const explain = offline();
  for (const profile of getContractors()) {
    const date = Array.from({ length: 100 }, (_, offset) =>
      new Date(Date.UTC(2026, 8, 23 + offset)).toISOString().slice(0, 10))
      .find((day) => !profile.busyDates.has(day));
    if (!date) continue;
    const result = recommend({ city: profile.city, category: profile.categories[0], date,
      eventType: profile.formats[0], budget: Math.max(1000000, profile.priceFrom ?? 0),
      language: profile.languages[0], hours: profile.maxHours ?? 6 });
    const first = await explain(result);
    const distinguishable = Object.values(cardEvidence(result)).every((item) => item.distinguishable);
    assert.equal(validExplanations(explanations(first), result), distinguishable, JSON.stringify(first.cards));
    if (!distinguishable) assert.ok(first.cards.every((card) => card.explanationSource === "template"));
    const second = await explain(result);
    assert.deepEqual(explanations(first), explanations(second));
    assert.ok(second.cards.every((card) => card.explanationSource === "template"));
  }
});

test("templates start with evidence, keep common facts outside and do not duplicate the opening", async () => {
  const original = fixture();
  const evidence = cardEvidence(original);
  const result = await offline()(original);
  assert.deepEqual(result.commonFacts, commonFacts(original));
  for (const card of result.cards) {
    assert.ok(card.explanation.toLocaleLowerCase("ru").startsWith(evidence[card.id].differentiator));
    assert.doesNotMatch(card.explanation, /свободен по календарю|17\.10\.2026|формат «корпоратив»/iu);
  }
  assert.ok(pairwiseDistinct(explanations(result), original));
  const single = { ...original, cards: [original.cards[1]] };
  const text = templateExplanations(single)[single.cards[0].id];
  assert.equal((text.match(/в описании:/giu) ?? []).length, 1);
});

test("identical profile facts disclose missing evidence without inventing distinctions", () => {
  const original = fixture();
  const first = { ...original.cards[0], facts: { ...original.cards[0].facts, differentiators: [] } };
  const identical = { ...original, cards: [first, { ...structuredClone(first), id: "duplicate" }] };
  const texts = templateExplanations(identical);
  assert.equal(validExplanations(texts, identical), false);
  for (const text of Object.values(texts)) assert.match(text, /^Различия по имеющимся фактам не подтверждены/);
});

test("missing engine tags use distinct profile facts without changing the engine", () => {
  const original = fixture();
  const before = structuredClone(original);
  const evidence = cardEvidence(original);
  assert.equal(original.cards[1].facts.differentiators.length, 0);
  assert.equal(original.cards[2].facts.differentiators.length, 0);
  assert.match(evidence[original.cards[1].id].differentiator, /6 ч/);
  assert.match(evidence[original.cards[2].id].differentiator, /8 ч/);
  assert.ok(Object.values(evidence).every((item) => item.distinguishable));
  assert.deepEqual(original, before);
  assert.match(commonFacts(original).text, /17\.10\.2026/);
});

test("temporary failure recovers to LLM and then survives a cache restart", async (t) => {
  const filePath = scratch(t);
  let calls = 0;
  const original = fixture();
  const explain = offline({ cache: createCache({ filePath }), client: mockClient(async () => {
    if (++calls === 1) throw new Error("temporary outage");
    return response(templateExplanations(original));
  }) });
  const first = await explain(original);
  assert.equal(first.cards[0].explanationSource, "template");
  assert.equal(existsSync(filePath), false);
  assert.equal((await explain(original)).cards[0].explanationSource, "llm");
  assert.equal((await explain(original)).cards[0].explanationSource, "cache");
  assert.equal(calls, 2);
  assert.equal((await offline({ cache: createCache({ filePath }) })(original)).cards[0].explanationSource, "cache");
});

test("cache rejects legacy, missing and template provenance", (t) => {
  const filePath = scratch(t);
  const texts = { A: "text" };
  for (const source of [undefined, "template", "cache"]) {
    const cache = createCache({ filePath: null });
    assert.equal(cache.set("key", "fingerprint", texts, source), false);
    assert.equal(cache.get("key", "fingerprint"), undefined);
    writeFileSync(filePath, JSON.stringify({ version: CACHE_VERSION,
      entries: { key: { fingerprint: "fingerprint", texts, source } } }));
    assert.equal(createCache({ filePath }).get("key", "fingerprint"), undefined);
  }
  writeFileSync(filePath, JSON.stringify({ version: 1,
    entries: { key: { fingerprint: "fingerprint", texts, source: "llm" } } }));
  assert.equal(createCache({ filePath }).get("key", "fingerprint"), undefined);
});
