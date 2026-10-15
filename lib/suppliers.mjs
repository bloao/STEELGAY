// Supplier directory: validation, seed data, quotes, contacts and quote
// requests (pure — no I/O; the server stores records in var/suppliers.json).

import { randomUUID } from "node:crypto";

const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[,£$€%\s]/g, "").replace(/(t|tonnes?|days?|d)$/i, "");
  if (s === "" || s === "-" || s === "—") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

// ---------------------------------------------------------------- choices
export const SUPPLIER_TYPES = ["Mill", "Trader", "Stockholder", "Agent"];
export const SUPPLIER_STANDING = { active: "Active", trial: "On trial", hold: "On hold" };
export const PRICING_SOURCES = ["Competition – UK", "Competition – imports", "MEPS", "Kallanish", "Fastmarkets", "Argus", "Market intel"];
export const PRICE_COVERS = {
  everything: "Everything covered (delivered, duty paid)",
  "except-duty": "All except duty",
  "ex-works": "Ex works — we arrange transport and duty",
  "port": "To UK port — we arrange haulage and duty",
};
export const DELIVERY_TERMS = ["Delivered to depot", "DDP", "DAP", "CPT", "CFR", "CIF", "FCA", "FOB", "EXW"];
export const DDP_OPTIONS = { yes: "Yes", no: "No", na: "Not applicable (UK)" };
export const CURRENCIES = ["GBP", "EUR", "USD"];
export const QUOTE_CHANNELS = { email: "Email", phone: "Phone", portal: "Supplier portal", whatsapp: "WhatsApp", meeting: "Meeting", list: "Supplier list" };
export const ORIGINS = [
  "UK", "Austria", "Belgium", "Bulgaria", "Croatia", "Czechia", "Denmark", "Finland", "France", "Germany", "Greece",
  "Hungary", "Ireland", "Italy", "Luxembourg", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia",
  "Spain", "Sweden", "Turkey", "India", "South Korea", "Japan", "Vietnam", "United States", "Switzerland",
  "United Arab Emirates", "China", "Taiwan", "Egypt", "Algeria", "Brazil", "Ukraine", "Other",
];
export const EU_MEMBERS = new Set([
  "Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Denmark", "Estonia", "Finland", "France", "Germany",
  "Greece", "Hungary", "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland",
  "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden",
]);

// Which UK steel-measure quota line an origin draws on for a category.
// UK steel is domestic (no quota); Ukraine is excluded from the measure;
// EU members share the "European Union" line; anyone not named uses Residual.
export function quotaLineFor(origin, categoryId, lines) {
  if (!origin || origin === "UK") return { kind: "domestic" };
  if (origin === "Ukraine") return { kind: "excluded" };
  const country = EU_MEMBERS.has(origin) ? "European Union" : origin;
  const inCat = lines.filter((l) => l.categoryId === categoryId);
  const line = inCat.find((l) => l.origin === country) || inCat.find((l) => l.residual);
  return line ? { kind: "line", line } : { kind: "none" };
}

