// Steel order landed-cost engine.
//
// Pure functions only: no network, no clock reads except through `asOf`.
// The server gathers market data (tariff measures, quota rows, FX) and passes
// it in, so every result can be reproduced later from the saved snapshot.

import { EXCLUDED_ORIGINS, isRemovedFromScope, lineFor, namedOriginsFor } from "./steel-measure.mjs";

export const ENGINE_VERSION = "1.1.0";

export const DEFAULT_SETTINGS = {
  outOfQuotaDutyRate: 0.5, // UK steel measure from 1 July 2026
  importVatRate: 0.2,
  cbamStartDate: "2027-01-01",
  // Quota burn is projected linearly from usage so far in the period. Real
  // burn varies, so we spread the projected rate +/- this share and average
  // the 50% charge across that range to get an expected value.
  burnUncertainty: 0.5,
  burnSamples: 41,
};

export const INCOTERMS = ["EXW", "FCA", "FOB", "CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"];
const FREIGHT_IN_PRICE = new Set(["CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"]);
const INSURANCE_IN_PRICE = new Set(["CIF", "CIP", "DAP", "DPU", "DDP"]);
const DELIVERED_TO_SITE = new Set(["DAP", "DPU", "DDP"]);
export const CURRENCIES = ["GBP", "EUR", "USD"];
export const ORIGIN_DEFS = [
  { name: "United Kingdom", iso: "GB", aliases: ["United Kingdom"] },
  { name: "European Union", iso: "1013", aliases: ["European Union"] },
  { name: "Turkey", iso: "TR", aliases: ["Turkey", "Türkiye", "Turkiye"] },
  { name: "India", iso: "IN", aliases: ["India"] },
  { name: "China", iso: "CN", aliases: ["China"] },
  { name: "South Korea", iso: "KR", aliases: ["South Korea", "Korea, Republic of", "Korea, Republic of (South Korea)", "Republic of Korea"] },
  { name: "Vietnam", iso: "VN", aliases: ["Vietnam", "Viet Nam"] },
  { name: "Taiwan", iso: "TW", aliases: ["Taiwan", "Chinese Taipei"] },
  { name: "Japan", iso: "JP", aliases: ["Japan"] },
  { name: "Ukraine", iso: "UA", aliases: ["Ukraine"] },
  { name: "United States", iso: "US", aliases: ["United States", "United States of America", "USA"] },
  { name: "Switzerland", iso: "CH", aliases: ["Switzerland"] },
  { name: "United Arab Emirates", iso: "AE", aliases: ["United Arab Emirates", "UAE"] },
  { name: "Other non-UK", iso: null, aliases: [] },
];
export const ORIGINS = ORIGIN_DEFS.map((o) => o.name);

const norm = (v) => String(v || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

// True when a geography label / id names this origin (handles GOV.UK's
// alternative spellings such as "Türkiye" or "Korea, Republic of").
export function originMatches(origin, { id, description } = {}) {
  const def = ORIGIN_DEFS.find((o) => o.name === origin);
  if (!def) return false;
  if (def.iso && id && String(id) === def.iso) return true;
  const d = norm(description);
  if (!d) return false;
  if (def.name === "Taiwan") return d.includes("taiwan") || d.includes("taipei");
  return def.aliases.some((a) => norm(a) === d || d.startsWith(`${norm(a)} (`));
}

// UK tariff measure type ids we price.
export const MEASURE_TYPES = {
  thirdCountry: "103",
  preference: "142",
  nonPrefQuota: "122",
  prefQuota: "143",
  tradeRemedies: ["551", "552", "553", "554"],
};

const DAY_MS = 86_400_000;

function num(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / DAY_MS);
}

