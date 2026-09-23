import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function stableJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
    }
    return item;
  });
}

export const hash = (value) => createHash("sha256").update(stableJson(value)).digest("hex");
export const CACHE_VERSION = 2;
export const cacheKey = (query, cardIds, model) => hash({ version: CACHE_VERSION, query, cardIds, model });

export function createCache({ filePath = fileURLToPath(new URL("../../.cache/explanations.json", import.meta.url)) } = {}) {
  let entries;
  function load() {
    if (entries) return;
    entries = Object.create(null);
    if (!filePath) return;
    try {
      const saved = JSON.parse(readFileSync(filePath, "utf8"));
      if (saved.version === CACHE_VERSION && saved.entries && typeof saved.entries === "object" && !Array.isArray(saved.entries)) {
        Object.assign(entries, saved.entries);
      }
    } catch {
      // Missing, corrupt or unreadable cache must never stop recommendations.
    }
  }
  return {
    get(key, fingerprint) {
      load();
      const entry = entries[key];
      return entry?.source === "llm" && entry.fingerprint === fingerprint ? structuredClone(entry.texts) : undefined;
    },
    set(key, fingerprint, texts, source) {
      if (source !== "llm") return false;
      load();
      entries[key] = { fingerprint, texts: structuredClone(texts), source };
      if (!filePath) return true;
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(temporary, JSON.stringify({ version: CACHE_VERSION, entries }), { encoding: "utf8", flag: "wx" });
        renameSync(temporary, filePath);
        return true;
      } catch {
        return false;
      } finally {
        try { unlinkSync(temporary); } catch { /* Already renamed or inaccessible. */ }
      }
    },
  };
}
