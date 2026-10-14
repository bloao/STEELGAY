// Order planner: pull every signal for one product together and pick the
// best way to buy it. Pure functions.
//
// Three approaches, each with its own thresholds and weights. Every option's
// score starts from its expected landed cost (every cost counted), then:
//   + quota weight × (cost if the quota is missed − expected cost)
//   + stock-out cost for each day it lands after you run out
//   − cash value of the supplier's payment terms at the approach's cash rate
//     (on top of what cost of capital already counts)
//   + lead-time weight × days to arrive  + reliability weight × points below 100% on time
// Then timing: order now, buy ahead (forecast rising, product safe to hold),
// or hold off (forecast falling and stock covers the lead time).

export const APPROACHES = {
  cashflow: { label: "Cash flow" },
  speed: { label: "Speed" },
  balanced: { label: "Balanced" },
};
export const APPETITE = APPROACHES; // older name
export const APPROACH_KEYS = ["quotaWeightPct", "stockOutPerDayPct", "cashRatePct", "leadDayPct", "reliabilityPct",
  "buyAheadTriggerPct", "buyAheadMinSaving", "holdMinScore", "waitTriggerPct", "waitCoverBufferMonths"];
export const APPROACH_DEFAULTS = {
  cashflow: { quotaWeightPct: 25, stockOutPerDayPct: 0.2, cashRatePct: 20, leadDayPct: 0, reliabilityPct: 0,
    buyAheadTriggerPct: 4, buyAheadMinSaving: 500, holdMinScore: 70, waitTriggerPct: 1, waitCoverBufferMonths: 0.25 },
  speed: { quotaWeightPct: 40, stockOutPerDayPct: 0.5, cashRatePct: 0, leadDayPct: 0.1, reliabilityPct: 0.2,
    buyAheadTriggerPct: 1.5, buyAheadMinSaving: 0, holdMinScore: 55, waitTriggerPct: 3, waitCoverBufferMonths: 1 },
  balanced: { quotaWeightPct: 25, stockOutPerDayPct: 0.2, cashRatePct: 12, leadDayPct: 0.02, reliabilityPct: 0.03,
    buyAheadTriggerPct: 1.5, buyAheadMinSaving: 0, holdMinScore: 55, waitTriggerPct: 1.5, waitCoverBufferMonths: 0.5 },
};
export const approachOf = (a) => (APPROACHES[a] ? a : "balanced");
// Settings that apply whatever the approach.
export const THRESHOLD_DEFAULTS = { costOfCapitalPct: 8, staleQuoteDays: 30, onTimeWarnPct: 75, quotaWarnProbPct: 25, importSurgePct: 25 };
// One approach's thresholds plus the shared ones.
export function thresholdsFor(appetite, th = {}) {
  const a = approachOf(appetite);
  return { ...THRESHOLD_DEFAULTS, ...APPROACH_DEFAULTS[a], ...th, ...((th.approaches || {})[a] || {}) };
}
export function quotaWeight(appetite, th = {}) { return thresholdsFor(appetite, th).quotaWeightPct / 100; }
const DAY = 86_400_000;
const monthName = (p) => (p ? new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(4, 6)) - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) : "");
const dmy = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export function scoreOptions(options, { needBy, appetite = "balanced", thresholds = {} } = {}) {
  const th = thresholdsFor(appetite, thresholds);
  const lambda = th.quotaWeightPct / 100;
  const extraCash = Math.max(0, th.cashRatePct - th.costOfCapitalPct) / 100; // cost of capital is already in the landed cost
  const today = new Date().toISOString().slice(0, 10);
  return options.filter((o) => Number.isFinite(o.effectivePerT)).map((o) => {
    const quotaExposure = Math.max(0, (o.worstPerT ?? o.effectivePerT) - o.effectivePerT);
    const lateDays = needBy && o.arrival ? Math.max(0, days(needBy, o.arrival)) : 0;
    const latePenalty = lateDays ? o.effectivePerT * (th.stockOutPerDayPct / 100) * lateDays : 0;
    const riskCost = o.effectivePerT + lambda * quotaExposure;
    const payDays = Number.isFinite(o.paymentDays) ? o.paymentDays : 0;
    const cashCredit = o.effectivePerT * extraCash * (payDays / 365);
    const leadDays = Number.isFinite(o.leadDays) ? o.leadDays : o.arrival ? Math.max(0, days(today, o.arrival)) : 21;
    const onTime = Number.isFinite(o.onTimePct) ? o.onTimePct : 85; // unknown record: assume middling
    const speedCost = o.effectivePerT * ((th.leadDayPct / 100) * leadDays + (th.reliabilityPct / 100) * Math.max(0, 100 - onTime));
    const warnings = [];
    if (lateDays) warnings.push(`Lands ${lateDays} day${lateDays === 1 ? "" : "s"} after you're expected to run out`);
    if (o.quoteAgeDays > th.staleQuoteDays) warnings.push(`Quote is ${o.quoteAgeDays} days old; ask for a fresh one`);
    if (o.validUntil && o.arrival && o.validUntil < today) warnings.push("Quote has expired");
    if (o.quoteScope && o.quoteScope !== "product") warnings.push("Their general price, not a quote for this product");
    if (o.onTimePct !== null && o.onTimePct !== undefined && o.onTimePct < th.onTimeWarnPct) warnings.push(`Only ${o.onTimePct}% on time`);
    if (quotaExposure > 1 && (o.probability || 0) >= th.quotaWarnProbPct / 100) warnings.push(`${Math.round(o.probability * 100)}% chance the quota runs out first`);
    return { ...o, quotaExposure, lateDays, latePenalty, riskCost, cashCredit, speedCost, payDays, score: riskCost + latePenalty - cashCredit + speedCost, warnings };
  }).sort((a, b) => Number(a.lateDays > 0) - Number(b.lateDays > 0) || a.score - b.score); // arriving in time comes first
}

