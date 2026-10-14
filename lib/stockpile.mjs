// Which products are safest to stockpile? Pure scoring from data the tool
// already holds. Five measures, each 0–100:
//
//  versatility  how many trades and jobs use it, so it can be sold on if
//               plans change (catalogue family, adjustable per product)
//  buyers       how many UK companies import this code (HMRC importer
//               lists), a direct read on how wide the market is
//  volume       UK import tonnes for the code and how steady they are
//               month to month (HMRC trade statistics)
//  stability    the opposite of price volatility: monthly swings in the
//               HMRC import unit value (£/t) for the code
//  turnover     how fast you move it yourself (months of usage in stock)
//
// Stockpile score = weighted blend. Volatility is also reported on its own.

export const WEIGHTS = { versatility: 0.25, buyers: 0.2, volume: 0.15, stability: 0.2, turnover: 0.2 };

// Catalogue family → how general-purpose it is (1–5) and why. A starting
// point from general stockholding experience; override per product.
export const FAMILY_VERSATILITY = {
  "flat-bar": [5, "Fabrication, brackets, gates, repairs, agriculture: used by almost every trade"],
  "equal-angle": [5, "Frames, supports, racking, lintels: a staple for fabricators and builders"],
  "round-bar": [4, "Machined parts, pins, railings, general engineering"],
  "square-bar": [4, "Railings, gates, decorative and general fabrication"],
  "shs": [5, "Frames, posts, trailers, structures: one of the fastest-moving sections"],
  "rhs": [4, "Frames, lintels, chassis, structural work"],
  "chs": [4, "Handrails, posts, scaffolding-type and structural use"],
  "ub": [4, "Beams across construction: widely used but heavier to hold"],
  "uc": [4, "Columns across construction: widely used but heavier to hold"],
  "pfc": [4, "Channels for frames, trimmers and trailers"],
  "plate": [4, "Cut to shape for almost anything: baseplates, brackets, fabrication"],
  "rebar": [4, "Every concrete job uses it, but mostly in a few common sizes"],
  "unequal-angle": [3, "Less common than equal angle; narrower set of uses"],
  "channel": [3, "Small channels for frames and trims"],
  "tee": [2, "Specialist glazing and frame work"],
  "hex-bar": [2, "Mainly fasteners and machining"],
  "rsj": [3, "Older-style beams, still used in refurbishments"],
  "wide-flat": [3, "Heavy fabrication and plant"],
  "chequer-plate": [3, "Floors, steps, vehicle beds"],
  "hr-sheet": [3, "Sheet work and fabrication"],
  "cr-sheet": [3, "Precision sheet work"],
  "galv-sheet": [3, "Ducting, cladding, flashing"],
  "painted-sheet": [2, "Mostly cladding and roofing"],
  "bright-round": [3, "Machining and precision parts"],
  "bright-square": [2, "Precision and tooling"],
  "bright-hex": [2, "Fasteners and machining"],
  "bright-flat": [2, "Tooling and precision fabrication"],
  "rebar-coil": [2, "Mostly for rebar processors"],
  "mesh": [3, "Slabs and ground works"],
  "wire-rod": [2, "Mostly for wire drawers"],
  "wire": [2, "Specialist uses"],
  "ss-round": [2, "Stainless: food, marine, process work"],
  "ss-round-hr": [2, "Stainless: heavier engineering"],
  "ss-flat": [2, "Stainless fabrication"],
  "ss-angle": [2, "Stainless frames"],
};

