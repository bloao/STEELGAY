// Workspace settings: one small JSON file (var/settings.json).
//
// Everything here has a safe default so a fresh install works without a
// settings file. validateSettings() is pure; the store does the file I/O.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { APPROACH_DEFAULTS } from "./orderplan.mjs";

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
  costOfCapitalPct: 8,
  // UK CBAM values come from UK_CBAM below (fixed, not settings)
  forecastStoragePerTMonth: 2, // £ per tonne per month to hold extra stock
  // Order planner: cost assumptions
  deliveryPerT: 0, // £/t delivery to you when the supplier charges it on top
  splitOrderCost: 150, // £ admin, booking and inspection for each extra order when splitting
  // Order planner: each approach (cash flow, speed, balanced) has its own
  // weights and thresholds; see lib/orderplan.mjs
  approaches: JSON.parse(JSON.stringify(APPROACH_DEFAULTS)),
  // Warnings, whatever the approach
  staleQuoteDays: 30,
  onTimeWarnPct: 75,
  quotaWarnProbPct: 25,
  importSurgePct: 25, // UK imports this far above normal = buyers stocking up
  metalsApiKey: "",
  companiesHouseApiKey: "",
  aisstreamApiKey: "",
  // Assistant: which model answers ("auto" picks Claude, then Groq, Gemini, Ollama)
  assistantProvider: "auto",
  groqApiKey: "",
  geminiApiKey: "",
  ollamaModel: "qwen2.5:7b",
  catalogueGroups: CATALOGUE_GROUPS,
};

const LIMITS = {
  defaultLeadTimeWeeks: [0, 104],
  defaultMoqT: [0, 10_000],
  defaultSafetyStockT: [0, 10_000],
  defaultTargetCoverMonths: [0.5, 36],
  costOfCapitalPct: [0, 30],
  forecastStoragePerTMonth: [0, 50],
  deliveryPerT: [0, 500],
  splitOrderCost: [0, 5000],
  staleQuoteDays: [1, 365],
  onTimeWarnPct: [0, 100],
  quotaWarnProbPct: [0, 100],
  importSurgePct: [0, 500],
};

// The numbers the order planner runs on, in the order the page shows them.
// UK CBAM: set by regulation, not by you. The rate is published by HMRC each
// quarter from 1 January 2027 and the steel default values before then; until
// they are, these placeholders stand in. Change them here, in code, when HMRC
// publishes. The settings file can't override them.
export const UK_CBAM = {
  status: "awaiting", // "awaiting" until HMRC publishes, then "published"
  source: "Finance Act 2026 Part 2; HMRC CBAM notices",
  cbamRatePerT: 62, // £/t CO2e placeholder: UK ETS allowance price, no free-allocation cut
  cbamEafTPerT: 0.5,
  cbamBofTPerT: 2.0,
  cbamUnknownTPerT: 2.0,
  forecastCbamPassThroughPct: 30, // model, not regulation: share of CBAM cost UK prices absorb
};
export const CBAM_KEYS = ["cbamRatePerT", "cbamEafTPerT", "cbamBofTPerT", "cbamUnknownTPerT", "forecastCbamPassThroughPct"];
for (const k of ["cbamRatePerT", "cbamEafTPerT", "cbamBofTPerT", "cbamUnknownTPerT", "forecastCbamPassThroughPct"]) SETTINGS_DEFAULTS[k] = UK_CBAM[k];

export const PLAN_ASSUMPTION_KEYS = [
  "costOfCapitalPct", "deliveryPerT", "forecastStoragePerTMonth", "splitOrderCost",
  "staleQuoteDays", "onTimeWarnPct", "quotaWarnProbPct", "importSurgePct",
];
export const APPROACH_LIMITS = {
  quotaWeightPct: [0, 100], stockOutPerDayPct: [0, 5], cashRatePct: [0, 50], leadDayPct: [0, 1], reliabilityPct: [0, 1],
  buyAheadTriggerPct: [0, 25], buyAheadMinSaving: [0, 1_000_000], holdMinScore: [0, 100], waitTriggerPct: [0, 25], waitCoverBufferMonths: [0, 12],
};
export const ASSUMPTION_LIMITS = { ...Object.fromEntries(PLAN_ASSUMPTION_KEYS.map((k) => [k, LIMITS[k]])), ...APPROACH_LIMITS };
const NULLABLE = new Set(["defaultLeadTimeWeeks", "defaultMoqT", "defaultSafetyStockT"]);

const numOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

