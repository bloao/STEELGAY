// Live market data that can be pulled automatically, no subscription needed.
//
// • ONS producer price indices for steel — official UK statistics, free, no
//   key. Monthly, 2015 = 100. Endpoint: ons.gov.uk/…/timeseries/{id}/ppi/data
// • Metals-API — daily LME steel prices (e.g. STEEL-RE rebar FOB Turkey),
//   needs an access key (metals-api.com; paste it in Settings or set
//   METALS_API_KEY in .env).
//
// MEPS / Kallanish stay on the upload route (or their own licensed feed via
// MEPS_FEED_URL etc. — see benchmark-feed.mjs).

export const ONS_SERIES = [
  { id: "GHAV", name: "UK steel – domestic producer prices (ONS)", short: "ONS UK domestic steel", region: "UK", note: "PPI input index: domestic basic iron, steel, tubes and hollow sections (C241–C243), 2015 = 100" },
  { id: "GHCZ", name: "UK steel – imported producer prices (ONS)", short: "ONS UK imported steel", region: "Imports", note: "PPI input index: imported basic iron, steel, tubes and hollow sections (C241–C243), 2015 = 100" },
  { id: "EZWP", name: "Steel import price index (ONS)", short: "ONS steel import prices", region: "Imports", note: "Import price index: basic iron, steel and ferro-alloys (C241), 2015 = 100" },
];

export const METALS_DEFAULT_SYMBOLS = ["STEEL-RE", "STEEL-SC"];
export const METALS_SYMBOLS = {
  "STEEL-RE": { name: "LME steel rebar, FOB Turkey", group: "Reinforcing", basis: "FOB", region: "Turkey" },
  "STEEL-SC": { name: "LME steel scrap, CFR Turkey", group: "Merchant Bar", basis: "CFR", region: "Turkey", kind: "input", note: "Scrap drives electric-arc merchant bar and rebar prices" },
  "STEEL-HR": { name: "LME steel HRC, FOB China", group: "Plate & Sheet", basis: "FOB", region: "Asia" },
};

const MONTHS = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };

export const onsUrl = (id) => `https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/${id.toLowerCase()}/ppi/data`;

// ONS JSON: { months: [{ date: "2026 AUG", value: "204.2", updateDate }] }
export function parseOns(json) {
  const months = Array.isArray(json && json.months) ? json.months : [];
  return months.map((m) => {
    const [y, mon] = String(m.date || "").trim().split(/\s+/);
    const mm = MONTHS[String(mon || "").slice(0, 3).toUpperCase()];
    const v = Number(m.value);
    return mm && /^\d{4}$/.test(y) && Number.isFinite(v) ? { date: `${y}-${mm}-01`, price: v } : null;
  }).filter(Boolean);
}

export async function fetchOns(id, fetchImpl = fetch) {
  const res = await fetchImpl(onsUrl(id), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`ONS ${id} returned HTTP ${res.status}`);
  const points = parseOns(await res.json());
  if (!points.length) throw new Error(`ONS ${id}: no monthly values in the response`);
  return points;
}

// Metals-API returns rates relative to the base currency. For metals the
// convention is "units of metal per 1 USD" (so the price is 1 / rate); some
// plans also return the direct price under "USD<SYMBOL>". Handle both.
export function metalsPrice(rates, symbol) {
  if (!rates) return null;
  const direct = Number(rates[`USD${symbol}`]);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const r = Number(rates[symbol]);
  if (!Number.isFinite(r) || r <= 0) return null;
  return r < 1 ? 1 / r : r;
}

export function parseMetalsLatest(json, symbols) {
  if (!json || json.success === false) throw new Error(`Metals-API: ${json && json.error ? (json.error.info || json.error.type || json.error.code) : "request failed"}`);
  const date = json.date || new Date((json.timestamp || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
  return symbols.map((s) => ({ symbol: s, date, price: metalsPrice(json.rates, s) })).filter((p) => Number.isFinite(p.price));
}

export function parseMetalsTimeseries(json, symbols) {
  if (!json || json.success === false) throw new Error(`Metals-API: ${json && json.error ? (json.error.info || json.error.type || json.error.code) : "request failed"}`);
  const out = [];
  for (const [date, rates] of Object.entries(json.rates || {})) {
    for (const s of symbols) {
      const price = metalsPrice(rates, s);
      if (Number.isFinite(price)) out.push({ symbol: s, date, price });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export async function fetchMetals(key, symbols, { since = null, fetchImpl = fetch } = {}) {
  if (!key) throw new Error("Add a Metals-API key in Settings to switch this feed on.");
  const base = "https://metals-api.com/api";
  const today = new Date().toISOString().slice(0, 10);
  const q = `access_key=${encodeURIComponent(key)}&base=USD&symbols=${encodeURIComponent(symbols.join(","))}`;
  const get = async (url) => {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`Metals-API returned HTTP ${res.status}`);
    return res.json();
  };
  // First run: try to backfill the last 90 days (plan permitting), else latest.
  if (!since) {
    const start = new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);
    try {
      const ts = parseMetalsTimeseries(await get(`${base}/timeseries?${q}&start_date=${start}&end_date=${today}`), symbols);
      if (ts.length) return ts;
    } catch { /* timeseries not on this plan — fall back to latest */ }
  }
  return parseMetalsLatest(await get(`${base}/latest?${q}`), symbols);
}

// % change of a series between two dates (nearest earlier point to each).
export function changeSince(points, fromDate, toDate = null) {
  const pts = [...(points || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!pts.length) return null;
  const end = toDate ? [...pts].reverse().find((p) => p.date <= toDate) : pts[pts.length - 1];
  const start = [...pts].reverse().find((p) => p.date <= fromDate) || null;
  if (!end || !start || start.price <= 0) return null;
  return { from: start.date, to: end.date, pct: Math.round(((end.price - start.price) / start.price) * 1000) / 10 };
}

export function periodChanges(points) {
  const pts = [...(points || [])].sort((a, b) => a.date.localeCompare(b.date));
  if (!pts.length) return {};
  const last = pts[pts.length - 1];
  const back = (months) => { const d = new Date(`${last.date}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - months); return d.toISOString().slice(0, 10); };
  return { m1: changeSince(pts, back(1)), m3: changeSince(pts, back(3)), m12: changeSince(pts, back(12)) };
}
