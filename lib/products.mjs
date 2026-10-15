// Product catalogue: validation, stock maths and spreadsheet import (pure — no I/O).
//
// Data points follow Stage 01 of the plan ("Our product & demand baseline"):
// what we sell (description, specification, commodity code → quota category),
// our demand (current stock, monthly usage → projected stock-out), our
// operational constraints (lead time, MOQ, safety stock, cover we hold) and
// our commercial ceiling (target buy price).

const DAYS_PER_MONTH = 30.44;
const WEEKS_PER_MONTH = 4.345;
const DAY = 86_400_000;

const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,£$€\s]/g, "").replace(/(t|tonnes?|mt|weeks?|wks?|months?|mo)$/i, "");
  if (s === "" || s === "-" || s === "—") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + Math.round(days) * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

// The five sample products supplied for the pilot (stock cost price is £/t).
export const SEED_PRODUCTS = [
  { category: "Merchant Bar", name: "40×40×3 Angle", commodityCode: "7216210000", stockT: 36, monthlyUsageT: 10, costPerT: 766 },
  { category: "Merchant Bar", name: "50×40×5 Angle", commodityCode: "7216210000", stockT: 116, monthlyUsageT: 30, costPerT: 885 },
  { category: "Merchant Bar", name: "40×10 Flat", commodityCode: "7214911090", stockT: 32, monthlyUsageT: 16, costPerT: 756 },
  { category: "Merchant Bar", name: "100×50 Flat", commodityCode: "7214911090", stockT: 1.5, monthlyUsageT: 2, costPerT: 781 },
  { category: "Merchant Bar", name: "25 mm Round", commodityCode: "7214993900", stockT: 8, monthlyUsageT: 4, costPerT: 796 },
];

export const DEFAULT_TARGET_COVER_MONTHS = 3;

export const PRODUCT_FIELDS = [
  "name", "category", "spec", "commodityCode", "stockT", "stockAsOf", "monthlyUsageT", "costPerT",
  "leadTimeWeeks", "moqT", "safetyStockT", "targetCoverMonths", "targetBuyPrice", "notes",
];

function cleanCatalog(c) {
  if (!c || typeof c !== "object" || typeof c.family !== "string" || !c.family.trim()) return null;
  const values = {};
  for (const [k, v] of Object.entries(c.values || {}).slice(0, 8)) {
    if (/^[a-z]{1,16}$/i.test(k) && (typeof v === "string" || typeof v === "number")) values[k] = String(v).slice(0, 60);
  }
  return { family: c.family.trim().slice(0, 40), values };
}

export function validateProduct(raw = {}, { asOf = today() } = {}) {
  const errors = {};
  const p = {
    name: String(raw.name || "").trim().slice(0, 120),
    category: String(raw.category || "").trim().slice(0, 80) || "Uncategorised",
    spec: String(raw.spec || "").trim().slice(0, 160),
    commodityCode: String(raw.commodityCode || "").replace(/[\s.]/g, ""),
    stockT: num(raw.stockT),
    stockAsOf: String(raw.stockAsOf || "").trim() || asOf,
    monthlyUsageT: num(raw.monthlyUsageT),
    costPerT: num(raw.costPerT),
    leadTimeWeeks: num(raw.leadTimeWeeks),
    moqT: num(raw.moqT),
    safetyStockT: num(raw.safetyStockT) ?? 0,
    targetCoverMonths: num(raw.targetCoverMonths) ?? DEFAULT_TARGET_COVER_MONTHS,
    targetBuyPrice: num(raw.targetBuyPrice),
    notes: String(raw.notes || "").trim().slice(0, 1000),
  };
  // Catalogue pick (family + size/grade/length…) — kept so the edit form can
  // reopen on the same selection. Only set when sent, so imports keep it.
  if (raw.catalog !== undefined) p.catalog = cleanCatalog(raw.catalog);
  if (p.commodityCode.length === 8) p.commodityCode += "00";
  if (!p.name) errors.name = "Enter a product description.";
  if (!p.commodityCode) errors.commodityCode = "Enter the commodity code.";
  else if (!/^\d{10}$/.test(p.commodityCode)) errors.commodityCode = "Commodity codes are 8 or 10 digits.";
  if (p.stockT === null) errors.stockT = "Enter current stock in tonnes.";
  else if (p.stockT < 0) errors.stockT = "Stock cannot be negative.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.stockAsOf) || Number.isNaN(Date.parse(p.stockAsOf))) errors.stockAsOf = "Use a valid date.";
  else if (p.stockAsOf > asOf) errors.stockAsOf = "Stock date cannot be in the future.";
  if (p.monthlyUsageT === null) errors.monthlyUsageT = "Enter monthly usage in tonnes.";
  else if (p.monthlyUsageT < 0) errors.monthlyUsageT = "Usage cannot be negative.";
  if (p.costPerT === null) errors.costPerT = "Enter the stock cost price per tonne.";
  else if (p.costPerT < 0) errors.costPerT = "Cost cannot be negative.";
  if (p.leadTimeWeeks !== null && (p.leadTimeWeeks < 0 || p.leadTimeWeeks > 104)) errors.leadTimeWeeks = "Use 0–104 weeks.";
  if (p.moqT !== null && p.moqT < 0) errors.moqT = "Cannot be negative.";
  if (p.targetBuyPrice !== null && p.targetBuyPrice < 0) errors.targetBuyPrice = "Cannot be negative.";
  if (p.safetyStockT < 0) errors.safetyStockT = "Cannot be negative.";
  if (!(p.targetCoverMonths > 0) || p.targetCoverMonths > 36) errors.targetCoverMonths = "Use 0.5–36 months.";
  return { product: p, errors, valid: Object.keys(errors).length === 0 };
}