// ---------------------------------------------------------------- seed
// Supplier list from George (13 Oct 2026) plus the extra detail already on
// the page from the Hall and Pickles workbook (price basis, lead times, duty
// risk notes). Venete came from the workbook only.
const SOURCE_NOTE = "Supplier list (Hall and Pickles workbook / George, Oct 2026)";
export const SEED_SUPPLIERS = [
  {
    name: "Tata Steel UK", origin: "UK", supplies: ["Merchant Bar"],
    pricingSources: ["Competition – UK", "Competition – imports", "MEPS", "Kallanish"],
    priceCovers: "everything", deliveryTerms: "", onTimePct: 70, moqMinT: 23, moqMaxT: 23, moqNote: "23 t load",
    ddp: "na", paymentDays: 30, currency: "GBP", priceGbpPerT: 728,
    notes: "On-time entered as 70 in the supplier list — confirm it means 70%.",
  },
  {
    name: "7 Steel", origin: "UK", supplies: ["Merchant Bar"],
    pricingSources: ["Competition – UK", "Competition – imports", "MEPS", "Kallanish", "Market intel"],
    priceCovers: "everything", deliveryTerms: "Delivered to depot", onTimePct: 80, moqMinT: 25, moqMaxT: 28,
    ddp: "na", paymentDays: 60, paymentNote: "Maybe going to 30 days", currency: "GBP", priceGbpPerT: 755,
    leadTimeMin: 2, leadTimeMax: 3, leadTimeUnit: "days", transport: "included", dutyCosts: "Not applicable", otherDuty: "Not applicable", moqNote: "25–28 t load", dutyRiskNote: "Zero",
  },
  {
    name: "LME", origin: "France", supplies: ["Merchant Bar"],
    pricingSources: ["Competition – UK", "Competition – imports", "MEPS", "Kallanish", "Market intel"],
    priceCovers: "except-duty", deliveryTerms: "DAP", onTimePct: 80, moqMinT: 25, moqMaxT: 28,
    ddp: "no", paymentDays: 60, currency: "GBP", priceGbpPerT: 755,
    leadTimeMin: 2, leadTimeMax: 3, leadTimeUnit: "weeks", transport: "included",
    dutyCosts: "Up to 50%", otherDuty: "0%", moqNote: "25–28 t load",
    dutyRiskNote: "Medium to high depending on where we are in the quarter, load by load.",
  },
  {
    name: "Megasa", origin: "Spain", supplies: ["Merchant Bar"],
    pricingSources: ["Competition – UK", "Competition – imports", "MEPS", "Kallanish", "Market intel"],
    priceCovers: "everything", deliveryTerms: "DDP", onTimePct: 80, moqMinT: 25, moqMaxT: 28,
    ddp: "yes", paymentDays: 60, currency: "GBP", priceGbpPerT: 755,
    leadTimeMin: 2, leadTimeMax: 3, leadTimeUnit: "weeks", transport: "included",
    dutyCosts: "Not applicable", otherDuty: "Not applicable", moqNote: "25–28 t load",
    dutyRiskNote: "Low — but risk of non-delivery if quota critical or exceeded.",
  },
  {
    name: "Olifer", origin: "Italy", supplies: ["Merchant Bar"],
    pricingSources: ["Competition – UK", "Competition – imports", "MEPS", "Kallanish", "Market intel"],
    priceCovers: "except-duty", deliveryTerms: "DAP", onTimePct: 70, moqMinT: 25, moqMaxT: 28,
    ddp: "no", paymentDays: 60, currency: "GBP", priceGbpPerT: 800,
    leadTimeMin: 2, leadTimeMax: 3, leadTimeUnit: "weeks", transport: "included",
    dutyCosts: "Up to 50%", otherDuty: "0%", moqNote: "25–28 t load",
    dutyRiskNote: "Medium to high depending on where we are in the quarter, load by load.",
  },
  {
    name: "Venete", origin: "", supplies: ["Merchant Bar"], pricingSources: [],
    priceCovers: "except-duty", deliveryTerms: "DAP", moqMinT: 25, moqMaxT: 28, currency: "GBP", priceGbpPerT: 770,
    leadTimeMin: 5, leadTimeMax: 6, leadTimeUnit: "weeks", transport: "included",
    dutyCosts: "Up to 50%", otherDuty: "0%", moqNote: "25–28 t load",
    dutyRiskNote: "Shipment via vessel, usually plan for start of quarter. Medium risk.",
    notes: "From the workbook only — origin, payment terms and on-time not supplied.",
  },
];

