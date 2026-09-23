/**
 * Loading and normalization of the contractor catalogue.
 * Source of truth: data/contractors.csv (never edited), plus optional data/synthetic.csv.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "csv-parse/sync";

/** Calendars in the dataset cover only this window; a date outside it is a validation error. */
export const DATE_WINDOW = { min: "2026-09-23", max: "2026-12-31" };

const REQUIRED_COLUMNS = [
  "id",
  "anon_name",
  "categories",
  "city",
  "city_imputed",
  "synthetic",
  "price_from_kzt",
  "price_imputed",
  "event_formats",
  "languages",
  "max_hours",
  "busy_dates",
  "description",
];

const DEFAULT_DATASETS = [
  { file: "data/contractors.csv", required: true, syntheticDefault: false },
  { file: "data/synthetic.csv", required: false, syntheticDefault: true },
];

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TRUE_VALUES = new Set(["true", "1", "yes", "y"]);

const projectPath = (file) => fileURLToPath(new URL(`../../${file}`, import.meta.url));

function text(value) {
  return String(value ?? "").trim();
}

function toBool(value, fallback) {
  const raw = text(value).toLowerCase();
  return raw ? TRUE_VALUES.has(raw) : fallback;
}

/** "a|b|a" -> ["a", "b"], order preserved, empties and duplicates dropped. */
function toList(value) {
  return [...new Set(text(value).split("|").map(text).filter(Boolean))];
}

function toInt(value, field, id) {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${id}: invalid ${field} "${raw}"`);
  }
  return Math.round(parsed);
}

function toDateSet(value, id) {
  const dates = toList(value);
  for (const date of dates) {
    if (!DATE_PATTERN.test(date)) {
      throw new Error(`${id}: invalid busy date "${date}", expected YYYY-MM-DD`);
    }
  }
  return new Set(dates.sort());
}

function normalize(row, syntheticDefault) {
  const id = text(row.id);
  if (!id) throw new Error("row without id in the dataset");

  const name = text(row.anon_name);
  const city = text(row.city);
  const categories = toList(row.categories);
  if (!name) throw new Error(`${id}: empty anon_name`);
  if (!city) throw new Error(`${id}: empty city`);
  if (categories.length === 0) throw new Error(`${id}: empty categories`);

  return {
    id,
    name,
    categories,
    city,
    priceFrom: toInt(row.price_from_kzt, "price_from_kzt", id),
    formats: toList(row.event_formats),
    languages: toList(row.languages),
    maxHours: toInt(row.max_hours, "max_hours", id), // null = not tied to presence
    busyDates: toDateSet(row.busy_dates, id),
    description: text(row.description),
    flags: {
      synthetic: toBool(row.synthetic, syntheticDefault),
      cityImputed: toBool(row.city_imputed, false),
      priceImputed: toBool(row.price_imputed, false),
    },
  };
}

function readDataset({ file, syntheticDefault }) {
  const rows = parse(readFileSync(projectPath(file), "utf8"), {
    columns: true,
    bom: true,
    skip_empty_lines: true,
    trim: true,
  });
  if (rows.length === 0) return [];

  const missing = REQUIRED_COLUMNS.filter((column) => !(column in rows[0]));
  if (missing.length > 0) {
    throw new Error(`${file}: missing columns ${missing.join(", ")}`);
  }
  return rows.map((row) => normalize(row, syntheticDefault));
}

/**
 * Reads the catalogue from disk and returns normalized contractors sorted by id.
 * @param {{ datasets?: typeof DEFAULT_DATASETS }} [options]
 * @returns {Contractor[]}
 */
export function loadContractors(options = {}) {
  const datasets = options.datasets ?? DEFAULT_DATASETS;
  const byId = new Map();

  for (const dataset of datasets) {
    if (!dataset.required && !existsSync(projectPath(dataset.file))) continue;
    for (const contractor of readDataset(dataset)) {
      if (byId.has(contractor.id)) {
        throw new Error(`${dataset.file}: duplicate id ${contractor.id}`);
      }
      byId.set(contractor.id, contractor);
    }
  }

  if (byId.size === 0) throw new Error("catalogue is empty");
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

let cached = null;

/** Same data as loadContractors(), read from disk once per process. */
export function getContractors() {
  if (cached === null) cached = loadContractors();
  return cached;
}

/** Unique sorted values across the catalogue, used by /api/meta and by the engine. */
export function catalogueFacets(contractors = getContractors()) {
  const collect = (pick) => [...new Set(contractors.flatMap(pick))].sort((a, b) => a.localeCompare(b, "ru"));
  return {
    cities: collect((c) => [c.city]),
    categories: collect((c) => c.categories),
    eventTypes: collect((c) => c.formats),
    languages: collect((c) => c.languages),
    dateRange: { ...DATE_WINDOW },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const contractors = loadContractors();
  const facets = catalogueFacets(contractors);
  const countBy = (pick) => {
    const counts = new Map();
    for (const contractor of contractors) {
      for (const key of pick(contractor)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const byCategory = countBy((c) => c.categories);

  console.log(`Профилей: ${contractors.length}`);
  console.log(`Категорий: ${facets.categories.length}`);
  for (const category of facets.categories) {
    console.log(`  ${category} — ${byCategory.get(category)}`);
  }
  const byCity = countBy((c) => [c.city]);
  console.log(`Города: ${facets.cities.map((city) => `${city} (${byCity.get(city)})`).join(", ")}`);
  const synthetic = contractors.filter((c) => c.flags.synthetic).length;
  const cityImputed = contractors.filter((c) => c.flags.cityImputed).length;
  const priceImputed = contractors.filter((c) => c.flags.priceImputed).length;
  console.log(`Синтетических: ${synthetic}, город уточнён: ${cityImputed}, цена оценочная: ${priceImputed}`);
}
