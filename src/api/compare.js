/**
 * Express router for date comparison. Mount it in src/server.js: app.use(compareRouter).
 * Explanations are a bonus here: if src/ai fails, the comparison still answers.
 */
import { Router } from "express";
import { explain } from "../ai/explain.js";
import { compareDates } from "../engine/compare.js";

export const compareRouter = Router();

/** Never let the explanation layer break the comparison. */
async function withExplanations(result) {
  try {
    return await explain(result);
  } catch {
    return result;
  }
}

compareRouter.post("/api/compare", async (request, response, next) => {
  const started = performance.now();
  const { query, date2 } = request.body ?? {};

  let compared;
  try {
    compared = compareDates(query, date2);
  } catch (error) {
    if (error.status === 400) {
      response.status(400).json({ error: error.message });
      return;
    }
    next(error);
    return;
  }

  const [a, b] = await Promise.all([withExplanations(compared.a), withExplanations(compared.b)]);
  response.json({ ...compared, a, b, elapsedMs: Math.round(performance.now() - started) });
});

export default compareRouter;
