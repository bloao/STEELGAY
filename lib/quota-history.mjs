// Quota history and outlook, per line of the July 2026 steel measure.
//
// Source: the DBT "UK trade quotas" dataset, which keeps every quota period
// since January 2021 with its opening volume, final balance, status and last
// allocation date. Before July 2026 the same categories were covered by the
// UK steel safeguard (different order numbers, larger volumes, some different
// country allocations). Each past period is mapped onto today's lines by
// category and origin: origins that have their own line now map to it;
// everyone else maps to that category's Residual line, as they would today.
//
// From that we get, per line: how full each quarter got, how often it ran
// out and on which day, the pace of use in tonnes a day, and, applied to the
// current quarter's volume, roughly when it would run out at that pace.
// Pure functions; no network.

import { ORDER_LINES, isMeasureOrderNumber, lineFor } from "./steel-measure.mjs";
import { unitToTonnes } from "./quota-feed.mjs";

const DAY = 86_400_000;
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + Math.round(n) * DAY).toISOString().slice(0, 10);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return null; const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => (xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null);

export const EU_MEMBERS = ["Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czechia", "Czech Republic", "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary", "Ireland",
  "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta", "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia", "Spain", "Sweden"];
const ALIASES = {
  "turkiye": "Turkey", "türkiye": "Turkey", "turkey": "Turkey",
  "korea": "South Korea", "korea, republic of": "South Korea", "republic of korea": "South Korea", "south korea": "South Korea", "korea (south)": "South Korea",
  "united states of america": "United States", "united states": "United States", "usa": "United States", "us": "United States",
  "viet nam": "Vietnam", "vietnam": "Vietnam", "european union": "European Union", "eu": "European Union",
  "uae": "United Arab Emirates", "united arab emirates": "United Arab Emirates", "switzerland": "Switzerland", "japan": "Japan", "india": "India",
};
const RESIDUAL = /erga omnes|all (third )?countries|other countries|all other|all origins|residual|third countries/i;

// Which of today's origins a past quota's geographical areas belong to.
export function originFor(areas = [], categoryId) {
  const list = (Array.isArray(areas) ? areas : String(areas).split("|")).map((a) => String(a).trim()).filter(Boolean);
  if (!list.length || list.some((a) => RESIDUAL.test(a))) return "Residual";
  const names = list.map((a) => ALIASES[a.toLowerCase()] || (EU_MEMBERS.includes(a) ? "European Union" : a));
  const uniq = [...new Set(names)];
  const origin = uniq.length === 1 ? uniq[0] : uniq.every((n) => n === "European Union") ? "European Union" : null;
  const named = ORDER_LINES.filter((l) => l.categoryId === categoryId && !l.residual).map((l) => l.origin);
  return origin && named.includes(origin) ? origin : "Residual";
}