function round2(value) {
  return value === null || value === undefined ? null : Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------- validation

export function validateInputs(raw = {}) {
  const errors = {};
  const inputs = {
    title: String(raw.title || "").trim().slice(0, 120),
    commodityCode: String(raw.commodityCode || "").replace(/\s+/g, ""),
    commodityDescription: String(raw.commodityDescription || "").trim().slice(0, 300),
    spec: String(raw.spec || "").trim().slice(0, 200),
    origin: String(raw.origin || "").trim(),
    tonnage: num(raw.tonnage),
    importDate: String(raw.importDate || "").trim(),
    supplier: String(raw.supplier || "").trim().slice(0, 120),
    mill: String(raw.mill || "").trim().slice(0, 120),
    incoterm: String(raw.incoterm || "CFR").toUpperCase(),
    importerOfRecord: raw.importerOfRecord === "supplier" ? "supplier" : "us",
    priceAmount: num(raw.priceAmount),
    priceCurrency: String(raw.priceCurrency || "GBP").toUpperCase(),
    fxRateOverride: num(raw.fxRateOverride),
    fxBufferPct: num(raw.fxBufferPct) ?? 0,
    freightToUkPerT: num(raw.freightToUkPerT) ?? 0,
    insurancePerT: num(raw.insurancePerT) ?? 0,
    inlandFreightPerT: num(raw.inlandFreightPerT) ?? 0,
    brokeragePerShipment: num(raw.brokeragePerShipment) ?? 0,
    paymentTerms: String(raw.paymentTerms || "").trim().slice(0, 120),
    financeRatePct: num(raw.financeRatePct) ?? 0,
    financeDays: num(raw.financeDays) ?? 0,
    leadTimeWeeks: num(raw.leadTimeWeeks),
    quoteValidUntil: String(raw.quoteValidUntil || "").trim(),
    emissionsPerT: num(raw.emissionsPerT),
    ukCarbonPrice: num(raw.ukCarbonPrice),
    overseasCarbonPrice: num(raw.overseasCarbonPrice) ?? 0,
    notes: String(raw.notes || "").trim().slice(0, 2000),
  };

  if (inputs.commodityCode.length === 8) inputs.commodityCode += "00";
  if (!/^\d{10}$/.test(inputs.commodityCode)) errors.commodityCode = "Enter an 8- or 10-digit commodity code.";
  if (!ORIGINS.includes(inputs.origin)) errors.origin = "Choose an origin.";
  if (!(inputs.tonnage > 0)) errors.tonnage = "Tonnage must be more than 0.";
  if (inputs.tonnage > 1_000_000) errors.tonnage = "Tonnage looks too large.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inputs.importDate) || Number.isNaN(Date.parse(inputs.importDate))) {
    errors.importDate = "Enter the expected import date.";
  }
  if (!INCOTERMS.includes(inputs.incoterm)) errors.incoterm = "Choose an Incoterm.";
  if (!CURRENCIES.includes(inputs.priceCurrency)) errors.priceCurrency = "Choose GBP, EUR or USD.";
  if (!(inputs.priceAmount > 0)) errors.priceAmount = "Enter the quoted price per tonne.";
  if (inputs.fxRateOverride !== null && !(inputs.fxRateOverride > 0)) errors.fxRateOverride = "FX rate must be more than 0.";
  if (inputs.quoteValidUntil && !/^\d{4}-\d{2}-\d{2}$/.test(inputs.quoteValidUntil)) {
    errors.quoteValidUntil = "Use a valid date.";
  }
  for (const key of [
    "fxBufferPct", "freightToUkPerT", "insurancePerT", "inlandFreightPerT", "brokeragePerShipment",
    "financeRatePct", "financeDays", "overseasCarbonPrice",
  ]) {
    if (inputs[key] < 0) errors[key] = "Cannot be negative.";
  }
  for (const key of ["emissionsPerT", "ukCarbonPrice", "leadTimeWeeks"]) {
    if (inputs[key] !== null && inputs[key] < 0) errors[key] = "Cannot be negative.";
  }

  return { inputs, errors, valid: Object.keys(errors).length === 0 };
}

// ---------------------------------------------------------------- category

export function findCategory(commodityCode, categories = []) {
  if (!commodityCode) return null;
  return categories.find((c) => c.commodityPrefixes.some((p) => commodityCode.startsWith(p))) || null;
}