const clamp = (x, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const stdev = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
// percentile rank of v within list (0–100)
const pctRank = (v, list) => (list.length <= 1 ? 50 : (list.filter((x) => x < v).length + 0.5 * (list.filter((x) => x === v).length - 1)) / (list.length - 1) * 100);

// Monthly UK imports for one 8-digit code (exact), else its 6-digit family.
export function codeSeries(trade, code8, months = 24) {
  const periods = Object.keys(trade || {}).sort().slice(-months);
  const pick = (exact) => periods.map((p) => {
    let t = 0, v = 0;
    for (const [code, c] of Object.entries(trade[p] || {})) if (exact ? code === code8 : code.startsWith(code8.slice(0, 6))) { t += c.t || 0; v += c.v || 0; }
    return { p, t, v, perT: t > 0 ? v / t : null };
  });
  const exact = pick(true);
  return exact.filter((x) => x.t > 0).length >= 6 ? { scope: "code", rows: exact } : { scope: "family", rows: pick(false) };
}

// Monthly volatility of the £/t unit value (stdev of log changes, in %).
export function unitValueVolatility(rows) {
  const vals = rows.filter((r) => r.perT && r.t >= 20).map((r) => r.perT);
  if (vals.length < 6) return null;
  const ch = []; for (let i = 1; i < vals.length; i++) ch.push(Math.log(vals[i] / vals[i - 1]));
  return { pct: stdev(ch) * 100, months: vals.length, last: vals[vals.length - 1] };
}

// Importers using a code over the window (monthly data), else 2024–26 summary.
export function buyerCount(code8, { companies, months, summary }) {
  const f6 = code8.slice(0, 6);
  if (companies && months && months.length) {
    let exact = 0, family = 0;
    for (const co of Object.values(companies)) {
      const codes = new Set(months.flatMap((p) => (co.m && co.m[p]) || []));
      if (codes.has(code8)) exact++;
      if ([...codes].some((c) => c.startsWith(f6))) family++;
    }
    return { exact, family, source: "monthly" };
  }
  let exact = 0, family = 0;
  for (const s of summary || []) { if (s.codes.includes(code8)) exact++; if (s.codes.some((c) => c.startsWith(f6))) family++; }
  return { exact, family, source: (summary || []).length ? "summary" : "none" };
}

export function scoreProducts(products, { trade = {}, companies = null, months = [], summary = [], marketVolPct = null } = {}) {
  const raw = products.map((p) => {
    const code8 = String(p.commodityCode || "").slice(0, 8);
    const fam = p.family || null;
    const [famScore, famWhy] = (fam && FAMILY_VERSATILITY[fam]) || [3, "Family not linked to the catalogue, so treated as average"];
    const vScore = Number.isFinite(p.versatility) ? p.versatility : famScore;
    const series = codeSeries(trade, code8);
    const withT = series.rows.filter((r) => r.t > 0);
    const vol12 = series.rows.slice(-12).reduce((s, r) => s + r.t, 0);
    const steadiness = withT.length >= 3 ? 1 - Math.min(1, stdev(withT.map((r) => r.t)) / (mean(withT.map((r) => r.t)) || 1)) : null;
    const uv = unitValueVolatility(series.rows);
    const buyers = buyerCount(code8, { companies, months, summary });
    const coverMonths = p.monthlyUsageT > 0 ? (p.stockT || 0) / p.monthlyUsageT : null;
    return { p, code8, fam, famWhy, vScore, series, vol12, steadiness, uv, buyers, coverMonths };
  });
  const buyersList = raw.map((r) => r.buyers.exact || r.buyers.family * 0.5);
  const volList = raw.map((r) => r.vol12);
  const usageList = raw.map((r) => r.p.monthlyUsageT || 0);
  const vols = raw.map((r) => (r.uv ? r.uv.pct : null)).filter((x) => x !== null);
  return raw.map((r) => {
    const b = r.buyers.exact || r.buyers.family * 0.5;
    const volatilityPct = r.uv ? r.uv.pct : marketVolPct;
    const parts = {
      versatility: { score: (r.vScore - 1) * 25, value: r.vScore, why: Number.isFinite(r.p.versatility) ? "Set by your team" : r.famWhy },
      buyers: { score: r.buyers.source === "none" ? 50 : clamp((Math.log10(b + 1) / Math.log10(r.buyers.source === "summary" ? 150 : 60)) * 100) * 0.75 + pctRank(b, buyersList) * 0.25, value: r.buyers.exact, family: r.buyers.family, source: r.buyers.source },
      volume: { score: r.vol12 > 0 ? pctRank(r.vol12, volList) * 0.7 + (r.steadiness === null ? 50 : r.steadiness * 100) * 0.3 : 50, value: Math.round(r.vol12), steadiness: r.steadiness, scope: r.series.scope, known: r.vol12 > 0 },
      stability: { score: volatilityPct === null ? 50 : clamp(100 - (volatilityPct - 1) * 18), value: volatilityPct, source: r.uv ? `HMRC import value, ${r.series.scope === "code" ? "this code" : "code family"}` : marketVolPct !== null ? "ONS steel index (market-wide)" : "not enough data" },
      turnover: { score: r.p.monthlyUsageT > 0 ? pctRank(r.p.monthlyUsageT, usageList) * 0.7 + clamp(100 - ((r.coverMonths || 0) - 2) * 15) * 0.3 : 20, value: r.p.monthlyUsageT || 0, cover: r.coverMonths },
    };
    const score = Object.entries(WEIGHTS).reduce((s, [k, w]) => s + parts[k].score * w, 0);
    return { id: r.p.id, name: r.p.name, category: r.p.category, code: r.code8, family: r.fam, score: Math.round(score), parts,
      volatilityPct, volatilityRankBase: vols.length, uvLast: r.uv ? r.uv.last : null, series: r.series.rows.slice(-12).map((x) => ({ p: x.p, t: Math.round(x.t), perT: x.perT ? Math.round(x.perT) : null })) };
  }).sort((a, b) => b.score - a.score).map((r, i, all) => ({
    ...r, rank: i + 1,
    volatilityRank: r.volatilityPct === null ? null : [...all].filter((x) => x.volatilityPct !== null).sort((a, b) => b.volatilityPct - a.volatilityPct).findIndex((x) => x.id === r.id) + 1,
    verdict: verdict(r),
  }));
}

function verdict(r) {
  const { versatility, buyers, stability } = r.parts;
  if (r.score >= 70) return { level: "good", text: "Good to stockpile: widely used, easy to sell on, and its price is fairly steady." };
  if (stability.score < 35) return { level: "risk", text: "Price swings a lot. Holding extra exposes you to a sharp drop." };
  if (versatility.score <= 25 || (buyers.source !== "none" && buyers.score < 30)) return { level: "risk", text: "Narrow market. Hard to offload if plans change, so keep stock close to usage." };
  if (r.score >= 55) return { level: "ok", text: "Reasonable to hold a little extra; watch the price." };
  return { level: "caution", text: "Hold only what you'll use." };
}
