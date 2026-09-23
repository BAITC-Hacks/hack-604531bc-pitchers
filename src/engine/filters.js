/**
 * Hard filters. Every excluded contractor gets exactly one reason:
 * the FIRST check it fails, in the order below.
 */

/** Order is part of the contract: a contractor busy AND over budget is reported as `busy`. */
export const FILTER_REASONS = ["busy", "over_budget", "format", "language", "hours"];

const norm = (value) => String(value ?? "").trim().toLowerCase();
const isPositiveNumber = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
const includesNorm = (list, value) => list.some((item) => norm(item) === norm(value));

/**
 * Each check runs only when its input is present in the query; otherwise it is skipped,
 * so an absent `language`/`hours` can never exclude anyone.
 */
const CHECKS = [
  {
    reason: "busy",
    enabled: (query) => Boolean(query.date),
    fails: (contractor, query) => contractor.busyDates.has(query.date),
  },
  {
    reason: "over_budget",
    enabled: (query) => isPositiveNumber(query.budget),
    fails: (contractor, query) => contractor.priceFrom !== null && contractor.priceFrom > query.budget,
  },
  {
    reason: "format",
    enabled: (query) => Boolean(query.eventType),
    fails: (contractor, query) => !includesNorm(contractor.formats, query.eventType),
  },
  {
    reason: "language",
    enabled: (query) => Boolean(query.language),
    fails: (contractor, query) => !includesNorm(contractor.languages, query.language),
  },
  {
    reason: "hours",
    enabled: (query) => isPositiveNumber(query.hours),
    fails: (contractor, query) => contractor.maxHours !== null && contractor.maxHours < query.hours,
  },
];

/**
 * @param {Contractor[]} candidates already narrowed down by city + category
 * @param {Query} query
 * @returns {{ passed: Contractor[], excluded: { contractor: Contractor, reason: string }[] }}
 */
export function applyFilters(candidates, query) {
  const checks = CHECKS.filter((check) => check.enabled(query));
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
  return !CHECKS.some((check) => check.enabled(query) && check.fails(contractor, query));
}