export function quotaPeriodFor(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  if (m >= 7 && m <= 9) return { label: `Q1 ${y}/${y + 1}`, startDate: `${y}-07-01`, endDate: `${y}-09-30` };
  if (m >= 10) return { label: `Q2 ${y}/${y + 1}`, startDate: `${y}-10-01`, endDate: `${y}-12-31` };
  if (m <= 3) return { label: `Q3 ${y - 1}/${y}`, startDate: `${y}-01-01`, endDate: `${y}-03-31` };
  return { label: `Q4 ${y - 1}/${y}`, startDate: `${y}-04-01`, endDate: `${y}-06-30` };
}

export function geographyScore(areas = [], origin) {
  if (!origin || origin === "United Kingdom") return 0;
  if (areas.some((a) => originMatches(origin, { description: a }))) return 100;
  if (origin !== "European Union" && areas.includes("Countries other than Member States of the European Union")) return 50;
  if (areas.includes("ERGA OMNES")) return 10;
  return 0;
}

export function toTonnes(value, unit = "") {
  if (value === null || value === undefined) return null;
  const u = unit.toLowerCase();
  if (u.includes("kilogram")) return value / 1000;
  if (u.includes("tonne")) return value;
  return null;
}

// Pick the quota line for the import date, plus the line for the same order
// number that covers `asOf` (used to measure burn rate when the import
// period has not started yet).
export function matchQuota(rows, { commodityCode, categoryId, origin, importDate, asOf }) {
  if (!categoryId || origin === "United Kingdom") return { row: null, burnRow: null };
  const candidates = rows
    .filter((r) => r.categoryIds.includes(categoryId))
    .filter((r) => r.commodityCodes.some((c) => c === commodityCode || c.startsWith(commodityCode.slice(0, 8))))
    .map((r) => ({ r, score: lineScore(r, origin) }))
    .filter((x) => x.score > 0);
  const best = (date) =>
    candidates
      .filter((x) => date >= x.r.startDate && date <= x.r.endDate)
      .sort((a, b) => b.score - a.score || a.r.orderNumber.localeCompare(b.r.orderNumber))[0]?.r || null;
  const row = best(importDate);
  const burnRow = row
    ? candidates.find((x) => x.r.orderNumber === row.orderNumber && asOf >= x.r.startDate && asOf <= x.r.endDate)?.r || null
    : null;
  return { row, burnRow };
}

// Quota lines of the July 2026 measure carry their category's named origins;
// the Residual line covers every origin not named for that category.
function lineScore(row, origin) {
  const line = lineFor(row.orderNumber);
  if (!line) return geographyScore(row.geographicalAreas, origin);
  if (!line.residual) return originMatches(origin, { description: line.origin }) ? 100 : 0;
  const named = namedOriginsFor(line.categoryId);
  return named.some((n) => originMatches(origin, { description: n })) ? 0 : 50;
}

// ---------------------------------------------------------------- quota EV

