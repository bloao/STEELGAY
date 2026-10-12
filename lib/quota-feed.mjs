// Live quota balances for the July 2026 steel measure.
//
// Primary source: HMRC's Trade Tariff API, /quotas/search?order_number=…
// (the balances HMRC allocates against at import). Fallback: the Department
// for Business and Trade "UK trade quotas" dataset, refreshed daily.
// Parsing is kept here, free of network code, so it can be unit-tested.

import { ORDER_LINES, lineFor, quarterFor } from "./steel-measure.mjs";

const DAY = 86_400_000;
const num = (v) => {
  if (v === null || v === undefined || v === "" || v === "#NA") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const day = (v) => (v ? String(v).slice(0, 10) : "");
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export function unitToTonnes(value, unit = "") {
  if (value === null || value === undefined) return null;
  const u = String(unit).toLowerCase();
  if (/(^|\W)(kg|kgm|kilogram)/.test(u)) return value / 1000;
  if (/tonne|tne|1000 kg/.test(u)) return value;
  return null;
}

// Trade Tariff API JSON:API payload → plain definitions.
export function parseTariffQuotas(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
  return data
    .filter((d) => d && (d.type === "definition" || d.type === "quota_definition" || d.attributes?.initial_volume !== undefined))
    .map((d) => {
      const a = d.attributes || {};
      return {
        orderNumber: String(a.quota_order_number_id || d.relationships?.order_number?.data?.id || ""),
        startDate: day(a.validity_start_date),
        endDate: day(a.validity_end_date),
        initialVolume: num(a.initial_volume),
        balance: num(a.balance),
        measurementUnit: a.measurement_unit || "",
        status: a.status || "",
        lastAllocationDate: day(a.last_allocation_date),
        description: a.description || "",
        source: "tariff",
      };
    })
    .filter((d) => d.orderNumber && d.startDate);
}

// One row per quota definition in the shape lib/calc.mjs expects.
export function toCalcRow(def, categories) {
  const line = lineFor(def.orderNumber);
  const category = categories.find((c) => c.id === line?.categoryId);
  return {
    orderNumber: def.orderNumber,
    geographicalAreas: line ? [line.residual ? "Residual — all other origins" : line.origin] : def.geographicalAreas || [],
    commodityCodes: category ? category.commodityPrefixes : def.commodityCodes || [],
    categoryIds: line ? [line.categoryId] : def.categoryIds || [],
    measurementUnit: def.measurementUnit,
    description: def.description || "",
    startDate: def.startDate,
    endDate: def.endDate,
    status: def.status,
    lastAllocationDate: def.lastAllocationDate,
    initialVolume: def.initialVolume,
    balance: def.balance,
    source: def.source,
  };
}

// Merge HMRC definitions over DBT rows: HMRC wins for any period it returned.
export function mergeDefinitions(tariffDefs, dbtDefs) {
  const key = (d) => `${d.orderNumber}|${d.startDate}`;
  const merged = new Map(dbtDefs.map((d) => [key(d), { ...d, source: "dbt" }]));
  for (const d of tariffDefs) merged.set(key(d), d);
  return [...merged.values()].sort((a, b) => a.orderNumber.localeCompare(b.orderNumber) || a.startDate.localeCompare(b.startDate));
}

function riskFor({ initialT, balanceT, runOutDate, endDate, status }) {
  if (balanceT !== null && balanceT <= 0) return "exhausted";
  if (/exhaust/i.test(status || "")) return "exhausted";
  if (/block|suspend/i.test(status || "")) return "blocked";
  const left = initialT ? balanceT / initialT : null;
  if (runOutDate && runOutDate <= endDate) return "critical";
  if (left !== null && left < 0.1) return "critical";
  if (left !== null && left < 0.3) return "watch";
  return "open";
}

// The 72 lines for the current quarter, with burn rate and run-out date.
export function buildLines(defs, categories, asOf) {
  const quarter = quarterFor(asOf);
  return ORDER_LINES.map((line) => {
    const forOrder = defs.filter((d) => d.orderNumber === line.orderNumber);
    const current = forOrder.find((d) => asOf >= d.startDate && asOf <= d.endDate) || null;
    const next = forOrder.find((d) => d.startDate > asOf) || null;
    const category = categories.find((c) => c.id === line.categoryId);
    const base = {
      ...line,
      categoryName: category ? category.name : `Category ${line.categoryId}`,
      quarter: quarter.label,
      nextOpeningT: next ? unitToTonnes(next.initialVolume, next.measurementUnit) : null,
      nextStartDate: next ? next.startDate : null,
    };
    if (!current) {
      return { ...base, found: false, risk: "unknown", source: null };
    }
    const initialT = unitToTonnes(current.initialVolume, current.measurementUnit);
    const balanceT = unitToTonnes(current.balance, current.measurementUnit);
    const usedT = initialT !== null && balanceT !== null ? Math.max(initialT - balanceT, 0) : null;
    const elapsed = Math.max(daysBetween(current.startDate, asOf) + 1, 1);
    const burnPerDayT = usedT !== null ? usedT / elapsed : null;
    const runOutDate = burnPerDayT > 0 && balanceT > 0 ? addDays(asOf, Math.floor(balanceT / burnPerDayT)) : null;
    const result = {
      ...base,
      found: true,
      source: current.source,
      status: current.status,
      startDate: current.startDate,
      endDate: current.endDate,
      lastAllocationDate: current.lastAllocationDate,
      initialT,
      balanceT,
      usedT,
      usedShare: initialT ? usedT / initialT : null,
      burnPerDayT,
      runOutDate,
      daysLeftInPeriod: Math.max(daysBetween(asOf, current.endDate), 0),
    };
    result.risk = riskFor(result);
    return result;
  });
}
