import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";

// Keep the real explanation path offline, including when dotenv loads .env.
process.env.LLM_API_KEY = "";
process.env.OPENAI_API_KEY = "";
process.env.LLM_MODEL = "selfcheck-tests-offline";

const { runSelfcheck } = await import("../src/api/selfcheck.js");
const { app } = await import("../src/server.js");
const { recommend } = await import("../src/engine/recommend.js");

const CHECK_IDS = [
  "determinism", "availability", "date_change", "dense_category", "rare_category",
  "no_category", "all_filtered", "latency", "distinct_explanations", "no_generic_phrases",
];

function assertReport(report) {
  assert.ok(Array.isArray(report));
  assert.deepEqual(report.map(({ id }) => id), CHECK_IDS);
  for (const record of report) {
    assert.deepEqual(Object.keys(record).sort(), ["detail", "id", "ms", "passed", "title"]);
    assert.equal(typeof record.title, "string");
    assert.ok(record.title.trim(), record.id);
    assert.equal(typeof record.detail, "string");
    assert.ok(record.detail.trim(), record.id);
    assert.equal(typeof record.passed, "boolean", record.id);
    assert.ok(Number.isFinite(record.ms) && record.ms >= 0, record.id);
  }
}

function check(report, id) {
  const record = report.find((item) => item.id === id);
  assert.ok(record, `missing check: ${id}`);
  return record;
}

function withTexts(texts) {
  return async (result) => ({
    ...result,
    cards: result.cards.map((card, index) => ({
      ...card,
      explanation: texts[index % texts.length],
      explanationSource: "template",
    })),
  });
}

test("selfcheck runs all ten checks on the live engine and offline explain", async () => {
  const report = await runSelfcheck();
  assertReport(report);
  assert.deepEqual(report.filter((record) => !record.passed), []);
});

test("server mounts GET /api/selfcheck and returns the complete JSON report", async (context) => {
  const server = app.listen(0, "127.0.0.1");
  context.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  await once(server, "listening");

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/selfcheck`, {
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const report = await response.json();
  assertReport(report);
  assert.deepEqual(report.filter((record) => !record.passed), []);
});

test("an engine exception produces failed checks without truncating the report", async () => {
  const report = await runSelfcheck({
    recommend() { throw new Error("Тестовый сбой движка"); },
  });
  assertReport(report);
  for (const id of ["determinism", "availability", "dense_category", "latency"]) {
    assert.equal(check(report, id).passed, false, id);
  }
});

test("an explain exception cannot be reported as valid explanations", async () => {
  const report = await runSelfcheck({
    explain() { throw new Error("Тестовый сбой объяснений"); },
  });
  assertReport(report);
  for (const id of ["distinct_explanations", "no_generic_phrases", "latency"]) {
    assert.equal(check(report, id).passed, false, id);
  }
});

test("a negated exclusion and an unrelated number do not explain the rare result", async () => {
  const report = await runSelfcheck({
    recommend(query) {
      const result = recommend(query);
      return query.category === "Флорист"
        ? { ...result, message: "Никто не занят; найдено 1." }
        : result;
    },
  });
  assert.equal(check(report, "rare_category").passed, false);
});

test("all_filtered rejects invalid or out-of-range nearest-date hints", async (context) => {
  for (const date of ["2026-99-99", "2027-01-01", "2026-12-01"]) {
    await context.test(date, async () => {
      const report = await runSelfcheck({
        recommend(query) {
          const result = recommend(query);
          return query.category === "Банкетный зал"
            ? { ...result, hints: { nearestFreeDate: date } }
            : result;
        },
      });
      assert.equal(check(report, "all_filtered").passed, false);
    });
  }
});

test("repeated explanations and forbidden generic phrases fail separate checks", async () => {
  const report = await runSelfcheck({
    explain: withTexts(["Цена от 100 000 ₸. Отличный выбор."]),
    pairwiseDistinct: null,
  });
  assertReport(report);
  assert.equal(check(report, "distinct_explanations").passed, false);
  assert.equal(check(report, "no_generic_phrases").passed, false);
});

test("all forbidden phrases are rejected regardless of case or the е/ё spelling", async (context) => {
  for (const phrase of ["ОТЛИЧНЫЙ ВЫБОР", "Идеально подойдет", "Идеально подойдёт", "Профессионал своего дела"]) {
    await context.test(phrase, async () => {
      const report = await runSelfcheck({ explain: withTexts([`${phrase}, цена от 100 000 ₸.`]) });
      assert.equal(check(report, "no_generic_phrases").passed, false);
    });
  }
});

test("the AI distinctness validator is used when available", async () => {
  let calls = 0;
  const report = await runSelfcheck({
    pairwiseDistinct(texts, result) {
      calls += 1;
      assert.equal(result.cards.length, 3);
      for (const card of result.cards) assert.equal(typeof texts[card.id], "string");
      return false;
    },
  });
  assert.ok(calls > 0);
  assert.equal(check(report, "distinct_explanations").passed, false);
});

test("fallback distinguishes whole number tokens instead of matching substrings", async () => {
  const report = await runSelfcheck({
    explain: withTexts(["Цена от 100 ₸.", "Цена от 1 000 ₸.", "Цена от 10 000 ₸."]),
    pairwiseDistinct: undefined,
  });
  assert.equal(check(report, "distinct_explanations").passed, true);
});

test("fallback treats grouped digits and ungrouped digits as the same number", async () => {
  const report = await runSelfcheck({
    explain: withTexts(["Цена от 1 000 ₸.", "Цена от 1000 ₸.", "Цена от 1\u202f000 ₸."]),
    pairwiseDistinct: null,
  });
  assert.equal(check(report, "distinct_explanations").passed, false);
});

test("fallback accepts a different quotation for every card without numbers", async () => {
  const report = await runSelfcheck({
    explain: withTexts([
      "В описании: «камерная программа».",
      "В описании: «живое общение».",
      "В описании: «музыкальный вечер».",
    ]),
    pairwiseDistinct: null,
  });
  assert.equal(check(report, "distinct_explanations").passed, true);
});

test("fallback requires a distinct number or quotation in every explanation", async () => {
  const report = await runSelfcheck({
    explain: withTexts(["Цена от 100 ₸.", "Цена от 100 ₸, до 4 ч.", "Цена от 100 ₸, до 6 ч."]),
    pairwiseDistinct: null,
  });
  assert.equal(check(report, "distinct_explanations").passed, false);
});

test("an explanation timeout returns all checks and marks latency as failed", { timeout: 3000 }, async () => {
  const started = performance.now();
  const report = await runSelfcheck({
    explain: () => new Promise(() => {}),
    timeoutMs: 30,
  });
  assertReport(report);
  assert.equal(check(report, "latency").passed, false);
  assert.equal(check(report, "distinct_explanations").passed, false);
  assert.ok(performance.now() - started < 2000, "a stuck explainer must not hold the report indefinitely");
});
