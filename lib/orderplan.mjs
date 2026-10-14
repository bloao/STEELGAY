// Order planner: pull every signal for one product together and pick the
// best way to buy it. Pure functions.
//
// For each supplier option:
//   risk-adjusted cost = expected landed cost
//                      + appetite × (cost if quota missed − expected cost)
//                      + late-delivery penalty if it lands after you run out
// Then timing: order now, buy ahead (forecast rising, product safe to hold),
// or hold off (forecast falling and stock covers the lead time).

export const APPETITE = {
  cautious: { lambda: 0.6, label: "Cautious", text: "Weights the cost of missing the quota heavily" },
  balanced: { lambda: 0.25, label: "Balanced", text: "Counts part of the quota-miss cost" },
  bold: { lambda: 0, label: "Price first", text: "Goes on expected cost alone" },
};
const DAY = 86_400_000;
const monthName = (p) => (p ? new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(4, 6)) - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) : "");
const dmy = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
const days = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export function scoreOptions(options, { needBy, appetite = "balanced", stockOutPerDayPct = 0.2 } = {}) {
  const lambda = (APPETITE[appetite] || APPETITE.balanced).lambda;
  return options.filter((o) => Number.isFinite(o.effectivePerT)).map((o) => {
    const quotaExposure = Math.max(0, (o.worstPerT ?? o.effectivePerT) - o.effectivePerT);
    const lateDays = needBy && o.arrival ? Math.max(0, days(needBy, o.arrival)) : 0;
    const latePenalty = lateDays ? o.effectivePerT * (stockOutPerDayPct / 100) * lateDays : 0;
    const riskCost = o.effectivePerT + lambda * quotaExposure;
    const warnings = [];
    if (lateDays) warnings.push(`Lands ${lateDays} day${lateDays === 1 ? "" : "s"} after you're expected to run out`);
    if (o.quoteAgeDays > 30) warnings.push(`Quote is ${o.quoteAgeDays} days old; ask for a fresh one`);
    if (o.validUntil && o.arrival && o.validUntil < new Date().toISOString().slice(0, 10)) warnings.push("Quote has expired");
    if (o.quoteScope && o.quoteScope !== "product") warnings.push("Their general price, not a quote for this product");
    if (o.onTimePct !== null && o.onTimePct !== undefined && o.onTimePct < 75) warnings.push(`Only ${o.onTimePct}% on time`);
    if (quotaExposure > 1 && (o.probability || 0) >= 0.25) warnings.push(`${Math.round(o.probability * 100)}% chance the quota runs out first`);
    return { ...o, quotaExposure, lateDays, latePenalty, riskCost, score: riskCost + latePenalty, warnings };
  }).sort((a, b) => Number(a.lateDays > 0) - Number(b.lateDays > 0) || a.score - b.score); // arriving in time comes first
}

// Decide timing and quantity, then explain it.
export function recommend({ product, tonnage, needBy, appetite, options, forecast, aheadOptions = [], stockpile, quota, market, competition, intel = [] }) {
  const scored = scoreOptions(options, { needBy, appetite });
  if (!scored.length) return { ok: false, scored, reason: "No supplier can price this product yet. Log quotes on the Suppliers page." };
  const best = scored[0];
  const cheapest = [...scored].sort((a, b) => a.effectivePerT - b.effectivePerT)[0];
  const safest = [...scored].filter((o) => !o.lateDays).sort((a, b) => (a.worstPerT ?? a.effectivePerT) - (b.worstPerT ?? b.effectivePerT))[0] || null;
  const fastest = [...scored].filter((o) => o.arrival).sort((a, b) => a.arrival.localeCompare(b.arrival))[0] || null;

  const usage = product.monthlyUsageT || 0;
  const leadMonths = best.leadDays ? best.leadDays / 30.4 : 1;
  const in3 = forecast && Number.isFinite(forecast.in3) ? forecast.in3 : null;
  const holdOk = stockpile && ["good", "ok"].includes(stockpile.level);
  const bestAhead = aheadOptions.filter((a) => a.netMid > 0).sort((a, b) => b.netMid - a.netMid)[0] || null;

  let timing;
  if (in3 !== null && in3 >= 1.5 && bestAhead && holdOk) {
    const extra = Math.round(bestAhead.months * usage);
    timing = { action: "buy-ahead", label: `Buy ahead: add ${bestAhead.months} month${bestAhead.months === 1 ? "" : "s"}`, extraTonnes: extra,
      text: `Prices look set to rise ${in3.toFixed(1)}% over three months and ${product.name} is safe to hold. Buying ${extra} t extra now should save about £${Math.round(bestAhead.netMid).toLocaleString("en-GB")} after holding costs${bestAhead.signal === "consider" ? ", though that isn't certain" : ""}.` };
  } else if (in3 !== null && in3 <= -1.5 && product.coverMonths !== null && product.coverMonths > leadMonths + 0.5) {
    timing = { action: "wait", label: "Hold off if you can", extraTonnes: 0,
      text: `Prices look set to ease ${Math.abs(in3).toFixed(1)}% over three months, and your ${product.coverMonths.toFixed(1)} months of stock covers the ${Math.round(leadMonths * 4.3)}-week lead time. Order the minimum now or wait a few weeks.` };
  } else {
    timing = { action: "order-now", label: "Order now", extraTonnes: 0,
      text: in3 === null ? "No forecast yet, so order what you need." : `Prices look broadly ${in3 >= 0.75 ? "firm" : in3 <= -0.75 ? "soft" : "flat"} (${in3 >= 0 ? "+" : ""}${in3.toFixed(1)}% over three months). Order what you need${in3 >= 1.5 && !holdOk ? `. Buying ahead isn't advised: ${product.name} is harder to sell on if plans change` : in3 >= 1.5 && !bestAhead ? ". Buying ahead wouldn't pay once holding costs are counted" : ""}.` };
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
  if (intel.length) reasons.push(`Includes ${intel.length} piece${intel.length === 1 ? "" : "s"} of market intel your team logged.`);

  // Things to watch
  const watch = [...best.warnings];
  if (quota && quota.risk && ["critical", "high"].includes(quota.risk) && best.quotaExposure > 1) watch.push(`Quota line ${quota.orderNumber} is ${quota.risk === "critical" ? "close to running out" : "filling fast"}${quota.runOutDate ? ` (about ${dmy(quota.runOutDate)})` : ""}. Consider an all-in or UK supplier, or splitting the order.`);
  if (competition && competition.vsAvgPct !== null && competition.vsAvgPct >= 25) watch.push(`UK imports of this product ran ${Math.round(competition.vsAvgPct)}% above normal in ${monthName(competition.month)}: buyers are stocking up, so supply may tighten.`);
  if (competition && competition.steppingUp && competition.steppingUp.length) watch.push(`${competition.steppingUp.join(", ")} ${competition.steppingUp.length === 1 ? "is" : "are"} importing more of this lately.`);

  return {
    ok: true, scored, timing, recTonnes,
    best: { ...best, total: best.effectivePerT * recTonnes },
    alternatives: { cheapest, safest, fastest },
    reasons, watch,
  };
}
