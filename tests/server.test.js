import test from "node:test";
import assert from "node:assert/strict";

process.env.LLM_API_KEY = "";
process.env.OPENAI_API_KEY = "";
const { app, withExplanations } = await import("../src/server.js");
const { recommend } = await import("../src/engine/recommend.js");
const { commonFacts, templateExplanations } = await import("../src/ai/templates.js");
const query = { city: "Алматы", date: "2026-10-17", eventType: "корпоратив", category: "Ведущий", budget: 1500000 };
const fixture = () => recommend(query);
const enriched = (result) => {
  const texts = templateExplanations(result);
  return { ...result, commonFacts: commonFacts(result), cards: result.cards.map((card) => ({
    ...card, explanation: texts[card.id], explanationSource: "llm",
  })) };
};

test("server allows AI responses after six seconds and forwards common facts", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = fixture();
  let result;
  const pending = withExplanations(original, async (engine) => {
    await new Promise((resolve) => setTimeout(resolve, 7500));
    return enriched(engine);
  }).then((value) => { result = value; });
  t.mock.timers.tick(6000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(result, undefined);
  t.mock.timers.tick(1500);
  await pending;
  assert.deepEqual(result.commonFacts, commonFacts(original));
  assert.ok(result.cards.every((card) => card.explanationSource === "llm"));
});

test("outer nine-second timeout uses the same grounded fallback as AI", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = fixture();
  const pending = withExplanations(original, () => new Promise(() => {}));
  t.mock.timers.tick(9000);
  const result = await pending;
  assert.deepEqual(result.commonFacts, commonFacts(original));
  assert.deepEqual(Object.fromEntries(result.cards.map((card) => [card.id, card.explanation])), templateExplanations(original));
  assert.ok(result.cards.every((card) => card.explanationSource === "template"));
});

test("AI failures preserve the engine contract and never produce an empty response", async () => {
  const original = fixture();
  const before = structuredClone(original);
  for (const explain of [async () => { throw new Error("offline"); }, async () => ({ cards: [] })]) {
    const result = await withExplanations(original, explain);
    assert.equal(result.cards.length, 3);
    assert.deepEqual(result.commonFacts, commonFacts(original));
    assert.deepEqual(result.excludedList, original.excludedList);
    assert.deepEqual(original, before);
  }
});

test("HTML, application assets, local icons and metadata are served", async (t) => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(baseURL);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /id="query-form"/);
  for (const path of ["/app.js", "/styles.css", "/vendor/lucide.js", "/assets/event-table.jpg"]) {
    const asset = await fetch(baseURL + path);
    assert.equal(asset.status, 200, path);
    assert.ok((await asset.arrayBuffer()).byteLength > 100, path);
  }
  const meta = await (await fetch(baseURL + "/api/meta")).json();
  assert.ok(meta.catalogue.total > 0);
  const comparison = await fetch(baseURL + "/api/compare", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, date2: "2026-12-26" }) });
  assert.equal(comparison.status, 200);
  const compared = await comparison.json();
  assert.equal(compared.a.cards.length, 3);
  assert.equal(compared.b.cards.length, 1);
  assert.ok(compared.a.cards.every((card) => card.explanation));
});