// Cover, stock-out, reorder point and suggested order for one product.
export function stockMetrics(p, asOf = today()) {
  const usage = p.monthlyUsageT || 0;
  const recordedOn = p.stockAsOf || asOf;
  const monthsSince = Math.max(daysBetween(recordedOn, asOf), 0) / DAYS_PER_MONTH;
  // Stock entered on an earlier date is drawn down at the monthly usage rate.
  const stockNowT = Math.max(p.stockT - usage * monthsSince, 0);
  const estimated = monthsSince > 0.03 && usage > 0;
  const coverMonths = usage > 0 ? stockNowT / usage : null;
  const leadMonths = p.leadTimeWeeks ? p.leadTimeWeeks / WEEKS_PER_MONTH : null;
  const safety = p.safetyStockT || 0;
  const reorderPointT = leadMonths !== null ? usage * leadMonths + safety : null;
  const stockOutDate = coverMonths !== null ? addDays(asOf, coverMonths * DAYS_PER_MONTH) : null;
  const latestOrderDate = reorderPointT !== null && usage > 0
    ? addDays(asOf, ((stockNowT - reorderPointT) / usage) * DAYS_PER_MONTH)
    : null;
  // Enough to cover the lead time plus the target cover, plus safety stock.
  const neededT = usage * ((leadMonths || 0) + p.targetCoverMonths) + safety;
  let suggestedOrderT = usage > 0 ? Math.max(Math.ceil(neededT - stockNowT), 0) : 0;
  const needT = suggestedOrderT;
  // never below a minimum order: the product's own, or the smallest load any supplier will sell
  const minOrderT = Math.max(p.moqT || 0, p.supplierMoqT || 0);
  const moqApplied = suggestedOrderT > 0 && minOrderT > suggestedOrderT;
  if (moqApplied) suggestedOrderT = Math.ceil(minOrderT);

  let status = "ok";
  let reason = "Enough cover";
  if (usage === 0) {
    status = "no-usage";
    reason = "No monthly usage recorded";
  } else if (stockNowT <= safety) {
    status = "critical";
    reason = safety ? "At or below safety stock" : "Out of stock";
  } else if (reorderPointT !== null && stockNowT <= reorderPointT) {
    status = "reorder";
    reason = "Below reorder point — order now to land in time";
  } else if (reorderPointT === null && coverMonths < 1) {
    status = "critical";
    reason = "Under 1 month of cover";
  } else if (reorderPointT === null && coverMonths <= 2) {
    status = "low";
    reason = "2 months of cover or less";
  } else if (leadMonths !== null && coverMonths < leadMonths + 1) {
    status = "low";
    reason = "Within a month of the reorder point";
  }

  return {
    stockNowT,
    estimated,
    coverMonths,
    stockOutDate,
    stockValue: stockNowT * (p.costPerT || 0),
    reorderPointT,
    latestOrderDate,
    suggestedOrderT,
    moqApplied,
    needT,
    minOrderT: minOrderT || null,
    suggestedOrderValue: suggestedOrderT * (p.targetBuyPrice || p.costPerT || 0),
    status,
    reason,
  };
}

