/**
 * Domain tuning lives in config/domain.json, not in the code:
 * keyword stems per event type, scoring weights and the order of hard filters.
 * Swapping the CSV and this file retargets the engine to another niche.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CONFIG_FILE = fileURLToPath(new URL("../../config/domain.json", import.meta.url));

function load() {
  let config;
  try {
    config = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (error) {
    throw new Error(`config/domain.json is not readable: ${error.message}`);
  }

  const { keywords, weights, filterOrder } = config;
  if (!keywords || typeof keywords !== "object") throw new Error("config/domain.json: missing `keywords`");
  for (const [eventType, stems] of Object.entries(keywords)) {
    if (!Array.isArray(stems) || stems.length === 0) {
      throw new Error(`config/domain.json: keywords["${eventType}"] must be a non-empty array`);
    }
  }

  if (!weights || typeof weights !== "object") throw new Error("config/domain.json: missing `weights`");
  const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(total - 1) > 1e-9) {
    throw new Error(`config/domain.json: weights must sum to 1, got ${total}`);
  }

  if (!Array.isArray(filterOrder) || filterOrder.length === 0) {
    throw new Error("config/domain.json: missing `filterOrder`");
  }

  return { keywords, weights, filterOrder };
}

const config = load();

/** Lowercase stems per event type. */
export const KEYWORDS = config.keywords;

/** Score component weights; they always sum to 1. */
export const WEIGHTS = config.weights;

/** Hard filters in the order they are applied; the first failed one becomes the reason. */
export const FILTER_ORDER = config.filterOrder;
