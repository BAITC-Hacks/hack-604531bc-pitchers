/**
 * Deterministic scoring: no LLM, no randomness, no time-dependent input.
 * All components live in 0..1 and are rounded to 4 decimals before weighting.
 * Keyword stems and weights come from config/domain.json.
 */
import { KEYWORDS, WEIGHTS } from "./config.js";

export { KEYWORDS, WEIGHTS };

const round4 = (value) => Math.round(value * 1e4) / 1e4;
const clamp01 = (value) => Math.min(1, Math.max(0, value));

/** Stems of `eventType` literally present in the description; also feeds facts.matchedKeywords. */
export function matchKeywords(description, eventType) {
  const stems = KEYWORDS[String(eventType ?? "").trim().toLowerCase()] ?? [];
  const haystack = String(description ?? "").toLowerCase();
  return stems.filter((stem) => haystack.includes(stem));
}

function relevanceOf(contractor, query) {
  const stems = KEYWORDS[String(query.eventType ?? "").trim().toLowerCase()] ?? [];
  if (stems.length === 0) return 0;
  return matchKeywords(contractor.description, query.eventType).length / stems.length;
}

function budgetOf(contractor, query) {
  // An unknown price is not evidence of a bargain: stay neutral instead of inventing headroom.
  if (contractor.priceFrom === null || !(query.budget > 0)) return 0.5;
  return clamp01(1 - contractor.priceFrom / query.budget);
}

function hoursOf(contractor, query) {
  if (!(query.hours > 0)) return 0.5;
  if (contractor.maxHours === null) return 1;
  return clamp01((contractor.maxHours - query.hours) / query.hours + 0.5);
}

function dataQualityOf(contractor) {
  const { synthetic, cityImputed, priceImputed } = contractor.flags;
  if (synthetic) return 0;
  if (cityImputed || priceImputed) return 0.5;
  return 1;
}

/**
 * Specialization is relative: `1 / formats.length` min-max normalized across the pool,
 * so the narrowest profile among the shown candidates gets 1.
 * When every candidate covers the same number of formats the component cannot
 * separate them, so all get 1 — uniform, therefore never changes the order.
 */
function specializationScale(candidates) {
  const raw = candidates.map((contractor) => 1 / Math.max(1, contractor.formats.length));
  const min = Math.min(...raw);
  const max = Math.max(...raw);
  return (contractor) => {
    const value = 1 / Math.max(1, contractor.formats.length);
    return max === min ? 1 : (value - min) / (max - min);
  };
}

/**
 * @param {Contractor[]} candidates contractors that passed all hard filters
 * @param {Query} query
 * @returns {{ contractor: Contractor, score: number, scoreParts: object, matchedKeywords: string[] }[]}
 *          sorted by score desc, ties broken by id asc
 */
export function scoreCandidates(candidates, query) {
  const specializationOf = specializationScale(candidates);

  const scored = candidates.map((contractor) => {
    const scoreParts = {
      relevance: round4(clamp01(relevanceOf(contractor, query))),
      budget: round4(budgetOf(contractor, query)),
      specialization: round4(clamp01(specializationOf(contractor))),
      hours: round4(hoursOf(contractor, query)),
      dataQuality: round4(dataQualityOf(contractor)),
    };
    const score = round4(
      Object.entries(WEIGHTS).reduce((sum, [part, weight]) => sum + scoreParts[part] * weight, 0),
    );
    return { contractor, score, scoreParts, matchedKeywords: matchKeywords(contractor.description, query.eventType) };
  });

  return scored.sort((a, b) =>
    b.score - a.score || (a.contractor.id < b.contractor.id ? -1 : a.contractor.id > b.contractor.id ? 1 : 0),
  );
}