// rows: DBT quota rows (orderNumber, geographicalAreas, categoryIds, startDate,
// endDate, status, lastAllocationDate, initialVolume, balance, measurementUnit)
export function periodsByLine(rows, asOf) {
  const buckets = new Map(); // `${orderNumber}|${startDate}` of today's line → aggregated period
  for (const r of rows) {
    if (!r.startDate || !r.endDate || r.endDate > asOf && r.startDate > asOf) continue; // future periods
    const cats = r.categoryIds || [];
    if (cats.length !== 1) continue; // can't attribute a quota that spans categories
    const categoryId = cats[0];
    const line = isMeasureOrderNumber(r.orderNumber) ? lineFor(r.orderNumber) : ORDER_LINES.find((l) => l.categoryId === categoryId && l.origin === originFor(r.geographicalAreas, categoryId));
    if (!line) continue;
    const initialT = unitToTonnes(r.initialVolume, r.measurementUnit);
    const balanceT = unitToTonnes(r.balance, r.measurementUnit);
    if (!(initialT > 0) || balanceT === null) continue;
    const length = days(r.startDate, r.endDate) + 1;
    if (length < 60 || length > 120) continue; // quarterly periods only (skips odd transitional ones)
    const k = `${line.orderNumber}|${r.startDate}`;
    const exhausted = balanceT <= 0.5 || /exhaust/i.test(r.status || "");
    const p = buckets.get(k) || { orderNumber: line.orderNumber, startDate: r.startDate, endDate: r.endDate, length, initialT: 0, usedT: 0, parts: 0, exhaustedParts: 0, lastDates: [], regime: isMeasureOrderNumber(r.orderNumber) ? "measure" : "safeguard", current: asOf >= r.startDate && asOf <= r.endDate };
    p.initialT += initialT;
    p.usedT += Math.max(0, initialT - Math.max(balanceT, 0));
    p.parts += 1;
    if (exhausted) { p.exhaustedParts += 1; if (r.lastAllocationDate && /^\d{4}-\d{2}-\d{2}/.test(r.lastAllocationDate)) p.lastDates.push(r.lastAllocationDate.slice(0, 10)); }
    buckets.set(k, p);
  }
  const out = new Map();
  for (const p of buckets.values()) {
    const exhausted = p.exhaustedParts === p.parts;
    const exhaustedOn = exhausted && p.lastDates.length ? p.lastDates.sort().at(-1) : null;
    const dayFull = exhaustedOn ? Math.max(1, days(p.startDate, exhaustedOn) + 1) : null;
    const openDays = p.current ? Math.max(1, days(p.startDate, asOf) + 1) : dayFull || p.length;
    const row = { ...p, exhausted, exhaustedOn, dayFull, fillPct: (p.usedT / p.initialT) * 100, perDayT: p.usedT / openDays, partlyExhausted: p.exhaustedParts > 0 && !exhausted };
    delete row.lastDates;
    if (!out.has(p.orderNumber)) out.set(p.orderNumber, []);
    out.get(p.orderNumber).push(row);
  }
  for (const list of out.values()) list.sort((a, b) => a.startDate.localeCompare(b.startDate));
  return out;
}

// Summary and outlook for one line. `live` is the current-quarter line from
// buildLines (initialT, usedT, burnPerDayT, startDate, endDate).
export function analyseLine(line, periods = [], live = null, asOf) {
  const done = periods.filter((p) => !p.current);
  const recent = done.slice(-8);
  const last4 = done.slice(-4);
  const exhaustedRecent = recent.filter((p) => p.exhausted);
  const dayFullMedian = median(exhaustedRecent.map((p) => p.dayFull).filter(Boolean));
  // pace while the quota was open; a quota that ran out early hides demand, so this is a floor
  const paceT = mean(last4.map((p) => p.perDayT));
  const sameQuarterLastYear = done.find((p) => p.startDate.slice(5) === (live && live.startDate ? live.startDate.slice(5) : "") && p.startDate.slice(0, 4) === String(Number((live?.startDate || asOf).slice(0, 4)) - 1)) || null;
  let outlook = null;
  if (live && live.found && live.initialT > 0) {
    const elapsed = Math.max(1, days(live.startDate, asOf) + 1);
    const length = days(live.startDate, live.endDate) + 1;
    const leftT = Math.max(0, live.balanceT ?? live.initialT - (live.usedT || 0));
    // blend this quarter's own pace with the historical pace: trust the live pace more as the quarter goes on
    const w = Math.min(1, elapsed / 45);
    const livePace = live.burnPerDayT > 0 ? live.burnPerDayT : null;
    const pace = livePace && paceT ? w * livePace + (1 - w) * paceT : livePace || paceT;
    const fullOn = leftT <= 0 ? asOf : pace > 0 ? addDays(asOf, leftT / pace) : null;
    const fullDay = fullOn ? days(live.startDate, fullOn) + 1 : null;
    const lastsQuarter = !fullOn || fullOn > live.endDate;
    const margin = fullOn && !lastsQuarter ? days(asOf, fullOn) : null;
    outlook = {
      quarterStart: live.startDate, quarterEnd: live.endDate, quarterDays: length, elapsed, initialT: live.initialT, usedT: live.usedT, leftT,
      livePaceT: livePace, historicPaceT: paceT, paceT: pace, fullOn: lastsQuarter ? null : fullOn, fullDay: lastsQuarter ? null : fullDay, lastsQuarter,
      // importing on or after this date risks the out-of-quota duty (a week's margin for customs timing)
      safeUntil: lastsQuarter ? live.endDate : fullOn ? addDays(fullOn, -7) : null,
      daysLeft: margin,
      verdict: leftT <= 0 ? "full" : lastsQuarter ? (pace && (live.usedT + pace * (length - elapsed)) / live.initialT > 0.85 ? "tight" : "lasts") : margin <= 14 ? "imminent" : "fills",
    };
  }
  return {
    orderNumber: line.orderNumber, categoryId: line.categoryId, origin: line.origin, residual: line.residual, annualTonnes: line.annualTonnes,
    quarters: done.length, recentQuarters: recent.length,
    avgFillPct: mean(recent.map((p) => Math.min(100, p.fillPct))),
    exhaustedCount: exhaustedRecent.length,
    exhaustedShare: recent.length ? exhaustedRecent.length / recent.length : null,
    dayFullMedian, paceT, sameQuarterLastYear: sameQuarterLastYear ? { startDate: sameQuarterLastYear.startDate, fillPct: sameQuarterLastYear.fillPct, exhausted: sameQuarterLastYear.exhausted, dayFull: sameQuarterLastYear.dayFull } : null,
    sinceMeasure: periods.filter((p) => p.regime === "measure").length,
    history: periods.slice(-12).map((p) => ({ startDate: p.startDate, endDate: p.endDate, regime: p.regime, initialT: p.initialT, usedT: p.usedT, fillPct: p.fillPct, exhausted: p.exhausted, exhaustedOn: p.exhaustedOn, dayFull: p.dayFull, perDayT: p.perDayT, current: p.current, partlyExhausted: p.partlyExhausted })),
    outlook,
  };
}

