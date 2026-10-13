// Workspace settings: one small JSON file (var/settings.json).
//
// Everything here has a safe default so a fresh install works without a
// settings file. validateSettings() is pure; the store does the file I/O.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const CATALOGUE_GROUPS = [
  "Merchant Bar", "Structural Sections", "Hollow Sections", "Plate & Sheet", "Bright Bar", "Reinforcing", "Wire & Rod", "Stainless",
];

export const SETTINGS_DEFAULTS = {
  companyName: "",
  defaultCategory: "",
  defaultLeadTimeWeeks: null,
  defaultMoqT: null,
  defaultSafetyStockT: 0,
  defaultTargetCoverMonths: 3,
  catalogueGroups: CATALOGUE_GROUPS,
};

const LIMITS = {
  defaultLeadTimeWeeks: [0, 104],
  defaultMoqT: [0, 10_000],
  defaultSafetyStockT: [0, 10_000],
  defaultTargetCoverMonths: [0.5, 36],
};

const numOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

export function validateSettings(raw = {}, current = SETTINGS_DEFAULTS) {
  const s = { ...SETTINGS_DEFAULTS, ...current };
  const errors = {};
  if ("companyName" in raw) s.companyName = String(raw.companyName || "").trim().slice(0, 80);
  if ("defaultCategory" in raw) s.defaultCategory = String(raw.defaultCategory || "").trim().slice(0, 80);
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!(key in raw)) continue;
    const n = numOrNull(raw[key]);
    if (n === null && key !== "defaultTargetCoverMonths") { s[key] = key === "defaultSafetyStockT" ? 0 : null; continue; }
    if (!Number.isFinite(n) || n < min || n > max) errors[key] = `Use ${min}–${max}.`;
    else s[key] = n;
  }
  if ("catalogueGroups" in raw) {
    const groups = Array.isArray(raw.catalogueGroups) ? raw.catalogueGroups.filter((g) => CATALOGUE_GROUPS.includes(g)) : [];
    if (!groups.length) errors.catalogueGroups = "Pick at least one product group.";
    else s.catalogueGroups = CATALOGUE_GROUPS.filter((g) => groups.includes(g));
  }
  return { settings: s, errors, valid: Object.keys(errors).length === 0 };
}

export function createSettingsStore(dataDir, fileName = "settings.json") {
  const file = join(dataDir, fileName);
  let cache = null;
  let writing = Promise.resolve();
  async function get() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(await readFile(file, "utf8"));
      cache = { ...validateSettings(raw).settings, updatedAt: raw.updatedAt || null, updatedBy: raw.updatedBy || null };
    } catch {
      cache = { ...SETTINGS_DEFAULTS };
    }
    return cache;
  }
  async function save(next, by) {
    cache = { ...next, updatedAt: new Date().toISOString(), updatedBy: by };
    writing = writing.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(cache, null, 2));
      await rename(tmp, file);
    });
    await writing;
    return cache;
  }
  return { get, save };
}
