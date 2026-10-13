// Market price benchmarks (MEPS, Kallanish, market intel …) and the
// "competition" series built from your own supplier quotes. Pure functions —
// the server stores series in var/benchmarks.json.
//
// Ingestion routes:
//   • upload / paste an export (Kallanish Price Analyser → Excel, MEPS tables,
//     any CSV) — long format (date, series, price …) or wide format (date
//     column + one column per series)
//   • manual price (market intel, a call with a trader)
//   • API feed — a URL + token per source in .env, polled by the server, for
//     when you hold a data licence
//   • competition — computed from logged supplier quotes, nothing to import

export const SOURCES = {
  MEPS: { label: "MEPS", url: "https://mepsinternational.com", method: "Upload the MEPS price table export, or connect a data feed" },
  Kallanish: { label: "Kallanish", url: "https://www.kallanish.com", method: "Price Analyser → Export to Excel, then upload" },
  Fastmarkets: { label: "Fastmarkets", url: "https://www.fastmarkets.com", method: "Upload an export or connect a data feed" },
  Argus: { label: "Argus", url: "https://www.argusmedia.com", method: "Upload an export or connect a data feed" },
  ONS: { label: "ONS producer prices", url: "https://www.ons.gov.uk/economy/inflationandpriceindices", method: "Official UK steel price indices — pulled automatically every day, free" },
  LME: { label: "LME steel (Metals-API)", url: "https://metals-api.com", method: "Daily LME steel prices — add a Metals-API key in Settings to switch on" },
  "Market intel": { label: "Market intel", url: null, method: "Add prices you hear from traders, mills and customers" },
  Other: { label: "Other", url: null, method: "Upload or add manually" },
};
export const REGIONS = ["UK", "EU", "Turkey", "North Europe", "South Europe", "Asia", "Global", "Other"];
export const BASES = ["Delivered UK", "Ex-works", "DDP UK", "DAP UK", "CFR UK", "FOB", "Domestic", "Other"];
export const CURRENCIES = ["GBP", "EUR", "USD"];

const today = () => new Date().toISOString().slice(0, 10);
const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export function validateSeries(raw = {}) {
  const errors = {};
  const s = {
    name: str(raw.name, 120),
    source: raw.source in SOURCES ? raw.source : "",
    group: str(raw.group, 60),
    region: REGIONS.includes(raw.region) ? raw.region : "",
    basis: BASES.includes(raw.basis) ? raw.basis : "",
    currency: CURRENCIES.includes(raw.currency) ? raw.currency : "GBP",
    keys: [...new Set((Array.isArray(raw.keys) ? raw.keys : String(raw.keys || "").split("|")).map((k) => normKey(k)).filter(Boolean))].slice(0, 10),
    notes: str(raw.notes, 500),
  };
  if (!s.name) errors.name = "Name the price series, e.g. UK merchant bar, delivered.";
  if (!s.source) errors.source = "Pick where the price comes from.";
  if (!s.group) errors.group = "Pick the product group it benchmarks.";
  if (!s.keys.includes(normKey(s.name))) s.keys.unshift(normKey(s.name));
  return { series: s, errors, valid: Object.keys(errors).length === 0 };
}

export function validatePoint(raw = {}, { asOf = today() } = {}) {
  const errors = {};
  const p = { date: parseDate(raw.date) || "", price: num(raw.price), note: str(raw.note, 200) };
  if (!isDate(p.date)) errors.date = "Use a valid date.";
  else if (p.date > asOf) errors.date = "The date cannot be in the future.";
  if (p.price === null) errors.price = "Enter the price per tonne.";
  else if (p.price <= 0 || p.price > 20_000) errors.price = "Use a price between 1 and 20,000 per tonne.";
  return { point: p, errors, valid: Object.keys(errors).length === 0 };
}