// ---------------------------------------------------------------- import

const HEADER_ALIASES = {
  name: ["description", "product", "product name", "name", "item", "size", "product description"],
  category: ["category", "product category", "group", "range"],
  spec: ["spec", "specification", "grade", "dimensions"],
  commodityCode: ["product code", "commodity code", "commodity", "code", "hs code", "tariff code", "cn code"],
  stockT: ["current stock", "stock", "stock (t)", "on hand", "stock on hand", "qty", "quantity"],
  stockAsOf: ["stock date", "as of", "stock as of", "date"],
  monthlyUsageT: ["monthly usage", "usage", "monthly use", "consumption", "monthly consumption", "usage per month"],
  costPerT: ["stock cost price", "cost price", "cost", "unit cost", "cost per tonne", "cost £/t", "price"],
  leadTimeWeeks: ["lead time", "lead time (weeks)", "lead time weeks", "lead"],
  moqT: ["moq", "minimum order", "min order", "minimum order quantity"],
  safetyStockT: ["safety stock", "buffer", "min stock"],
  targetBuyPrice: ["target buy price", "target price", "max price", "buy price"],
  notes: ["notes", "comments", "note"],
};
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9£/() ]+/g, " ").replace(/\s+/g, " ").trim();

function splitLine(line, sep) {
  if (sep === "\t") return line.split("\t");
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"' && line[i + 1] === '"' && q) { cur += '"'; i += 1; } else if (c === '"') q = !q;
    else if (c === sep && !q) { out.push(cur); cur = ""; } else cur += c;
  }
  out.push(cur);
  return out;
}

// Parse rows pasted from Excel/Sheets (tab-separated) or CSV. The header row
// is matched by common column names. A row with only its first cell filled is
// treated as a category heading for the rows below it.
export function parseProductTable(text) {
  const lines = String(text || "").replace(/\r/g, "").split("\n").filter((l) => l.trim());
  if (!lines.length) return { rows: [], columns: {}, unmatched: [], error: "Paste some rows first." };
  const sep = lines.some((l) => l.includes("\t")) ? "\t" : lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
  const headerIndex = lines.findIndex((l) => {
    const cells = splitLine(l, sep).map(norm);
    return cells.some((c) => HEADER_ALIASES.name.includes(c)) && cells.some((c) => HEADER_ALIASES.commodityCode.includes(c) || HEADER_ALIASES.stockT.includes(c));
  });
  if (headerIndex < 0) return { rows: [], columns: {}, unmatched: [], error: "Couldn't find a header row — include column names such as Description, Product Code, Current Stock, Monthly Usage, Stock Cost Price." };
  const header = splitLine(lines[headerIndex], sep).map(norm);
  const columns = {};
  const unmatched = [];
  header.forEach((h, i) => {
    if (!h) return;
    const field = Object.keys(HEADER_ALIASES).find((f) => HEADER_ALIASES[f].includes(h) && columns[f] === undefined);
    if (field) columns[field] = i;
    else unmatched.push(h);
  });
  const rows = [];
  let heading = "";
  for (const line of lines.slice(headerIndex + 1)) {
    const cells = splitLine(line, sep).map((c) => c.trim());
    const filled = cells.filter(Boolean);
    if (!filled.length) continue;
    if (filled.length === 1 && cells[0]) { heading = cells[0]; continue; }
    const raw = {};
    for (const [field, i] of Object.entries(columns)) raw[field] = cells[i] ?? "";
    if (!raw.category && heading) raw.category = heading;
    if (!raw.name && !raw.commodityCode) continue;
    rows.push(raw);
  }
  return { rows, columns, unmatched, error: rows.length ? null : "No product rows found under the header." };
}
