// Competition analysis from public data.
//
//  HMRC importer details (monthly, uktradeinfo.com): every company importing
//  from outside the UK, with the 8-digit commodity codes it imported that
//  month. No tonnage per company: HMRC doesn't publish it.
//  HMRC overseas trade bulk data (BDSimp): UK import tonnes and value by
//  commodity code, origin and month. That's market-wide volume.
//  Companies House accounts (iXBRL): stock (inventories) at each year end.
//
// Pure functions here; the server does the downloading and storage.

import { inflateRawSync } from "node:zlib";
import { createHash } from "node:crypto";

export const HMRC_PAGES = [
  "https://www.uktradeinfo.com/trade-data/latest-bulk-datasets/",
  "https://www.uktradeinfo.com/trade-data/latest-bulk-datasets/bulk-datasets-archive/",
];
export const CH_API = "https://api.company-information.service.gov.uk";

// Steel goods we follow: all of chapter 72 and chapter 73 (tubes, sections,
// structures, fasteners), matching what stockholders sell.
export const isSteelCode = (c) => /^7[23]\d{6}$/.test(c);

// ---------------------------------------------------------------- names
// Same rules as the Python pipeline (src/utils.py), so ids line up with
// output/company_activity.csv.
export function normalizeName(value = "") {
  let t = String(value).toUpperCase().trim();
  t = t.replace(/LIMITED/g, "LTD").replace(/PUBLIC LIMITED COMPANY/g, "PLC").replace(/&/g, " AND ");
  return t.replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
export const normalizePostcode = (p = "") => String(p).toUpperCase().replace(/[^A-Z0-9]/g, "");
export const companyId = (nameNorm, postcodeNorm) => createHash("md5").update(`${nameNorm}|${postcodeNorm}`).digest("hex").slice(0, 12);
// For matching a name you type to importer names
export const matchKey = (s) => normalizeName(s).replace(/\b(LTD|PLC|LLP|UK|GROUP|HOLDINGS|THE|AND|CO|COMPANY|STEEL|STEELS|METALS?)\b/g, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- zip
export function readZip(buf) {
  const out = [];
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66_000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a zip file");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(start, start + csize);
    out.push({ name, data: method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// Find importersYYMM.zip / bdsimpYYMM.zip links on the HMRC pages.
export function findBulkLinks(html, base = "https://www.uktradeinfo.com") {
  const links = { importers: {}, imports: {} };
  for (const m of String(html).matchAll(/href="([^"]*?(importers|bdsimp)(\d{2})(\d{2})\.zip)"/gi)) {
    const url = m[1].startsWith("http") ? m[1] : `${base}${m[1].startsWith("/") ? "" : "/"}${m[1]}`;
    const period = `20${m[3]}${m[4]}`;
    links[m[2].toLowerCase() === "importers" ? "importers" : "imports"][period] = url;
  }
  return links;
}

// ---------------------------------------------------------------- HMRC files
// Importer details: tab separated; 0 period, 2 name, 3–7 address, 8 postcode,
// 9+ commodity codes.
export function parseImporters(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 10) continue;
    const period = parts[0].trim();
    const name = parts[2].trim();
    if (!/^\d{6}$/.test(period) || !name) continue;
    const codes = [...new Set(parts.slice(9).map((c) => c.trim()).filter(isSteelCode))];
    if (!codes.length) continue;
    const nameNorm = normalizeName(name), postcode = parts[8].trim();
    rows.push({ period, name, nameNorm, postcode, id: companyId(nameNorm, normalizePostcode(postcode)), town: (parts.slice(3, 8).map((x) => x.trim()).filter(Boolean).slice(-1)[0] || ""), codes });
  }
  return rows;
}

// Overseas trade imports: fixed width (see src/settings.py). Totals by
// month and commodity code, with tonnes by origin.
export function parseImports(text) {
  const agg = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (line.length < 85) continue;
    const code = line.slice(13, 21).trim();
    if (!isSteelCode(code)) continue;
    const period = line.slice(0, 6).trim();
    if (!/^\d{6}$/.test(period)) continue;
    const value = Number(line.slice(44, 56).trim()) || 0;
    const kg = Number(line.slice(56, 68).trim()) || 0;
    const origin = line.slice(40, 42).trim() || "??";
    const p = (agg[period] ||= {});
    const c = (p[code] ||= { t: 0, v: 0, o: {} });
    c.t += kg / 1000; c.v += value; c.o[origin] = (c.o[origin] || 0) + kg / 1000;
  }
  for (const p of Object.values(agg)) for (const c of Object.values(p)) { c.t = Math.round(c.t * 10) / 10; for (const k of Object.keys(c.o)) c.o[k] = Math.round(c.o[k] * 10) / 10; }
  return agg;
}

// Starter data from the Python pipeline's summary (no monthly detail).
export function parseActivityCsv(text) {
  const lines = String(text).split(/\r?\n/).filter(Boolean);
  const head = lines.shift().split(",");
  const ix = (k) => head.indexOf(k);
  return lines.map((l) => {
    const c = l.split(",");
    return { id: c[ix("company_id")], name: c[ix("company_name_raw")], nameNorm: c[ix("company_name_normalized")], postcode: c[ix("postcode")], firstSeen: c[ix("first_seen")], lastSeen: c[ix("last_seen")],
      activeMonths: Number(c[ix("active_months_total")]) || 0, codes: (c[ix("commodity_codes")] || "").split("|").filter(Boolean),
      byYear: { 2024: Number(c[ix("active_months_2024")]) || 0, 2025: Number(c[ix("active_months_2025")]) || 0, 2026: Number(c[ix("active_months_2026")]) || 0 }, status: c[ix("company_status")] || "" };
  }).filter((r) => r.id && r.name);
}

// ---------------------------------------------------------------- analysis
const prefixMatch = (code, yours) => yours.some((y) => code.startsWith(y.slice(0, 6)));

export function monthsList(periods, n) { return [...periods].sort().slice(-n); }

// One competitor's pattern from monthly importer data.
export function analyseCompany(co, { months, yourCodes = [] }) {
  const strip = months.map((p) => ({ p, codes: (co.m && co.m[p]) || null }));
  const active = (list) => list.filter((x) => x.codes).length;
  const last3 = strip.slice(-3), prev = strip.slice(-15, -3);
  const rateRecent = last3.length ? active(last3) / last3.length : 0;
  const ratePrev = prev.length ? active(prev) / prev.length : 0;
  const allCodes = new Set(strip.flatMap((x) => x.codes || []));
  const recentCodes = new Set(strip.slice(-6).flatMap((x) => x.codes || []));
  const olderCodes = new Set(strip.slice(0, -6).flatMap((x) => x.codes || []));
  const newCodes = [...recentCodes].filter((c) => !olderCodes.has(c));
  const overlap = [...allCodes].filter((c) => prefixMatch(c, yourCodes));
  const lastActive = [...strip].reverse().find((x) => x.codes);
  const breadthRecent = last3.reduce((t, x) => t + (x.codes ? x.codes.length : 0), 0) / Math.max(1, active(last3));
  const breadthPrev = prev.reduce((t, x) => t + (x.codes ? x.codes.length : 0), 0) / Math.max(1, active(prev));
  let signal = "steady", note = "Imports at its usual rhythm.";
  if (!lastActive) { signal = "quiet"; note = "No imports in the data."; }
  else if (strip.slice(-3).every((x) => !x.codes) && ratePrev > 0.4) { signal = "quiet"; note = `Hasn't imported since ${lastActive.p.slice(4)}/${lastActive.p.slice(0, 4)}. They may be living off stock or buying in the UK.`; }
  else if (rateRecent >= 0.99 && ratePrev < 0.7) { signal = "stepping-up"; note = "Importing every month lately, more often than before. Possibly building stock."; }
  else if (breadthRecent > breadthPrev * 1.4 && breadthRecent - breadthPrev >= 2) { signal = "stepping-up"; note = `Buying a wider range lately (${breadthRecent.toFixed(1)} codes a month vs ${breadthPrev.toFixed(1)}).`; }
  else if (rateRecent < ratePrev - 0.4) { signal = "slowing"; note = "Importing less often than usual."; }
  if (newCodes.length >= 2 && signal === "steady") { signal = "expanding"; note = `Started importing ${newCodes.length} new product codes in the last 6 months.`; }
  return {
    strip: strip.map((x) => ({ p: x.p, n: x.codes ? x.codes.length : 0, yours: x.codes ? x.codes.filter((c) => prefixMatch(c, yourCodes)).length : 0 })),
    monthsActive: active(strip), monthsShown: strip.length, lastActive: lastActive ? lastActive.p : null,
    codes: [...allCodes].sort(), overlapCodes: overlap.sort(), newCodes: newCodes.sort(), signal, note,
    rateRecent, ratePrev,
  };
}

// Who else imports the codes you buy (last n months).
export function similarImporters(companies, { months, yourCodes, exclude = new Set(), limit = 12 }) {
  const out = [];
  for (const [id, co] of Object.entries(companies)) {
    if (exclude.has(id)) continue;
    const codes = new Set(months.flatMap((p) => (co.m && co.m[p]) || []));
    const overlap = [...codes].filter((c) => prefixMatch(c, yourCodes));
    if (!overlap.length) continue;
    const monthsActive = months.filter((p) => co.m && co.m[p] && co.m[p].some((c) => prefixMatch(c, yourCodes))).length;
    out.push({ id, name: co.name, postcode: co.postcode, town: co.town || "", overlap: overlap.length, monthsActive, score: overlap.length * 2 + monthsActive });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

// UK import tonnes for your codes, by month, with how unusual each month is.
export function marketVolume(tradeMonths, yourCodes) {
  const periods = Object.keys(tradeMonths).sort();
  const rows = periods.map((p) => {
    let t = 0, v = 0; const origins = {};
    for (const [code, c] of Object.entries(tradeMonths[p])) {
      if (!prefixMatch(code, yourCodes)) continue;
      t += c.t; v += c.v;
      for (const [o, ot] of Object.entries(c.o || {})) origins[o] = (origins[o] || 0) + ot;
    }
    return { p, tonnes: Math.round(t), value: Math.round(v), perT: t ? v / t : null, origins };
  });
  rows.forEach((r, i) => {
    const prior = rows.slice(Math.max(0, i - 12), i).map((x) => x.tonnes).filter((x) => x > 0);
    r.avg12 = prior.length >= 3 ? prior.reduce((a, b) => a + b, 0) / prior.length : null;
    r.vsAvgPct = r.avg12 ? ((r.tonnes - r.avg12) / r.avg12) * 100 : null;
  });
  return rows;
}

// ---------------------------------------------------------------- Companies House iXBRL
export function parseAccountsIxbrl(xhtml) {
  const html = String(xhtml);
  const contexts = {};
  for (const m of html.matchAll(/<(?:xbrli:)?context[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/(?:xbrli:)?context>/gi)) {
    const body = m[2];
    const dims = /<(?:xbrli:)?segment|xbrldi:explicitMember|xbrldi:typedMember/i.test(body);
    const instant = (body.match(/<(?:xbrli:)?instant>([^<]+)</i) || [])[1];
    const end = (body.match(/<(?:xbrli:)?endDate>([^<]+)</i) || [])[1];
    const start = (body.match(/<(?:xbrli:)?startDate>([^<]+)</i) || [])[1];
    contexts[m[1]] = { instant: instant && instant.trim(), end: end && end.trim(), start: start && start.trim(), dims };
  }
  const facts = [];
  for (const m of html.matchAll(/<ix:nonFraction([^>]*)>([\s\S]*?)<\/ix:nonFraction>/gi)) {
    const attrs = m[1];
    const name = (attrs.match(/name="([^"]+)"/) || [])[1] || "";
    const ctx = (attrs.match(/contextRef="([^"]+)"/) || [])[1] || "";
    const scale = Number((attrs.match(/scale="(-?\d+)"/) || [])[1] || 0);
    const neg = /sign="-"/.test(attrs);
    const txt = m[2].replace(/<[^>]+>/g, "").replace(/[,\s]/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(txt) && txt !== "-") continue;
    const val = (txt === "-" ? 0 : Number(txt)) * 10 ** scale * (neg ? -1 : 1);
    facts.push({ name: name.split(":").pop(), ctx: contexts[ctx] || {}, val });
  }
  const series = (re, kind) => {
    const by = new Map();
    for (const f of facts) {
      if (!re.test(f.name) || f.ctx.dims) continue;
      const date = kind === "instant" ? f.ctx.instant : f.ctx.end;
      if (!date) continue;
      if (!by.has(date) || Math.abs(f.val) > Math.abs(by.get(date))) by.set(date, f.val);
    }
    return [...by.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => b.date.localeCompare(a.date));
  };
  return {
    stock: series(/^(Inventories|Stocks|TotalInventories|StocksInventory)$/i, "instant"),
    turnover: series(/^(TurnoverRevenue|Turnover|Revenue|TurnoverGrossOperatingRevenue)$/i, "duration"),
    cash: series(/^(CashBankOnHand|CashAtBankAndInHand|CashCashEquivalents)$/i, "instant"),
  };
}