export function quotaExposure({ row, burnRow, tonnage, importDate, asOf, valuePerT, rate, settings = DEFAULT_SETTINGS }) {
  if (!row) {
    return {
      matched: false,
      projectedBalanceT: 0,
      probability: 1,
      expectedExcessT: tonnage,
      expected: tonnage * valuePerT * rate,
      low: tonnage * valuePerT * rate,
      high: tonnage * valuePerT * rate,
      basis: "No quota line matched for this origin and date, so every tonne is treated as out of quota.",
    };
  }

  const initialT = toTonnes(row.initialVolume, row.measurementUnit);
  const balanceT = toTonnes(row.balance, row.measurementUnit);
  let startBalance;
  let burnPerDay = 0;
  let days = 0;
  let basis;

  const periodStarted = asOf >= row.startDate;
  if (periodStarted) {
    startBalance = balanceT ?? initialT ?? 0;
    const used = (initialT ?? 0) - (balanceT ?? initialT ?? 0);
    const elapsed = Math.max(daysBetween(row.startDate, asOf) + 1, 1);
    burnPerDay = Math.max(used, 0) / elapsed;
    days = Math.max(daysBetween(asOf, importDate), 0);
    basis = `Burn rate from ${round2(used)} t used over ${elapsed} days this period, projected ${days} days to import.`;
  } else {
    startBalance = initialT ?? balanceT ?? 0;
    days = Math.max(daysBetween(row.startDate, importDate), 0);
    if (burnRow) {
      const bInit = toTonnes(burnRow.initialVolume, burnRow.measurementUnit) ?? 0;
      const bBal = toTonnes(burnRow.balance, burnRow.measurementUnit) ?? bInit;
      const elapsed = Math.max(daysBetween(burnRow.startDate, asOf) + 1, 1);
      const share = bInit > 0 ? Math.max(bInit - bBal, 0) / bInit / elapsed : 0; // share of volume per day
      burnPerDay = share * startBalance;
      basis = `Import period not started; using this period's burn (${round2(share * 100 * elapsed)}% used in ${elapsed} days), projected ${days} days into the import period.`;
    } else {
      basis = "Import period not started and no burn history for this order number — full opening volume assumed available.";
    }
  }

  const s = settings.burnUncertainty;
  const n = Math.max(settings.burnSamples, 1);
  let sumCharge = 0;
  let sumExcess = 0;
  let exhausted = 0;
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < n; i += 1) {
    const factor = n === 1 ? 1 : 1 - s + (2 * s * i) / (n - 1);
    const projected = Math.max(startBalance - burnPerDay * factor * days, 0);
    const excess = Math.max(tonnage - projected, 0);
    const charge = excess * valuePerT * rate;
    sumCharge += charge;
    sumExcess += excess;
    if (excess > 0) exhausted += 1;
    low = Math.min(low, charge);
    high = Math.max(high, charge);
  }

  return {
    matched: true,
    orderNumber: row.orderNumber,
    geographicalAreas: row.geographicalAreas,
    status: row.status,
    startDate: row.startDate,
    endDate: row.endDate,
    initialT,
    balanceT,
    burnPerDayT: burnPerDay,
    projectedBalanceT: Math.max(startBalance - burnPerDay * days, 0),
    probability: exhausted / n,
    expectedExcessT: sumExcess / n,
    expected: sumCharge / n,
    low,
    high,
    basis,
  };
}

// ---------------------------------------------------------------- duty rates

function measureCostPerT(measure, valuePerT) {
  if (!measure) return 0;
  return valuePerT * ((measure.ratePercent ?? 0) / 100) + (measure.perTonneGbp ?? 0);
}

function pickOrdinaryDuty(measures, origin) {
  const pref = measures.find((m) => m.measureTypeId === MEASURE_TYPES.preference);
  const third = measures.find((m) => m.measureTypeId === MEASURE_TYPES.thirdCountry);
  return origin !== "Other non-UK" && pref ? pref : third || pref || null;
}

// ---------------------------------------------------------------- main

