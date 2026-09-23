/**
 * Hard filters. Every excluded contractor gets exactly one reason:
 * the FIRST check it fails, in the order defined by config/domain.json.
 */
import { FILTER_ORDER } from "./config.js";

const norm = (value) => String(value ?? "").trim().toLowerCase();
const isPositiveNumber = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const includesNorm = (list, value) => list.some((item) => norm(item) === norm(value));

/**
 * Each check runs only when its input is present in the query; otherwise it is skipped,
 * so an absent `language`/`hours` can never exclude anyone.
 */
const CHECKS = {
  busy: {
    enabled: (query) => Boolean(query.date),
    fails: (contractor, query) => contractor.busyDates.has(query.date),
  },
  over_budget: {
    enabled: (query) => isPositiveNumber(query.budget),
    fails: (contractor, query) => contractor.priceFrom !== null && contractor.priceFrom > query.budget,
  },
  format: {
    enabled: (query) => Boolean(query.eventType),
    fails: (contractor, query) => !includesNorm(contractor.formats, query.eventType),
  },
  language: {
    enabled: (query) => Boolean(query.language),
    fails: (contractor, query) => !includesNorm(contractor.languages, query.language),
  },
  hours: {
    enabled: (query) => isPositiveNumber(query.hours),
    fails: (contractor, query) => contractor.maxHours !== null && contractor.maxHours < query.hours,
  },
};

const unknown = FILTER_ORDER.filter((reason) => !(reason in CHECKS));
if (unknown.length > 0) {
  throw new Error(`config/domain.json: unknown filters in filterOrder: ${unknown.join(", ")}`);
}

/**
 * Order is part of the contract: with the default config a contractor who is both busy
 * and over budget is reported as `busy`.
 */
export const FILTER_REASONS = [...FILTER_ORDER];

const ORDERED_CHECKS = FILTER_REASONS.map((reason) => ({ reason, ...CHECKS[reason] }));

/**
 * @param {Contractor[]} candidates already narrowed down by city + category
 * @param {Query} query
 * @returns {{ passed: Contractor[], excluded: { contractor: Contractor, reason: string }[] }}
 */
export function applyFilters(candidates, query) {
  const checks = ORDERED_CHECKS.filter((check) => check.enabled(query));
  const passed = [];
  const excluded = [];

  for (const contractor of candidates) {
    const failed = checks.find((check) => check.fails(contractor, query));
    if (failed) excluded.push({ contractor, reason: failed.reason });
    else passed.push(contractor);
  }

  return { passed, excluded };
}

/** Counts per reason, all keys always present (EngineResult.excluded). */
export function countExcluded(excluded) {
  const counts = Object.fromEntries(FILTER_REASONS.map((reason) => [reason, 0]));
  for (const { reason } of excluded) counts[reason] += 1;
  return counts;
}

/** True when the contractor passes every enabled check — used by hints (nearest date, min budget). */
export function passesAll(contractor, query) {
  return !ORDERED_CHECKS.some((check) => check.enabled(query) && check.fails(contractor, query));
}