// One-off update from the Supplier Options sheet (13 Oct 2026) for files
// seeded before it. Only fills a field that is empty or still holds the
// earlier seed value, so nothing a user has edited is overwritten.
const EARLIER_SEED = {
  dutyRiskNote: [
    "Zero — UK origin",
    "Duty up to 50%. Medium to high depending on quarter position, load by load.",
    "Low, but risk of non-delivery if quota is critical or exceeded.",
    "Shipment by vessel, usually planned for the start of the quarter. Medium risk.",
  ],
};
const SHEET_FIELDS = ["supplies", "moqMinT", "moqMaxT", "moqNote", "deliveryTerms", "transport", "dutyCosts", "otherDuty", "dutyRiskNote", "leadTimeMin", "leadTimeMax", "leadTimeUnit"];
export const SHEET_VERSION = "supplier-options-2026-10-13";

export function sheetUpdates(existing) {
  const seed = SEED_SUPPLIERS.find((x) => x.name.toLowerCase() === String(existing.name || "").toLowerCase());
  if (!seed || (existing.sheetVersion === SHEET_VERSION)) return [];
  const blank = (v) => v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length);
  const changes = [];
  for (const k of SHEET_FIELDS) {
    if (!(k in seed)) continue;
    const cur = existing[k];
    const next = seed[k];
    if (JSON.stringify(cur) === JSON.stringify(next)) continue;
    if (blank(cur) || (EARLIER_SEED[k] || []).includes(cur)) changes.push({ field: k, from: blank(cur) ? null : cur, to: next });
  }
  return changes;
}

export function seedSuppliers(now = new Date().toISOString()) {
  return SEED_SUPPLIERS.map(({ priceGbpPerT, ...raw }) => {
    const { supplier } = validateSupplier(raw);
    supplier.contacts = [];
    supplier.rfqs = [];
    supplier.activity = [{ at: now, by: "setup", action: "created", detail: SOURCE_NOTE }];
    supplier.sheetVersion = SHEET_VERSION;
    supplier.quotes = priceGbpPerT ? [{
      id: randomUUID(), date: now.slice(0, 10), pricePerT: priceGbpPerT, currency: "GBP",
      covers: supplier.priceCovers, channel: "list", note: SOURCE_NOTE, by: "setup", at: now, productId: null, tonnage: null, validUntil: null,
    }] : [];
    return supplier;
  });
}

// ---------------------------------------------------------------- validation
const pickList = (v, allowed) => (Array.isArray(v) ? v : String(v || "").split(/[,;]/)).map((x) => String(x).trim()).filter((x) => allowed.includes(x));

