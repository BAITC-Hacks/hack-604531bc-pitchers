/**
 * Shared LLM client. Every teammate uses their OWN key from .env, which is never committed.
 */
import OpenAI from "openai";
import "dotenv/config";

/** Raised when the agent cannot run at all; the UI falls back to the plain form. */
export class LlmUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "LlmUnavailableError";
    this.status = 503;
  }
}

export const MODEL = process.env.LLM_MODEL || "";

export const isConfigured = () => Boolean(process.env.LLM_API_KEY && MODEL);

let client = null;

export function getClient() {
  if (!isConfigured()) {
    throw new LlmUnavailableError(
      "Распознавание текста недоступно: не настроен LLM_API_KEY или LLM_MODEL. Используйте форму.",
    );
  }
  if (client === null) {
    client = new OpenAI({
      apiKey: process.env.LLM_API_KEY,
      baseURL: process.env.LLM_BASE_URL || undefined,
    });
  }
  return client;
}
