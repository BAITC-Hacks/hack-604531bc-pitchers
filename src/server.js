import "dotenv/config";
import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogueFacets } from "./engine/data.js";
import { recommend, ValidationError } from "./engine/recommend.js";
import { agentRouter } from "./agent/router.js";
import { LlmUnavailableError } from "./agent/llm.js";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const money = (value) => `${value.toLocaleString("ru-RU")} ₸`;
const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const explanationModule = import("./ai/explain.js").catch(() => null);

const differences = {
  cheapest: () => "самая низкая стартовая цена среди показанных",
  onlyKazakh: () => "единственный из показанных с казахским языком",
  mostHours: (facts) => `самая большая длительность среди показанных — до ${facts.maxHours} ч`,
  mostSpecialized: (facts) => `самая узкая специализация среди показанных: форматов — ${facts.formats.length}`,
  onlyMentionsEventType: () => "единственный из показанных с ключевыми словами выбранного формата в описании",
  noHourLimit: () => "не привязан к длительности присутствия, в отличие от части показанных",
};

function fallbackCard(card) {
  const facts = card.facts;
  const flags = facts.flags ?? card.flags ?? {};
  const price = Number.isFinite(facts.priceFrom)
    ? `${flags.priceImputed ? "оценочная стартовая цена" : "стартовая цена"} — от ${money(facts.priceFrom)}`
    : "стартовая цена не указана";
  const budget = Number.isFinite(facts.headroomKzt)
    ? `; разница с бюджетом — ${money(facts.headroomKzt)}`
    : "";
  const first = `${flags.synthetic ? "Синтетический профиль: " : ""}${price}${budget}`;
  const difference = (facts.differentiators ?? [])
    .map((tag) => differences[tag]?.(facts))
    .find(Boolean);
  const hours = facts.maxHours === null
    ? "без привязки к длительности присутствия"
    : Number.isFinite(facts.maxHours) ? `до ${facts.maxHours} ч` : "";
  const chips = (card.factChips ?? []).filter((chip) =>
    typeof chip === "string" && chip.trim() && !chip.includes("₸") && !chip.startsWith("в описании:"),
  );
  // Prefer a real differentiator; a single card may have none to compare with.
  const detail = difference ?? chips[0] ?? hours;
  const includesHours = /\d+ ч|длительности присутствия|ограничения по часам/.test(detail);
  const extra = hours && !includesHours ? hours : "";
  const second = [detail, extra].filter(Boolean).join("; ");
  return {
    ...card,
    explanation: `${capitalize(first)}.${second ? ` ${capitalize(second)}.` : ""}`,
    explanationSource: "template",
  };
}

async function withExplanations(result) {
  if (result.cards.length === 0) return result;
  let timeout;
  try {
    const explained = await Promise.race([
      (async () => {
        const module = await explanationModule;
        if (typeof module?.explain !== "function") throw new Error("Explanation module unavailable");
        return module.explain(structuredClone(result));
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Explanation timeout")), 6000);
      }),
    ]);
    const cards = result.cards.map((card) => {
      const enriched = explained?.cards?.find((item) => item.id === card.id);
      if (typeof enriched?.explanation !== "string" || !enriched.explanation.trim() ||
          !["llm", "template", "cache"].includes(enriched.explanationSource)) {
        throw new Error("Invalid explanation result");
      }
      return { ...card, explanation: enriched.explanation, explanationSource: enriched.explanationSource };
    });
    return { ...result, cards };
  } catch {
    return { ...result, cards: result.cards.map(fallbackCard) };
  } finally {
    clearTimeout(timeout);
  }
}

export const app = express();
// Load the catalogue once at startup, so missing/invalid data fails before listening.
const facets = catalogueFacets();

app.use(express.json());
app.get("/api/meta", (_request, response) => response.json(facets));
app.post("/api/recommend", async (request, response) => {
  const started = performance.now();
  const result = await withExplanations(await recommend(request.body));
  response.json({ ...result, elapsedMs: Math.round(performance.now() - started) });
});
app.use(agentRouter);
app.use(express.static(publicPath));

app.use((error, _request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof ValidationError) {
    return response.status(400).json({ error: error.message });
  }
  if (error instanceof LlmUnavailableError) {
    return response.status(503).json({ error: error.message });
  }
  if (error.type === "entity.parse.failed") {
    return response.status(400).json({ error: "Некорректный JSON в запросе." });
  }
  if (error.type === "entity.too.large") {
    return response.status(413).json({ error: "Запрос слишком большой." });
  }
  console.error("Ошибка обработки запроса:", error.name);
  return response.status(500).json({ error: "Не удалось обработать запрос. Попробуйте ещё раз." });
});

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`Сервер запущен: http://localhost:${port}`));
}