export function validateSettings(raw = {}, current = SETTINGS_DEFAULTS) {
  const s = { ...SETTINGS_DEFAULTS, ...current };
  const errors = {};
  if ("companyName" in raw) s.companyName = String(raw.companyName || "").trim().slice(0, 80);
  if ("metalsApiKey" in raw && !String(raw.metalsApiKey || "").includes("•")) {
    s.metalsApiKey = String(raw.metalsApiKey || "").trim().slice(0, 120);
    if (s.metalsApiKey && !/^[A-Za-z0-9_-]{8,120}$/.test(s.metalsApiKey)) errors.metalsApiKey = "That doesn't look like a Metals-API key.";
  }
  if ("companiesHouseApiKey" in raw && !String(raw.companiesHouseApiKey || "").includes("•")) {
    s.companiesHouseApiKey = String(raw.companiesHouseApiKey || "").trim().slice(0, 80);
    if (s.companiesHouseApiKey && !/^[A-Za-z0-9-]{20,80}$/.test(s.companiesHouseApiKey)) errors.companiesHouseApiKey = "That doesn't look like a Companies House API key.";
  }
  if ("assistantProvider" in raw) {
    const v = String(raw.assistantProvider || "auto");
    if (["auto", "anthropic", "ollama", "groq", "gemini"].includes(v)) s.assistantProvider = v; else errors.assistantProvider = "Pick one of the listed options.";
  }
  if ("groqApiKey" in raw && !String(raw.groqApiKey || "").includes("•")) {
    s.groqApiKey = String(raw.groqApiKey || "").trim().slice(0, 120);
    if (s.groqApiKey && !/^gsk_[A-Za-z0-9]{20,}$/.test(s.groqApiKey)) errors.groqApiKey = "Groq keys start with gsk_.";
  }
  if ("geminiApiKey" in raw && !String(raw.geminiApiKey || "").includes("•")) {
    s.geminiApiKey = String(raw.geminiApiKey || "").trim().slice(0, 120);
    if (s.geminiApiKey && !/^[A-Za-z0-9_-]{30,}$/.test(s.geminiApiKey)) errors.geminiApiKey = "That doesn't look like a Gemini API key.";
  }
  if ("ollamaModel" in raw) {
    s.ollamaModel = String(raw.ollamaModel || "").trim().slice(0, 60) || "qwen2.5:7b";
    if (!/^[A-Za-z0-9._:/-]+$/.test(s.ollamaModel)) errors.ollamaModel = "Use a model name like qwen2.5:7b.";
  }
  if ("aisstreamApiKey" in raw && !String(raw.aisstreamApiKey || "").includes("•")) {
    s.aisstreamApiKey = String(raw.aisstreamApiKey || "").trim().slice(0, 100);
    if (s.aisstreamApiKey && !/^[A-Za-z0-9-]{16,100}$/.test(s.aisstreamApiKey)) errors.aisstreamApiKey = "That doesn't look like an aisstream.io API key.";
  }
  if ("defaultCategory" in raw) s.defaultCategory = String(raw.defaultCategory || "").trim().slice(0, 80);
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!(key in raw)) continue;
    const n = numOrNull(raw[key]);
    if (n === null && NULLABLE.has(key)) { s[key] = key === "defaultSafetyStockT" ? 0 : null; continue; }
    if (!Number.isFinite(n) || n < min || n > max) errors[key] = `Use ${min}–${max}.`;
    else s[key] = n;
  }
  // per-approach weights and thresholds; a partial update merges
  s.approaches = Object.fromEntries(Object.keys(APPROACH_DEFAULTS).map((ap) => [ap, { ...APPROACH_DEFAULTS[ap], ...((current.approaches || {})[ap] || {}) }]));
  if (raw.approaches && typeof raw.approaches === "object") {
    for (const [ap, vals] of Object.entries(raw.approaches)) {
      if (!APPROACH_DEFAULTS[ap] || !vals || typeof vals !== "object") continue;
      for (const [k, v] of Object.entries(vals)) {
        if (!APPROACH_LIMITS[k]) continue;
        const n = numOrNull(v);
        const [min, max] = APPROACH_LIMITS[k];
        if (!Number.isFinite(n) || n < min || n > max) errors[`approaches.${ap}.${k}`] = `Use ${min}–${max}.`;
        else s.approaches[ap][k] = n;
      }
    }
  }
  if ("catalogueGroups" in raw) {
    const groups = Array.isArray(raw.catalogueGroups) ? raw.catalogueGroups.filter((g) => CATALOGUE_GROUPS.includes(g)) : [];
    if (!groups.length) errors.catalogueGroups = "Pick at least one product group.";
    else s.catalogueGroups = CATALOGUE_GROUPS.filter((g) => groups.includes(g));
  }
  return { settings: s, errors, valid: Object.keys(errors).length === 0 };
}

// What the browser sees: never the full key.
export function publicSettings(s) {
  const k = s.metalsApiKey || "";
  const ch = s.companiesHouseApiKey || "";
  return { ...s, metalsApiKey: k ? `••••${k.slice(-4)}` : "", hasMetalsApiKey: Boolean(k), companiesHouseApiKey: ch ? `••••${ch.slice(-4)}` : "", hasCompaniesHouseKey: Boolean(ch), aisstreamApiKey: s.aisstreamApiKey ? `••••${s.aisstreamApiKey.slice(-4)}` : "", hasAisKey: Boolean(s.aisstreamApiKey),
    groqApiKey: s.groqApiKey ? `••••${s.groqApiKey.slice(-4)}` : "", hasGroqKey: Boolean(s.groqApiKey), geminiApiKey: s.geminiApiKey ? `••••${s.geminiApiKey.slice(-4)}` : "", hasGeminiKey: Boolean(s.geminiApiKey) };
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