export function quotaHistory(rows, liveLines = [], asOf) {
  const byLine = periodsByLine(rows, asOf);
  const liveBy = new Map(liveLines.map((l) => [l.orderNumber, l]));
  const lines = ORDER_LINES.map((line) => analyseLine(line, byLine.get(line.orderNumber) || [], liveBy.get(line.orderNumber) || null, asOf));
  const firstPeriod = [...byLine.values()].flat().map((p) => p.startDate).sort()[0] || null;
  return { asOf, firstPeriod, lines, byLine };
}

// Extra analysis for one line's profile page.
export function lineProfile(a, allPeriods = []) {
  const done = allPeriods.filter((p) => !p.current);
  const qOf = (iso) => Math.floor((Number(iso.slice(5, 7)) - 1) / 3); // 0 Jan–Mar … 3 Oct–Dec
  const seasons = [0, 1, 2, 3].map((q) => {
    const ps = done.filter((p) => qOf(p.startDate) === q);
    return { quarter: q, label: ["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"][q], periods: ps.length, avgFillPct: mean(ps.map((p) => Math.min(100, p.fillPct))), ranOut: ps.filter((p) => p.exhausted).length, dayFullMedian: median(ps.filter((p) => p.dayFull).map((p) => p.dayFull)) };
  });
  const last4 = done.slice(-4), prev4 = done.slice(-8, -4);
  const paceLast = mean(last4.map((p) => p.perDayT)), pacePrev = mean(prev4.map((p) => p.perDayT));
  const fullDays = done.filter((p) => p.dayFull).map((p) => p.dayFull);
  const measure = done.filter((p) => p.regime === "measure");
  return {
    ...a,
    seasons,
    paceTrendPct: paceLast && pacePrev ? ((paceLast / pacePrev) - 1) * 100 : null,
    earliestFullDay: fullDays.length ? Math.min(...fullDays) : null,
    latestFullDay: fullDays.length ? Math.max(...fullDays) : null,
    ranOutAll: done.filter((p) => p.exhausted).length,
    allQuarters: done.length,
    measureQuarters: measure.map((p) => ({ startDate: p.startDate, fillPct: p.fillPct, exhausted: p.exhausted, dayFull: p.dayFull })),
    fullHistory: allPeriods.map((p) => ({ startDate: p.startDate, endDate: p.endDate, regime: p.regime, initialT: p.initialT, usedT: p.usedT, fillPct: p.fillPct, exhausted: p.exhausted, exhaustedOn: p.exhaustedOn, dayFull: p.dayFull, perDayT: p.perDayT, current: p.current, partlyExhausted: p.partlyExhausted })),
  };
}