// Decide timing and quantity, then explain it.
export function recommend({ product, tonnage, needBy, appetite, options, forecast, aheadOptions = [], stockpile, quota, market, competition, intel = [], thresholds = {} }) {
  const th = thresholdsFor(appetite, thresholds);
  const scored = scoreOptions(options, { needBy, appetite, thresholds });
  if (!scored.length) return { ok: false, scored, reason: "No supplier can price this product yet. Log quotes on the Suppliers page." };
  const best = scored[0];
  const cheapest = [...scored].sort((a, b) => a.effectivePerT - b.effectivePerT)[0];
  const safest = [...scored].filter((o) => !o.lateDays).sort((a, b) => (a.worstPerT ?? a.effectivePerT) - (b.worstPerT ?? b.effectivePerT))[0] || null;
  const fastest = [...scored].filter((o) => o.arrival).sort((a, b) => a.arrival.localeCompare(b.arrival))[0] || null;

  const usage = product.monthlyUsageT || 0;
  const leadMonths = best.leadDays ? best.leadDays / 30.4 : 1;
  const in3 = forecast && Number.isFinite(forecast.in3) ? forecast.in3 : null;
  const holdOk = Boolean(stockpile) && stockpile.level !== "risk" && (Number.isFinite(stockpile.score) ? stockpile.score >= th.holdMinScore : ["good", "ok"].includes(stockpile.level));
  const bestAhead = aheadOptions.filter((a) => a.netMid > Math.max(0, th.buyAheadMinSaving)).sort((a, b) => b.netMid - a.netMid)[0] || null;

  let timing;
  const up = th.buyAheadTriggerPct, down = th.waitTriggerPct;
  if (in3 !== null && in3 >= up && bestAhead && holdOk) {
    const extra = Math.round(bestAhead.months * usage);
    timing = { action: "buy-ahead", label: `Buy ahead: add ${bestAhead.months} month${bestAhead.months === 1 ? "" : "s"}`, extraTonnes: extra,
      text: `Prices look set to rise ${in3.toFixed(1)}% over three months and ${product.name} is safe to hold. Buying ${extra} t extra now should save about £${Math.round(bestAhead.netMid).toLocaleString("en-GB")} after holding costs${bestAhead.signal === "consider" ? ", though that isn't certain" : ""}.` };
  } else if (in3 !== null && in3 <= -down && product.coverMonths !== null && product.coverMonths > leadMonths + th.waitCoverBufferMonths) {
    timing = { action: "wait", label: "Hold off if you can", extraTonnes: 0,
      text: `Prices look set to ease ${Math.abs(in3).toFixed(1)}% over three months, and your ${product.coverMonths.toFixed(1)} months of stock covers the ${Math.round(leadMonths * 4.3)}-week lead time. Order the minimum now or wait a few weeks.` };
  } else {
    timing = { action: "order-now", label: "Order now", extraTonnes: 0,
      text: in3 === null ? "No forecast yet, so order what you need." : `Prices look broadly ${in3 >= 0.75 ? "firm" : in3 <= -0.75 ? "soft" : "flat"} (${in3 >= 0 ? "+" : ""}${in3.toFixed(1)}% over three months). Order what you need${in3 >= up && !holdOk ? `. Buying ahead isn't advised: ${product.name} scores ${stockpile ? stockpile.score : "—"}/100 to hold, below your ${th.holdMinScore} threshold` : in3 >= up && !bestAhead ? `. Buying ahead wouldn't ${th.buyAheadMinSaving > 0 ? `save the £${Math.round(th.buyAheadMinSaving).toLocaleString("en-GB")} you need` : "pay"} once holding costs are counted` : in3 < up && in3 >= 0.75 ? `. Not enough of a rise to buy ahead (your trigger is +${up}%)` : ""}.` };
  }
  const recTonnes = Math.max(product.moqT || 0, tonnage + (timing.extraTonnes || 0));

  // Why this supplier
  const reasons = [];
  const diffYou = best.effectivePerT - (product.costPerT || 0);
  reasons.push(`Lands at £${Math.round(best.effectivePerT)}/t with every cost counted, ${Math.abs(diffYou) < 2 ? "in line with" : `£${Math.round(Math.abs(diffYou))}/t ${diffYou < 0 ? "below" : "above"}`} what you pay now.`);
  if (best.id !== cheapest.id) reasons.push(`${cheapest.name} is £${Math.round(best.effectivePerT - cheapest.effectivePerT)}/t cheaper on paper, but ${cheapest.lateDays ? "arrives too late" : cheapest.quotaExposure > 1 ? `carries £${Math.round(cheapest.quotaExposure)}/t of quota risk` : "scores worse on risk"}.`);
  if (best.quotaExposure > 1) reasons.push(`If the quota runs out first it would cost £${Math.round(best.quotaExposure)}/t more (${Math.round((best.probability || 0) * 100)}% chance by arrival).`);
  else reasons.push(best.covers === "everything" ? "Quoted all-in, so the supplier carries the duty risk." : "No steel-measure duty risk on this option.");
  if (market && Number.isFinite(market.benchmark)) { const d = best.effectivePerT - market.benchmark; reasons.push(`${Math.abs(d) < 2 ? "In line with" : `£${Math.round(Math.abs(d))}/t ${d < 0 ? "below" : "above"}`} the ${market.benchmarkLabel}.`); }
  if (best.arrival) reasons.push(`Arrives around ${dmy(best.arrival)}${needBy ? best.lateDays ? `, ${best.lateDays} days after you run out` : `, before you run out (${dmy(needBy)})` : ""}.`);
  if (approachOf(appetite) === "cashflow") reasons.push(best.payDays ? `Pay in ${best.payDays} days.` : "Pay on delivery.");
  if (approachOf(appetite) === "speed") reasons.push(`${best.leadDays ? `${best.leadDays}-day lead` : "Lead time not set"}${Number.isFinite(best.onTimePct) ? `, ${best.onTimePct}% on time` : ""}.`);
  if (intel.length) reasons.push(`Includes ${intel.length} piece${intel.length === 1 ? "" : "s"} of market intel your team logged.`);

  // Things to watch
  const watch = [...best.warnings];
  if (quota && quota.risk && ["critical", "high"].includes(quota.risk) && best.quotaExposure > 1) watch.push(`Quota line ${quota.orderNumber} is ${quota.risk === "critical" ? "close to running out" : "filling fast"}${quota.runOutDate ? ` (about ${dmy(quota.runOutDate)})` : ""}. Consider an all-in or UK supplier, or splitting the order.`);
  if (competition && competition.vsAvgPct !== null && competition.vsAvgPct >= th.importSurgePct) watch.push(`UK imports of this product ran ${Math.round(competition.vsAvgPct)}% above normal in ${monthName(competition.month)}: buyers are stocking up, so supply may tighten.`);
  if (competition && competition.steppingUp && competition.steppingUp.length) watch.push(`${competition.steppingUp.join(", ")} ${competition.steppingUp.length === 1 ? "is" : "are"} importing more of this lately.`);

  return {
    ok: true, scored, timing, recTonnes, thresholds: th,
    best: { ...best, total: best.effectivePerT * recTonnes },
    alternatives: { cheapest, safest, fastest },
    reasons, watch,
  };
}