// Insert or replace points by date; returns the merged, date-sorted list.
export function mergePoints(existing = [], incoming = []) {
  const byDate = new Map(existing.map((p) => [p.date, p]));
  for (const p of incoming) byDate.set(p.date, { ...byDate.get(p.date), ...p });
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function latest(points = [], asOf = today()) {
  const pts = points.filter((p) => p.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  const last = pts[pts.length - 1] || null;
  const prev = pts[pts.length - 2] || null;
  return last ? { ...last, change: prev ? last.price - prev.price : null, prevDate: prev ? prev.date : null } : null;
}

// ---------------------------------------------------------------- parsing
export function normKey(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function num(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  let s = String(v).trim().replace(/[£$€\s]|gbp|eur|usd|\/t|per\s*t(onne)?/gi, "");
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, "").replace(",", "."); // 1.234,5 (EU)
  else s = s.replace(/,/g, "");
  if (s === "" || s === "-" || /^n\/?a$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const pad = (n) => String(n).padStart(2, "0");
export function parseDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || /^\d{5}(\.\d+)?$/.test(String(v).trim())) {
    // Excel serial date
    const serial = Number(v);
    if (serial > 20_000 && serial < 80_000) return new Date(Date.UTC(1899, 11, 30) + Math.round(serial) * 86_400_000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/); // UK day-first
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${pad(m[2])}-${pad(m[1])}`; }
  const monthOf = (w) => MONTHS[String(w).slice(0, 4).toLowerCase()] || MONTHS[String(w).slice(0, 3).toLowerCase()] || null;
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s,-]+(\d{2,4})$/); // 13-Oct-2026 / 13 October 2026
  if (m && monthOf(m[2])) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${pad(monthOf(m[2]))}-${pad(m[1])}`; }
  m = s.match(/^([A-Za-z]{3,9})[\s,-]*(\d{4})$/); // Oct 2026 (monthly) → 1st of month
  if (m && monthOf(m[1])) return `${m[2]}-${pad(monthOf(m[1]))}-01`;
  m = s.match(/^(\d{4})[/-](\d{1,2})$/); // 2026-10
  if (m) return `${m[1]}-${pad(m[2])}-01`;
  return null;
}

function splitRows(text) {
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n").filter((l) => l.trim());
  if (!lines.length) return [];
  const sample = lines.slice(0, 12);
  const count = (re) => Math.max(...sample.map((l) => (l.match(re) || []).length));
  const delim = count(/\t/g) > 0 ? "\t" : count(/;/g) > count(/,/g) ? ";" : ",";
  return lines.map((line) => {
    if (delim === "\t") return line.split("\t").map((c) => c.trim());
    const out = [];
    let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
      else if (ch === delim && !q) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

const HEAD = {
  date: ["date", "assessment date", "price date", "period", "month", "week", "published"],
  series: ["series", "name", "product", "description", "price series", "assessment", "item", "benchmark", "symbol"],
  price: ["price", "value", "mid", "close", "assessment price", "average", "avg", "settle", "gbp t", "eur t", "usd t"],
  low: ["low", "min"],
  high: ["high", "max"],
  currency: ["currency", "ccy", "cur"],
};
const findCol = (heads, names) => heads.findIndex((h) => names.includes(h));

// Accepts rows (array of arrays, e.g. from an .xlsx) or text (CSV / TSV /
// pasted from Excel). Returns { format, rows: [{date, series, price, currency}], errors }.
export function parseBenchmarkTable(input, { defaultSeries = "" } = {}) {
  const rows = Array.isArray(input) ? input.map((r) => r.map((c) => (c === null || c === undefined ? "" : c))) : splitRows(input);
  if (rows.length < 2) return { format: null, rows: [], errors: ["Paste or upload a table with a header row and at least one price."] };
  // Skip title lines above the header (exports often start with a report name).
  let h = 0;
  while (h < Math.min(rows.length - 1, 8) && rows[h].filter((c) => String(c).trim()).length < 2) h++;
  const heads = rows[h].map((c) => normKey(c));
  const body = rows.slice(h + 1).filter((r) => r.some((c) => String(c).trim()));
  const dateCol = findCol(heads, HEAD.date) >= 0 ? findCol(heads, HEAD.date) : heads.findIndex((_, i) => body.slice(0, 5).every((r) => parseDate(r[i])));
  if (dateCol < 0) return { format: null, rows: [], errors: ["Couldn't find a date column. Name it Date, or put dates in the first column."] };
  const seriesCol = findCol(heads, HEAD.series);
  let priceCol = findCol(heads, HEAD.price);
  const lowCol = findCol(heads, HEAD.low), highCol = findCol(heads, HEAD.high);
  const curCol = findCol(heads, HEAD.currency);
  const out = [];
  const errors = [];
  const curFromHead = (hname) => (/\beur\b|€/.test(hname) ? "EUR" : /\busd\b|\$/.test(hname) ? "USD" : /\bgbp\b|£/.test(hname) ? "GBP" : null);

  if (seriesCol >= 0 || (priceCol >= 0 && defaultSeries) || (priceCol < 0 && lowCol >= 0 && highCol >= 0)) {
    // long format
    body.forEach((r, i) => {
      const date = parseDate(r[dateCol]);
      let price = priceCol >= 0 ? num(r[priceCol]) : null;
      if (price === null && lowCol >= 0 && highCol >= 0) { const lo = num(r[lowCol]), hi = num(r[highCol]); if (lo !== null && hi !== null) price = (lo + hi) / 2; }
      const series = seriesCol >= 0 ? String(r[seriesCol] || "").trim() : defaultSeries;
      if (!date || price === null || !series) { errors.push(`Row ${h + i + 2}: skipped (${!date ? "no date" : price === null ? "no price" : "no series name"}).`); return; }
      out.push({ date, series, price, currency: curCol >= 0 ? String(r[curCol]).toUpperCase().slice(0, 3) : curFromHead(heads[priceCol] || "") });
    });
    return { format: "long", rows: out, errors };
  }
  // wide format: every other column is a series
  const cols = heads.map((name, i) => ({ i, name: String(rows[h][i] || "").trim() })).filter((c) => c.i !== dateCol && c.name);
  if (!cols.length) return { format: null, rows: [], errors: ["Couldn't find any price columns."] };
  body.forEach((r) => {
    const date = parseDate(r[dateCol]);
    if (!date) return;
    for (const c of cols) {
      const price = num(r[c.i]);
      if (price !== null) out.push({ date, series: c.name, price, currency: curFromHead(normKey(c.name)) });
    }
  });
  if (!out.length) errors.push("No prices found under the series columns.");
  return { format: "wide", rows: out, errors };
}

// Group parsed rows by series name and suggest which saved series each maps to.
export function planImport(rows, seriesList) {
  const groups = new Map();
  for (const r of rows) {
    const k = normKey(r.series);
    if (!groups.has(k)) groups.set(k, { key: k, name: r.series, rows: [], currency: r.currency || null });
    groups.get(k).rows.push(r);
  }
  return [...groups.values()].map((g) => {
    const match = seriesList.find((s) => (s.keys || []).includes(g.key));
    const dates = g.rows.map((r) => r.date).sort();
    return {
      key: g.key, name: g.name, count: g.rows.length, from: dates[0], to: dates[dates.length - 1], currency: g.currency,
      latestPrice: g.rows.find((r) => r.date === dates[dates.length - 1]).price,
      seriesId: match ? match.id : null, seriesName: match ? match.name : null,
    };
  });
}

// ---------------------------------------------------------------- competition
// Built from supplier quotes: for each date a quote was logged, the average
// (and lowest) of every UK / import supplier's latest quote as of that date.
export function competitionSeries(suppliers, group, fx = { GBP: 1 }) {
  const relevant = suppliers.filter((s) => (s.supplies || []).includes(group) && s.origin);
  const make = (kind, list) => {
    const quotes = list.flatMap((s) => (s.quotes || []).map((q) => ({ ...q, supplierId: s.id, supplier: s.name })))
      .filter((q) => fx[q.currency || "GBP"]).sort((a, b) => (a.date + (a.at || "")).localeCompare(b.date + (b.at || "")));
    const dates = [...new Set(quotes.map((q) => q.date))].sort();
    const points = dates.map((d) => {
      const latestBy = new Map();
      for (const q of quotes) if (q.date <= d) latestBy.set(q.supplierId, q);
      const prices = [...latestBy.values()].map((q) => q.pricePerT * fx[q.currency || "GBP"]);
      return { date: d, price: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length), low: Math.round(Math.min(...prices)), n: prices.length };
    });
    return {
      id: `competition-${kind}-${normKey(group).replace(/ /g, "-")}`, computed: true,
      name: kind === "uk" ? `Competition – UK (${group})` : `Competition – imports (${group})`,
      source: kind === "uk" ? "Competition – UK" : "Competition – imports", group, region: kind === "uk" ? "UK" : "Imports",
      basis: "Supplier quotes (average)", currency: "GBP", points, suppliers: list.map((s) => s.name),
    };
  };
  const uk = relevant.filter((s) => s.origin === "UK");
  const imp = relevant.filter((s) => s.origin !== "UK");
  return [uk.length ? make("uk", uk) : null, imp.length ? make("imports", imp) : null].filter((s) => s && s.points.length);
}

// One supplier's latest quote against each benchmark's latest price (GBP).
export function compareQuote(quoteGbp, seriesList, fx = { GBP: 1 }, asOf = today()) {
  return seriesList.map((s) => {
    const l = latest(s.points, asOf);
    const rate = fx[s.currency || "GBP"];
    if (!l || !rate || !Number.isFinite(quoteGbp)) return { seriesId: s.id, name: s.name, source: s.source, benchmark: null };
    const bench = l.price * rate;
    return {
      seriesId: s.id, name: s.name, source: s.source, basis: s.basis, date: l.date, benchmark: Math.round(bench * 100) / 100,
      diff: Math.round((quoteGbp - bench) * 100) / 100, pct: Math.round(((quoteGbp - bench) / bench) * 1000) / 10,
      ageDays: Math.round((Date.parse(asOf) - Date.parse(l.date)) / 86_400_000),
    };
  });
}