export function validateSupplier(raw = {}) {
  const errors = {};
  const s = {
    name: str(raw.name, 120),
    type: SUPPLIER_TYPES.includes(raw.type) ? raw.type : "",
    standing: raw.standing in SUPPLIER_STANDING ? raw.standing : "active",
    origin: str(raw.origin, 60),
    supplies: [...new Set(Array.isArray(raw.supplies) ? raw.supplies.map((x) => str(x, 60)).filter(Boolean) : [])].slice(0, 12),
    pricingSources: [...new Set(pickList(raw.pricingSources, PRICING_SOURCES))],
    priceCovers: raw.priceCovers in PRICE_COVERS ? raw.priceCovers : "",
    deliveryTerms: DELIVERY_TERMS.includes(raw.deliveryTerms) ? raw.deliveryTerms : "",
    onTimePct: num(raw.onTimePct),
    moqMinT: num(raw.moqMinT),
    moqMaxT: num(raw.moqMaxT),
    moqNote: str(raw.moqNote, 60),
    ddp: raw.ddp in DDP_OPTIONS ? raw.ddp : "",
    paymentDays: num(raw.paymentDays),
    paymentNote: str(raw.paymentNote, 120),
    currency: CURRENCIES.includes(raw.currency) ? raw.currency : "GBP",
    leadTimeMin: num(raw.leadTimeMin),
    leadTimeMax: num(raw.leadTimeMax),
    leadTimeUnit: raw.leadTimeUnit === "days" ? "days" : "weeks",
    transport: ["included", "extra"].includes(raw.transport) ? raw.transport : "",
    dutyCosts: str(raw.dutyCosts, 60),
    otherDuty: str(raw.otherDuty, 60),
    dutyRiskNote: str(raw.dutyRiskNote, 300),
    // UK CBAM: how the mill makes steel, verified emissions and carbon price already paid
    productionRoute: ["eaf", "bf-bof"].includes(raw.productionRoute) ? raw.productionRoute : "",
    emissionsPerT: num(raw.emissionsPerT),
    carbonPricePaidPerT: num(raw.carbonPricePaidPerT),
    website: str(raw.website, 200),
    notes: str(raw.notes, 1000),
  };
  if (s.website && !/^https?:\/\//i.test(s.website)) s.website = `https://${s.website}`;
  if (!s.name) errors.name = "Enter the supplier name.";
  if (s.origin && !ORIGINS.includes(s.origin)) errors.origin = "Pick a country from the list.";
  if (s.onTimePct !== null && (s.onTimePct < 0 || s.onTimePct > 100)) errors.onTimePct = "Use 0–100%.";
  if (s.moqMinT !== null && s.moqMinT < 0) errors.moqMinT = "Cannot be negative.";
  if (s.moqMaxT !== null && s.moqMinT !== null && s.moqMaxT < s.moqMinT) errors.moqMaxT = "Max must be at least the min.";
  if (s.paymentDays !== null && (s.paymentDays < 0 || s.paymentDays > 365)) errors.paymentDays = "Use 0–365 days.";
  if (s.leadTimeMin !== null && s.leadTimeMin < 0) errors.leadTimeMin = "Cannot be negative.";
  if (s.leadTimeMax !== null && s.leadTimeMin !== null && s.leadTimeMax < s.leadTimeMin) errors.leadTimeMax = "Max must be at least the min.";
  if (s.emissionsPerT !== null && (s.emissionsPerT < 0 || s.emissionsPerT > 5)) errors.emissionsPerT = "Use 0–5 t CO₂e per tonne.";
  if (s.carbonPricePaidPerT !== null && (s.carbonPricePaidPerT < 0 || s.carbonPricePaidPerT > 500)) errors.carbonPricePaidPerT = "Use £0–500 per tonne of CO₂e.";
  if (s.website && !/^https?:\/\/[^\s/]+\.[^\s]+$/i.test(s.website)) errors.website = "Enter a web address like www.example.com.";
  return { supplier: s, errors, valid: Object.keys(errors).length === 0 };
}

export function validateContact(raw = {}) {
  const errors = {};
  const c = {
    name: str(raw.name, 80),
    role: str(raw.role, 80),
    email: str(raw.email, 120).toLowerCase(),
    phone: str(raw.phone, 40),
    primary: Boolean(raw.primary),
  };
  if (!c.name) errors.name = "Enter a name.";
  if (c.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email)) errors.email = "Enter a valid email address.";
  if (c.phone && !/^[+()\d\s.-]{6,}$/.test(c.phone)) errors.phone = "Enter a valid phone number.";
  if (!c.email && !c.phone) errors.email = "Add an email or a phone number.";
  return { contact: c, errors, valid: Object.keys(errors).length === 0 };
}

