import "dotenv/config";
import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import { catalogueFacets, getContractors } from "./engine/data.js";
import { commonFacts, templateExplanations } from "./ai/templates.js";
import { recommend, ValidationError } from "./engine/recommend.js";
import { agentRouter } from "./agent/router.js";
import { selfcheckRouter } from "./api/selfcheck.js";
import { compareRouter } from "./api/compare.js";
import { LlmUnavailableError } from "./agent/llm.js";

const publicPath = fileURLToPath(new URL("../public/", import.meta.url));
const explanationModule = import("./ai/explain.js").catch(() => null);

async function resolveExplanations(result) {
  const module = await explanationModule;
  if (typeof module?.explain !== "function") throw new Error("Explanation module unavailable");
  return module.explain(result);
}

export async function withExplanations(result, explainResult = resolveExplanations) {
  if (result.cards.length === 0) return result;
  let timeout;
  try {
    const explained = await Promise.race([
      explainResult(structuredClone(result)),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Explanation timeout")), 9000);
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
    return { ...result, commonFacts: explained.commonFacts ?? commonFacts(result), cards };
  } catch {
    const texts = templateExplanations(result);
    return { ...result, commonFacts: commonFacts(result), cards: result.cards.map((card) => ({
      ...card, explanation: texts[card.id], explanationSource: "template",
    })) };
  } finally {
    clearTimeout(timeout);
  }
}

export const app = express();
// Load the catalogue once at startup, so missing/invalid data fails before listening.
const facets = { ...catalogueFacets(), catalogue: { total: getContractors().length } };

app.use(express.json());
app.get("/api/meta", (_request, response) => response.json(facets));
app.post("/api/recommend", async (request, response) => {
  const started = performance.now();
  const result = await withExplanations(await recommend(request.body));
  response.json({ ...result, elapsedMs: Math.round(performance.now() - started) });
});
app.use(agentRouter);
app.use(selfcheckRouter);
app.use(compareRouter);
app.get("/vendor/lucide.js", (_request, response) => {
  response.sendFile(fileURLToPath(new URL("../node_modules/lucide/dist/umd/lucide.min.js", import.meta.url)));
});
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
