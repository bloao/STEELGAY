// Steel price forecast — a first, transparent model built from data the tool
// already holds. Pure functions only.
//
//   base      the monthly ONS UK steel producer price index (GHAV)
//   drift     average of (a) the 12-month log-linear trend and (b) the last
//             3 months' momentum, per month, damped towards zero the further
//             out you look (prices mean-revert; trends don't run for ever)
//   drivers   known step changes layered on top: UK CBAM from January 2027
//             (import cost passed partly through to UK prices) and the
//             team's market-insight notes (up / down, strength, horizon)
//   band      ±1.28 × monthly volatility × √months (≈ 80% range)
//   backtest  the same model run from past months, scored against what
//             actually happened, next to a "no change" guess
//
// It is a starting point for judgement, not a prediction to trade on.

export const MODEL_VERSION = "0.1";
const Z80 = 1.2816;

export const FORECAST_DEFAULTS = {
  trendMonths: 12,
  momentumMonths: 3,
  damping: 0.85, // each month ahead keeps 85% of the previous month's drift
  cbamPassThroughPct: 30, // share of the import CBAM cost UK prices absorb
  storagePerTMonth: 2, // £ per tonne per month to hold extra stock
};

const monthKey = (iso) => iso.slice(0, 7);
export function addMonths(iso, n) {
  const d = new Date(`${iso.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}
export function monthsBetween(a, b) {
  const [ya, ma] = a.slice(0, 7).split("-").map(Number);
  const [yb, mb] = b.slice(0, 7).split("-").map(Number);
  return (yb - ya) * 12 + (mb - ma);
}

// One value per month, oldest first.
export function monthly(points = []) {
  const by = new Map();
  for (const p of points) if (Number.isFinite(p.price) && p.date) by.set(monthKey(p.date), { date: `${monthKey(p.date)}-01`, price: p.price });
  return [...by.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function logReturns(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) out.push(Math.log(series[i].price / series[i - 1].price));
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export function stdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

// Least-squares slope of log(price) per month over the last n months.
export function trendSlope(series, n = 12) {
  const s = series.slice(-n);
  if (s.length < 3) return 0;
  const xs = s.map((_, i) => i), ys = s.map((p) => Math.log(p.price));
  const mx = mean(xs), my = mean(ys);
  const num = xs.reduce((t, x, i) => t + (x - mx) * (ys[i] - my), 0);
  const den = xs.reduce((t, x) => t + (x - mx) ** 2, 0);
  return den ? num / den : 0;
}

export function momentum(series, n = 3) {
  if (series.length <= n) return 0;
  const a = series[series.length - 1 - n].price, b = series[series.length - 1].price;
  return Math.log(b / a) / n;
}

// Driver = a percentage shift that applies from a month onward (ramped in).
// { label, pct, from: "YYYY-MM-DD", rampMonths, kind }
export function driverPctAt(drivers, date) {
  let total = 0;
  for (const d of drivers) {
    const m = monthsBetween(d.from, date);
    if (m < 0) continue;
    const ramp = d.rampMonths > 0 ? Math.min(1, (m + 1) / d.rampMonths) : 1;
    total += d.pct * ramp;
  }
  return total;
}

export function project(series, { horizon = 12, drivers = [], settings = {} } = {}) {
  const cfg = { ...FORECAST_DEFAULTS, ...settings };
  if (series.length < cfg.trendMonths) return null;
  const last = series[series.length - 1];
  const trend = trendSlope(series, cfg.trendMonths);
  const mom = momentum(series, cfg.momentumMonths);
  const drift0 = (trend + mom) / 2;
  const vol = stdev(logReturns(series.slice(-25)));
  const path = [];
  let cum = 0, d = drift0;
  for (let h = 1; h <= horizon; h++) {
    cum += d;
    d *= cfg.damping;
    const date = addMonths(last.date, h);
    const drv = driverPctAt(drivers, date) / 100;
    const mid = last.price * Math.exp(cum) * (1 + drv);
    const spread = Z80 * vol * Math.sqrt(h);
    path.push({ date, h, mid, low: mid * Math.exp(-spread), high: mid * Math.exp(spread), driverPct: drv * 100, basePct: (Math.exp(cum) - 1) * 100 });
  }
  return { asOf: last.date, last: last.price, trendPerMonthPct: (Math.exp(trend) - 1) * 100, momentumPerMonthPct: (Math.exp(mom) - 1) * 100, driftPerMonthPct: (Math.exp(drift0) - 1) * 100, volatilityPct: vol * 100, path };
}

// Run the model from each of the last `origins` months, h months ahead.
export function backtest(series, { h = 3, origins = 12, settings = {} } = {}) {
  const cfg = { ...FORECAST_DEFAULTS, ...settings };
  const rows = [];
  for (let k = origins + h; k >= h + 1; k--) {
    const cut = series.length - k;
    if (cut < cfg.trendMonths) continue;
    const past = series.slice(0, cut);
    const actual = series[cut - 1 + h];
    if (!actual) continue;
    const p = project(past, { horizon: h, settings: cfg });
    if (!p) continue;
    const f = p.path[h - 1];
    const lastP = past[past.length - 1].price;
    rows.push({ from: past[past.length - 1].date, to: actual.date, forecast: f.mid, low: f.low, high: f.high, actual: actual.price, naive: lastP,
      errPct: ((f.mid - actual.price) / actual.price) * 100, naiveErrPct: ((lastP - actual.price) / actual.price) * 100,
      inBand: actual.price >= f.low && actual.price <= f.high,
      rightWay: Math.sign(f.mid - lastP) === Math.sign(actual.price - lastP) || Math.abs(actual.price - lastP) / lastP < 0.002 });
  }
  const mape = (k) => (rows.length ? mean(rows.map((r) => Math.abs(r[k]))) : null);
  return { h, rows, mapePct: mape("errPct"), naiveMapePct: mape("naiveErrPct"), inBandPct: rows.length ? (rows.filter((r) => r.inBand).length / rows.length) * 100 : null, directionPct: rows.length ? (rows.filter((r) => r.rightWay).length / rows.length) * 100 : null };
}

// Team notes → drivers. Each note's effect starts from its date and builds
// up over its horizon; notes older than their horizon have played out.
export function noteDrivers(notes = [], asOf, strengthPct = { 1: 1, 2: 3, 3: 5 }) {
  return notes.filter((n) => n.impact !== "neutral" && monthsBetween(n.date, asOf) < n.horizonMonths)
    .map((n) => ({ kind: "insight", id: n.id, label: n.title, pct: (n.impact === "up" ? 1 : -1) * (strengthPct[n.strength] || 1), from: n.date, rampMonths: n.horizonMonths, date: n.date, by: n.by }));
}

// UK CBAM: import cost uplift as a % of the reference price, part passed on.
export function cbamDriver({ ratePerT, emissionsPerT, referencePrice, passThroughPct, start = "2027-01-01" }) {
  if (!(ratePerT > 0 && emissionsPerT > 0 && referencePrice > 0)) return null;
  const costPerT = ratePerT * emissionsPerT;
  // passThroughPct is a percentage (30 = 30%), so pct comes out in percent
  return { kind: "cbam", label: "UK CBAM on imported steel", pct: (costPerT / referencePrice) * passThroughPct, from: start, rampMonths: 3, costPerT, passThroughPct };
}

// Should you buy `months` of usage now instead of month by month?
// Each month's tonnes bought now avoid that month's forecast price but are
// carried until used (cost of capital + storage).
export function buyAhead({ priceNow, indexNow, path, monthlyUsageT, months = 3, costOfCapitalPct = 8, storagePerTMonth = 2 }) {
  if (!(priceNow > 0) || !(indexNow > 0) || !(monthlyUsageT > 0) || !path || !path.length) return null;
  const rows = [];
  let mid = 0, low = 0, high = 0, carry = 0;
  for (let k = 1; k <= months && k <= path.length; k++) {
    const f = path[k - 1];
    const ratio = (x) => priceNow * (x / indexNow);
    const carryPerT = priceNow * (costOfCapitalPct / 100 / 12) * k + storagePerTMonth * k;
    const pMid = ratio(f.mid), pLow = ratio(f.low), pHigh = ratio(f.high);
    rows.push({ k, date: f.date, priceMid: pMid, priceLow: pLow, priceHigh: pHigh, carryPerT, gainPerT: pMid - priceNow - carryPerT });
    mid += (pMid - priceNow - carryPerT) * monthlyUsageT;
    low += (pLow - priceNow - carryPerT) * monthlyUsageT;
    high += (pHigh - priceNow - carryPerT) * monthlyUsageT;
    carry += carryPerT * monthlyUsageT;
  }
  const tonnes = monthlyUsageT * rows.length;
  const signal = mid > 0 && low > 0 ? "buy-ahead" : mid > 0 ? "consider" : "buy-as-needed";
  return { months: rows.length, tonnes, rows, netMid: mid, netLow: low, netHigh: high, carryCost: carry, signal };
}