export function validateQuote(raw = {}, { asOf = today() } = {}) {
  const errors = {};
  const q = {
    date: str(raw.date, 10) || asOf,
    pricePerT: num(raw.pricePerT),
    currency: CURRENCIES.includes(raw.currency) ? raw.currency : "GBP",
    covers: raw.covers in PRICE_COVERS ? raw.covers : "",
    channel: raw.channel in QUOTE_CHANNELS ? raw.channel : "email",
    productId: raw.productId ? str(raw.productId, 40) : null,
    tonnage: num(raw.tonnage),
    validUntil: str(raw.validUntil, 10) || null,
    contactId: raw.contactId ? str(raw.contactId, 40) : null,
    note: str(raw.note, 500),
  };
  if (q.pricePerT === null) errors.pricePerT = "Enter the price per tonne.";
  else if (q.pricePerT <= 0 || q.pricePerT > 20_000) errors.pricePerT = "Use a price between 1 and 20,000 per tonne.";
  if (!isDate(q.date)) errors.date = "Use a valid date.";
  else if (q.date > asOf) errors.date = "The quote date cannot be in the future.";
  if (q.validUntil && !isDate(q.validUntil)) errors.validUntil = "Use a valid date.";
  else if (q.validUntil && isDate(q.date) && q.validUntil < q.date) errors.validUntil = "Must be on or after the quote date.";
  if (q.tonnage !== null && q.tonnage < 0) errors.tonnage = "Cannot be negative.";
  return { quote: q, errors, valid: Object.keys(errors).length === 0 };
}

export function validateRfq(raw = {}) {
  const errors = {};
  const lines = (Array.isArray(raw.lines) ? raw.lines : []).slice(0, 40).map((l) => ({
    productId: l.productId ? str(l.productId, 40) : null,
    name: str(l.name, 120),
    tonnage: num(l.tonnage),
  })).filter((l) => l.name);
  const r = {
    lines,
    contactId: raw.contactId ? str(raw.contactId, 40) : null,
    channel: raw.channel === "copy" ? "copy" : "email",
    deliverBy: isDate(str(raw.deliverBy, 10)) ? str(raw.deliverBy, 10) : null,
  };
  if (!lines.length) errors.lines = "Pick at least one product.";
  return { rfq: r, errors, valid: Object.keys(errors).length === 0 };
}

// ---------------------------------------------------------------- derived
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export function supplierMetrics(s, asOf = today()) {
  const quotes = [...(s.quotes || [])].sort((a, b) => (b.date + (b.at || "")).localeCompare(a.date + (a.at || "")));
  const latest = quotes[0] || null;
  const openRfq = (s.rfqs || []).filter((r) => r.status === "open").sort((a, b) => b.at.localeCompare(a.at))[0] || null;
  const covers = latest?.covers || s.priceCovers;
  const dutyExposed = Boolean(latest) && Boolean(s.origin) && s.origin !== "UK" && s.origin !== "Ukraine" && covers !== "everything";
  // Without an origin we can't tell whether duty could apply.
  const dutyUnknown = Boolean(latest) && !s.origin && covers !== "everything";
  return {
    pricePerT: latest ? latest.pricePerT : null,
    currency: latest ? latest.currency : s.currency,
    priceDate: latest ? latest.date : null,
    priceChannel: latest ? latest.channel : null,
    priceAgeDays: latest ? daysBetween(latest.date, asOf) : null,
    priceExpired: Boolean(latest && latest.validUntil && latest.validUntil < asOf),
    covers,
    // DDP: can the supplier import it and pay the duty? (na = UK supply, no import)
    ddp: s.ddp || (s.origin === "UK" ? "na" : ""),
    importer: s.origin === "UK" ? "none" : s.ddp === "yes" && covers === "everything" ? "supplier" : "you",
    quoteCount: quotes.length,
    // Worst case if the origin's quota line is used up: 50% steel duty on
    // top. Duty is charged on customs value; the delivered price is used as a
    // conservative stand-in until freight is split out.
    worstCasePerT: dutyUnknown ? null : dutyExposed ? Math.round(latest.pricePerT * 1.5) : latest ? latest.pricePerT : null,
    dutyExposed,
    dutyUnknown,
    awaitingQuote: openRfq ? { since: openRfq.at.slice(0, 10), days: daysBetween(openRfq.at.slice(0, 10), asOf), lines: openRfq.lines.length } : null,
    primaryContact: (s.contacts || []).find((c) => c.primary) || (s.contacts || [])[0] || null,
  };
}

export function newId() { return randomUUID(); }
