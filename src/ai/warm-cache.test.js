import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recommend } from "../engine/recommend.js";
import { templateExplanations } from "./templates.js";
import { DEMO_SCENARIOS } from "./scenarios.js";
import { warmCache } from "./warm-cache.js";

function cacheFile(t) {
  const directory = mkdtempSync(join(tmpdir(), "pitchers-warmup-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, "explanations.json");
}

test("warmup verifies five scenarios, persists only LLM results and supports cache-only checks", async (t) => {
  const filePath = cacheFile(t);
  let calls = 0;
  const client = { chat: { completions: { create: async (body) => {
    calls += 1;
    const { query } = JSON.parse(body.messages[1].content);
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(templateExplanations(recommend(query))) } }] };
  } } } };
  const options = { filePath, log: () => {}, explainerOptions: { client, model: "test-mini", apiKey: "" } };
  assert.deepEqual(await warmCache(options), { ready: 3, empty: 2, failed: 0, total: 5 });
  assert.equal(calls, 3);
  const entries = Object.values(JSON.parse(readFileSync(filePath, "utf8")).entries);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => entry.source === "llm"));
  assert.deepEqual(await warmCache({ ...options, explainerOptions: { model: "test-mini", apiKey: "" } }),
    { ready: 3, empty: 2, failed: 0, total: 5 });
  await warmCache({ ...options, refresh: true });
  assert.equal(calls, 6);
});

test("warmup without credentials fails honestly and never persists a fallback", async (t) => {
  const filePath = cacheFile(t);
  const lines = [];
  assert.deepEqual(await warmCache({ filePath, explainerOptions: { apiKey: "" }, log: (line) => lines.push(line) }),
    { ready: 0, empty: 2, failed: 3, total: 5 });
  assert.equal(existsSync(filePath), false);
  assert.ok(lines.some((line) => line.includes("Прогрев НЕ завершён")));
});

test("warmup rejects an LLM response that was never persisted", async (t) => {
  const directory = cacheFile(t);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(directory, "not a directory");
  const scenario = DEMO_SCENARIOS[0];
  const client = { chat: { completions: { create: async () => ({ choices: [{ finish_reason: "stop",
    message: { content: JSON.stringify(templateExplanations(recommend(scenario.query))) },
  }] }) } } };
  const result = await warmCache({ filePath: join(directory, "impossible.json"), scenarios: [scenario],
    explainerOptions: { client, apiKey: "" }, log: () => {},
  });
  assert.equal(result.failed, 1);
  assert.equal(result.ready, 0);
});
