/**
 * Express router for the text agent. Mount it in src/server.js: app.use(agentRouter).
 */
import { Router } from "express";
import { isConfigured } from "./llm.js";
import { parseRequest } from "./parse.js";

export const agentRouter = Router();

agentRouter.get("/api/parse/status", (request, response) => {
  response.json({ available: isConfigured() });
});

agentRouter.post("/api/parse", async (request, response) => {
  const { text, partialQuery } = request.body ?? {};
  if (!String(text ?? "").trim()) {
    response.status(400).json({ error: "Пустой запрос — опишите мероприятие словами или используйте форму." });
    return;
  }

  try {
    response.json(await parseRequest(text, partialQuery));
  } catch (error) {
    response.status(error.status ?? 502).json({ error: error.message });
  }
});

export default agentRouter;