export function calculate(rawInputs, market = {}, options = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(options.settings || {}) };
  const asOf = options.asOf || new Date().toISOString().slice(0, 10);
  const { inputs, errors, valid } = validateInputs(rawInputs);
  if (!valid) return { ok: false, errors, inputs };

  const warnings = [];
  const checks = [];
  const lines = [];
  const t = inputs.tonnage;
  const importedGoods = inputs.origin !== "United Kingdom";
  const ddp = inputs.incoterm === "DDP";
  const buyerImports = importedGoods && !ddp && inputs.importerOfRecord === "us";
  const supplierImports = importedGoods && !buyerImports;

  // FX
  let fxRate = 1;
  let fxSource = "GBP quote";
  if (inputs.priceCurrency !== "GBP") {
    if (inputs.fxRateOverride) {
      fxRate = inputs.fxRateOverride;
      fxSource = "Manual rate";
    } else if (market.fx?.rate) {
      fxRate = market.fx.rate;
      fxSource = `${market.fx.source || "FX feed"} · ${market.fx.date || ""}`.trim();
    } else {
      return {
        ok: false,
        inputs,
        errors: { fxRateOverride: `No live ${inputs.priceCurrency}→GBP rate available. Enter a manual rate.` },
      };
    }
  }

  const pricePerT = inputs.priceAmount * fxRate;
  const freightPerT = FREIGHT_IN_PRICE.has(inputs.incoterm) ? 0 : inputs.freightToUkPerT;
  const insurancePerT = INSURANCE_IN_PRICE.has(inputs.incoterm) ? 0 : inputs.insurancePerT;
  const inlandPerT = DELIVERED_TO_SITE.has(inputs.incoterm) ? 0 : inputs.inlandFreightPerT;
  const customsValuePerT = pricePerT + freightPerT + insurancePerT; // CIF basis

  const add = (line) => lines.push({ total: line.perTonne === null ? null : line.perTonne * t, ...line });

  add({
    key: "price",
    label: "Supplier price",
    perTonne: pricePerT,
    source: inputs.priceCurrency === "GBP"
      ? `Quote${inputs.supplier ? ` · ${inputs.supplier}` : ""}`
      : `${inputs.priceAmount} ${inputs.priceCurrency}/t × ${fxRate} (${fxSource})`,
    status: "included",
  });

  add({
    key: "freight",
    label: "Freight to UK",
    perTonne: freightPerT,
    source: FREIGHT_IN_PRICE.has(inputs.incoterm) ? `In price (${inputs.incoterm})` : "Entered",
    status: FREIGHT_IN_PRICE.has(inputs.incoterm) ? "in-price" : "included",
  });
  add({
    key: "insurance",
    label: "Cargo insurance",
    perTonne: insurancePerT,
    source: INSURANCE_IN_PRICE.has(inputs.incoterm) ? `In price (${inputs.incoterm})` : "Entered",
    status: INSURANCE_IN_PRICE.has(inputs.incoterm) ? "in-price" : "included",
  });

  // Duty, quota and trade remedies
  const category = findCategory(inputs.commodityCode, market.categories || []);
  const measures = market.dutyMeasures || [];
  const ordinary = pickOrdinaryDuty(measures, inputs.origin);
  const remedies = measures.filter((m) => MEASURE_TYPES.tradeRemedies.includes(m.measureTypeId));
  let quota = null;
  let quotaPeriod = quotaPeriodFor(inputs.importDate);

  if (!buyerImports) {
    const note = supplierImports ? "Supplier is importer of record" : "UK origin — no import";
    for (const [key, label] of [["duty", "Import duty"], ["quota", "Steel measure (quota risk)"], ["remedies", "Anti-dumping / CVD"]]) {
      add({ key, label, perTonne: 0, source: note, status: supplierImports ? "supplier" : "n/a" });
    }
    if (supplierImports && category) {
      checks.push("Supplier carries duty and quota risk — confirm the contract says who pays an unexpected 50% charge.");
    }
  } else if (category && EXCLUDED_ORIGINS.includes(inputs.origin)) {
    add({ key: "duty", label: "Import duty", perTonne: measureCostPerT(ordinary, customsValuePerT),
      source: ordinary ? `${ordinary.label} · ${ordinary.measureType} · GOV.UK Trade Tariff` : "No duty measure found", status: "included" });
    add({ key: "quota", label: "Steel measure (quota risk)", perTonne: 0, source: `${inputs.origin} is excluded from the steel measure`, status: "n/a" });
  } else if (category && isRemovedFromScope(inputs.commodityCode, inputs.importDate)) {
    add({ key: "duty", label: "Import duty", perTonne: measureCostPerT(ordinary, customsValuePerT),
      source: ordinary ? `${ordinary.label} · ${ordinary.measureType} · GOV.UK Trade Tariff` : "No duty measure found", status: "included" });
    add({ key: "quota", label: "Steel measure (quota risk)", perTonne: 0, source: "Code removed from the steel measure on 1 Oct 2026", status: "n/a" });
  } else if (category && inputs.importDate >= (market.tradeMeasureEffectiveFrom || "2026-07-01")) {
    const { row, burnRow } = matchQuota(market.quotaRows || [], {
      commodityCode: inputs.commodityCode,
      categoryId: category.id,
      origin: inputs.origin,
      importDate: inputs.importDate,
      asOf,
    });
    quota = quotaExposure({
      row,
      burnRow,
      tonnage: t,
      importDate: inputs.importDate,
      asOf,
      valuePerT: customsValuePerT,
      rate: settings.outOfQuotaDutyRate,
      settings,
    });

    // Ordinary duty applies to every tonne; the 50% steel-measure duty is
    // added on top for out-of-quota tonnes, calculated on the goods value
    // before other duties (GOV.UK guidance, updated 1 Oct 2026).
    add({
      key: "duty",
      label: "Import duty",
      perTonne: measureCostPerT(ordinary, customsValuePerT),
      source: ordinary ? `${ordinary.label} · ${ordinary.measureType} · GOV.UK Trade Tariff` : "No ordinary duty measure found",
      status: "included",
    });
    if (!ordinary && !market.dutyError) warnings.push("No ordinary import-duty measure was found for this code and origin.");

    add({
      key: "quota",
      label: `Steel measure risk (${Math.round(quota.probability * 100)}% chance × ${settings.outOfQuotaDutyRate * 100}%)`,
      perTonne: quota.expected / t,
      lowPerTonne: quota.low / t,
      highPerTonne: quota.high / t,
      source: row ? `UK Trade Quotas · order ${row.orderNumber}` : "No quota line matched",
      note: quota.basis,
      status: "included",
    });
    if (row && lineFor(row.orderNumber)) {
      checks.push(`Claim quota order ${row.orderNumber} on the customs declaration — HMRC allocates first come, first served on the day goods are declared.`);
    }
    if (quota.probability >= 0.5) {
      checks.push("Quota line is likely to run out before the import date — consider an earlier shipment, another origin, or DDP.");
    }
  } else {
    add({
      key: "duty",
      label: "Import duty",
      perTonne: measureCostPerT(ordinary, customsValuePerT),
      source: ordinary ? `${ordinary.label} · ${ordinary.measureType} · GOV.UK Trade Tariff` : "No duty measure found",
      status: "included",
    });
    if (!ordinary) warnings.push("No ordinary import-duty measure was found for this code and origin.");
    add({ key: "quota", label: "Steel measure (quota risk)", perTonne: 0, source: category ? "Before steel measure start" : "Not a steel-measure category", status: "n/a" });
  }

  if (buyerImports) {
    const remedyPerT = remedies.reduce((sum, m) => sum + measureCostPerT(m, customsValuePerT), 0);
    add({
      key: "remedies",
      label: "Anti-dumping / CVD",
      perTonne: remedyPerT,
      source: remedies.length ? remedies.map((m) => `${m.label} ${m.measureType}`).join("; ") : "None found · GOV.UK Trade Tariff",
      status: "included",
    });
    if (remedies.some((m) => m.hasConditions)) {
      checks.push("Trade-remedy rate depends on the producer — check the exporter's additional code with your broker.");
    }
    if (market.dutyError) warnings.push(`Tariff lookup failed (${market.dutyError}); duty lines may be incomplete.`);
  }

  // CBAM
  let cbam = { status: "Not applicable", perTonne: 0 };
  const cbamScope = /^7[23]/.test(inputs.commodityCode);
  if (!importedGoods) cbam.status = "Not applicable for UK-origin goods";
  else if (!cbamScope) cbam.status = "Outside Chapter 72/73";
  else if (inputs.importDate < settings.cbamStartDate) cbam.status = `Not active before ${settings.cbamStartDate}`;
  else if (!buyerImports) cbam.status = "Supplier is importer of record";
  else if (inputs.emissionsPerT === null || inputs.ukCarbonPrice === null) {
    cbam = { status: "Applies — emissions and UK carbon price needed", perTonne: null };
    warnings.push("CBAM applies but is not costed: enter the mill's emissions per tonne and the UK CBAM rate.");
  } else {
    const net = Math.max(inputs.ukCarbonPrice - inputs.overseasCarbonPrice, 0);
    cbam = { status: "Applies — estimated from entered emissions", perTonne: inputs.emissionsPerT * net, emissionsT: inputs.emissionsPerT * t, netCarbonPrice: net };
  }
  add({
    key: "cbam",
    label: "UK CBAM",
    perTonne: cbam.perTonne,
    source: cbam.status,
    status: cbam.perTonne === null ? "missing" : cbam.perTonne > 0 ? "included" : "n/a",
  });

  // Onward and other costs
  add({
    key: "inland",
    label: "UK inland freight",
    perTonne: inlandPerT,
    source: DELIVERED_TO_SITE.has(inputs.incoterm) ? `In price (${inputs.incoterm})` : "Entered",
    status: DELIVERED_TO_SITE.has(inputs.incoterm) ? "in-price" : "included",
  });
  add({
    key: "brokerage",
    label: "Customs brokerage",
    perTonne: buyerImports ? inputs.brokeragePerShipment / t : 0,
    source: buyerImports ? `£${inputs.brokeragePerShipment} per shipment` : "Not our import",
    status: buyerImports ? "included" : "n/a",
  });
  add({
    key: "fxBuffer",
    label: "FX buffer",
    perTonne: inputs.priceCurrency === "GBP" ? 0 : pricePerT * (inputs.fxBufferPct / 100),
    source: inputs.priceCurrency === "GBP" ? "GBP quote" : `${inputs.fxBufferPct}% of price`,
    status: inputs.priceCurrency === "GBP" ? "n/a" : "included",
  });

  const preFinancePerT = lines.reduce((sum, l) => sum + (l.perTonne ?? 0), 0);
  add({
    key: "finance",
    label: "Working capital",
    perTonne: preFinancePerT * (inputs.financeRatePct / 100) * (inputs.financeDays / 365),
    source: inputs.financeRatePct && inputs.financeDays ? `${inputs.financeRatePct}% p.a. × ${inputs.financeDays} days` : "Not entered",
    status: inputs.financeRatePct && inputs.financeDays ? "included" : "n/a",
  });

  const expectedPerT = lines.reduce((sum, l) => sum + (l.perTonne ?? 0), 0);
  const quotaLine = lines.find((l) => l.key === "quota");
  const lowPerT = expectedPerT - (quotaLine?.perTonne ?? 0) + (quotaLine?.lowPerTonne ?? quotaLine?.perTonne ?? 0);
  const highPerT = expectedPerT - (quotaLine?.perTonne ?? 0) + (quotaLine?.highPerTonne ?? quotaLine?.perTonne ?? 0);

  const dutiesPerT = ["duty", "quota", "remedies", "cbam"].reduce(
    (sum, key) => sum + (lines.find((l) => l.key === key)?.perTonne ?? 0), 0);
  const vatPerT = buyerImports ? (customsValuePerT + dutiesPerT) * settings.importVatRate : 0;

  if (inputs.quoteValidUntil && inputs.quoteValidUntil < asOf) checks.push("This quote has expired — get it re-confirmed.");
  if (importedGoods && !inputs.mill) checks.push("Record the mill — origin evidence and sanctions checks depend on it.");
  if (importedGoods && inputs.importDate >= settings.cbamStartDate) checks.push("Collect verified emissions data from the mill for CBAM reporting.");
  if (inputs.priceCurrency !== "GBP" && !inputs.fxRateOverride) checks.push(`FX uses today's rate; the rate on payment day will differ.`);

  return {
    ok: true,
    engineVersion: ENGINE_VERSION,
    asOf,
    inputs,
    category: category ? { id: category.id, name: category.name, authorisedUse: category.authorisedUse === true } : null,
    quotaPeriod,
    quota,
    cbam,
    fx: { rate: fxRate, currency: inputs.priceCurrency, source: fxSource },
    buyerImports,
    customsValuePerT: round2(customsValuePerT),
    lines: lines.map((l) => ({
      ...l,
      perTonne: round2(l.perTonne),
      total: round2(l.total),
      lowPerTonne: round2(l.lowPerTonne),
      highPerTonne: round2(l.highPerTonne),
    })),
    totals: {
      expectedPerT: round2(expectedPerT),
      expectedTotal: round2(expectedPerT * t),
      lowPerT: round2(lowPerT),
      highPerT: round2(highPerT),
      vatPerT: round2(vatPerT),
      vatTotal: round2(vatPerT * t),
    },
    complete: !lines.some((l) => l.status === "missing"),
    warnings,
    checks,
  };
}
