// Product catalogue: validation and stock maths (pure — no I/O).

const DAYS_PER_MONTH = 30.44;
const WEEKS_PER_MONTH = 4.345;

const num = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/[,£t\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

// The five sample products supplied for the pilot (stock cost price is £/t).
export const SEED_PRODUCTS = [
  { category: "Merchant Bar", name: "40×40×3 Angle", commodityCode: "7216210000", stockT: 36, monthlyUsageT: 10, costPerT: 766 },
  { category: "Merchant Bar", name: "50×40×5 Angle", commodityCode: "7216210000", stockT: 116, monthlyUsageT: 30, costPerT: 885 },
  { category: "Merchant Bar", name: "40×10 Flat", commodityCode: "7214911090", stockT: 32, monthlyUsageT: 16, costPerT: 756 },
  { category: "Merchant Bar", name: "100×50 Flat", commodityCode: "7214911090", stockT: 1.5, monthlyUsageT: 2, costPerT: 781 },
  { category: "Merchant Bar", name: "25 mm Round", commodityCode: "7214993900", stockT: 8, monthlyUsageT: 4, costPerT: 796 },
];

export const DEFAULT_TARGET_COVER_MONTHS = 3;

export function validateProduct(raw = {}) {
  const errors = {};
  const p = {
    category: String(raw.category || "").trim().slice(0, 80) || "Uncategorised",
    name: String(raw.name || "").trim().slice(0, 120),
    commodityCode: String(raw.commodityCode || "").replace(/\s+/g, ""),
    stockT: num(raw.stockT),
    monthlyUsageT: num(raw.monthlyUsageT),
    costPerT: num(raw.costPerT),
    leadTimeWeeks: num(raw.leadTimeWeeks),
    safetyStockT: num(raw.safetyStockT) ?? 0,
    targetCoverMonths: num(raw.targetCoverMonths) ?? DEFAULT_TARGET_COVER_MONTHS,
    targetBuyPrice: num(raw.targetBuyPrice),
    notes: String(raw.notes || "").trim().slice(0, 1000),
  };
  if (p.commodityCode.length === 8) p.commodityCode += "00";
  if (!p.name) errors.name = "Enter a product description.";
  if (!/^\d{10}$/.test(p.commodityCode)) errors.commodityCode = "Enter an 8- or 10-digit commodity code.";
  if (p.stockT === null || p.stockT < 0) errors.stockT = "Enter current stock in tonnes.";
  if (p.monthlyUsageT === null || p.monthlyUsageT < 0) errors.monthlyUsageT = "Enter monthly usage in tonnes.";
  if (p.costPerT === null || p.costPerT < 0) errors.costPerT = "Enter the stock cost price per tonne.";
  for (const k of ["leadTimeWeeks", "targetBuyPrice"]) if (p[k] !== null && p[k] < 0) errors[k] = "Cannot be negative.";
  if (p.safetyStockT < 0) errors.safetyStockT = "Cannot be negative.";
  if (!(p.targetCoverMonths > 0) || p.targetCoverMonths > 36) errors.targetCoverMonths = "Use 0–36 months.";
  return { product: p, errors, valid: Object.keys(errors).length === 0 };
}

const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + Math.round(days) * 86_400_000).toISOString().slice(0, 10);

// Cover, stock-out, reorder point and suggested order for one product.
export function stockMetrics(p, asOf = new Date().toISOString().slice(0, 10)) {
  const usage = p.monthlyUsageT || 0;
  const coverMonths = usage > 0 ? p.stockT / usage : null;
  const leadMonths = p.leadTimeWeeks ? p.leadTimeWeeks / WEEKS_PER_MONTH : null;
  const reorderPointT = leadMonths !== null ? usage * leadMonths + (p.safetyStockT || 0) : null;
  const stockOutDate = coverMonths !== null ? addDays(asOf, coverMonths * DAYS_PER_MONTH) : null;
  const latestOrderDate = coverMonths !== null && leadMonths !== null
    ? addDays(asOf, (coverMonths - leadMonths) * DAYS_PER_MONTH - ((p.safetyStockT || 0) / (usage || 1)) * DAYS_PER_MONTH)
    : null;
  // Enough to last the target cover after the next delivery lands.
  const neededT = usage * ((leadMonths || 0) + p.targetCoverMonths) + (p.safetyStockT || 0);
  const suggestedOrderT = usage > 0 ? Math.max(Math.ceil(neededT - p.stockT), 0) : 0;

  let status = "ok";
  let reason = "";
  if (usage === 0) {
    status = "no-usage";
    reason = "No monthly usage recorded";
  } else if (p.stockT <= (p.safetyStockT || 0)) {
    status = "critical";
    reason = p.safetyStockT ? "At or below safety stock" : "Out of stock";
  } else if (reorderPointT !== null && p.stockT <= reorderPointT) {
    status = "reorder";
    reason = "Below reorder point — order now to arrive in time";
  } else if (reorderPointT === null && coverMonths < 1) {
    status = "critical";
    reason = "Less than 1 month of cover";
  } else if (reorderPointT === null && coverMonths <= 2) {
    status = "low";
    reason = "2 months of cover or less";
  } else if (leadMonths !== null && coverMonths < leadMonths + 1) {
    status = "low";
    reason = "Within a month of the reorder point";
  }

  return {
    coverMonths,
    stockOutDate,
    stockValue: p.stockT * (p.costPerT || 0),
    reorderPointT,
    latestOrderDate,
    suggestedOrderT,
    status,
    reason,
  };
}
