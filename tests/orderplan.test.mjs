import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreOptions, recommend, thresholdsFor } from "../lib/orderplan.mjs";

const opts = [
  { id: "a", name: "Cheap import", effectivePerT: 740, worstPerT: 1110, probability: 0.4, arrival: "2026-11-04", covers: "except-duty", quoteScope: "product", onTimePct: 90 },
  { id: "b", name: "UK all-in", effectivePerT: 760, worstPerT: 760, probability: null, arrival: "2026-10-20", covers: "everything", quoteScope: "product", onTimePct: 95 },
  { id: "c", name: "Late", effectivePerT: 700, worstPerT: 700, arrival: "2027-01-20", quoteScope: "general" },
];
const product = { name: "40×10 Flat", monthlyUsageT: 16, costPerT: 756, coverMonths: 2, moqT: 0 };

test("quota weight and lateness change the ranking", () => {
  const noQuota = scoreOptions(opts, { needBy: "2026-12-14", appetite: "balanced", thresholds: { approaches: { balanced: { quotaWeightPct: 0, cashRatePct: 0, leadDayPct: 0, reliabilityPct: 0 } } } });
  assert.equal(noQuota[0].id, "a"); // £740 beats £760 when quota risk is ignored; late one is penalised
  assert.ok(noQuota.find((o) => o.id === "c").lateDays > 30);
  const heavy = scoreOptions(opts, { needBy: "2026-12-14", appetite: "balanced", thresholds: { approaches: { balanced: { quotaWeightPct: 60 } } } });
  assert.equal(heavy[0].id, "b");
  assert.ok(heavy.find((o) => o.id === "a").warnings.some((w) => /quota runs out/.test(w)));
});

test("cash flow favours long payment terms; speed favours quick, reliable suppliers", () => {
  const two = [
    { id: "slow-credit", name: "90-day terms", effectivePerT: 800, worstPerT: 800, paymentDays: 90, leadDays: 42, onTimePct: 80, arrival: "2026-11-20" },
    { id: "fast-cash", name: "Pay on delivery, quick", effectivePerT: 805, worstPerT: 805, paymentDays: 0, leadDays: 3, onTimePct: 98, arrival: "2026-10-20" },
  ];
  assert.equal(scoreOptions(two, { needBy: "2026-12-14", appetite: "cashflow" })[0].id, "slow-credit");
  assert.equal(scoreOptions(two, { needBy: "2026-12-14", appetite: "speed" })[0].id, "fast-cash");
  // price still counts: a much cheaper slow supplier still wins on speed
  const cheap = [{ ...two[0], effectivePerT: 700, worstPerT: 700 }, two[1]];
  assert.equal(scoreOptions(cheap, { needBy: "2026-12-14", appetite: "speed" })[0].id, "slow-credit");
  assert.equal(thresholdsFor("cashflow").buyAheadTriggerPct > thresholdsFor("balanced").buyAheadTriggerPct, true);
});

test("timing: buy ahead when prices rise and the product is safe to hold, wait when falling", () => {
  const up = recommend({ product, tonnage: 16, needBy: "2026-12-14", appetite: "balanced", options: opts, forecast: { in3: 3 }, aheadOptions: [{ months: 2, netMid: 400, netLow: 50, signal: "buy-ahead" }], stockpile: { level: "good" } });
  assert.equal(up.timing.action, "buy-ahead");
  assert.equal(up.recTonnes, 48);
  const risky = recommend({ product, tonnage: 16, needBy: "2026-12-14", appetite: "balanced", options: opts, forecast: { in3: 3 }, aheadOptions: [{ months: 2, netMid: 400 }], stockpile: { level: "risk" } });
  assert.equal(risky.timing.action, "order-now");
  const down = recommend({ product, tonnage: 16, needBy: "2026-12-14", appetite: "balanced", options: [opts[1]], forecast: { in3: -3 }, stockpile: { level: "good" } });
  assert.equal(down.timing.action, "wait");
  assert.equal(recommend({ product, tonnage: 16, options: [] }).ok, false);
});

test("thresholds you set change the decision", () => {
  const base = { product, tonnage: 16, needBy: "2026-12-14", appetite: "balanced", options: opts, forecast: { in3: 3 }, aheadOptions: [{ months: 2, netMid: 400, netLow: 50 }], stockpile: { level: "good", score: 72 } };
  assert.equal(recommend(base).timing.action, "buy-ahead");
  const bal = (v) => ({ approaches: { balanced: v } });
  assert.equal(recommend({ ...base, thresholds: bal({ buyAheadTriggerPct: 4 }) }).timing.action, "order-now"); // +3% isn't enough
  assert.equal(recommend({ ...base, thresholds: bal({ buyAheadMinSaving: 500 }) }).timing.action, "order-now"); // £400 saving too small
  assert.equal(recommend({ ...base, thresholds: bal({ holdMinScore: 80 }) }).timing.action, "order-now"); // not safe enough to hold
  assert.equal(recommend({ ...base, appetite: "cashflow" }).timing.action, "order-now"); // cash flow needs +4% before tying up cash
  assert.ok(!scoreOptions(opts, { needBy: "2026-12-14", thresholds: { onTimeWarnPct: 85 } }).find((o) => o.id === "a").warnings.some((w) => /on time/.test(w)));
  assert.ok(scoreOptions(opts, { needBy: "2026-12-14", thresholds: { onTimeWarnPct: 92 } }).find((o) => o.id === "a").warnings.some((w) => /on time/.test(w)));
});

test("splitting: a quick supplier bridges the gap until a cheaper late one lands", async () => {
  const { bestSplits, splitTonnages } = await import("../lib/orderplan.mjs");
  const base = (id, name, perT, arrival, leadDays, extra = {}) => ({ id, name, effectivePerT: perT, worstPerT: perT, arrival, leadDays, onTimePct: 95, paymentDays: 30, ...extra });
  const quick = (t) => base("quick", "Quick UK", 800, "2026-10-20", 5);
  const cheap = (t) => base("cheap", "Cheap import", 700, "2026-12-01", 45);
  const singles = scoreOptions([quick(20), cheap(20)], { needBy: "2026-11-01", appetite: "balanced" });
  const tonnages = splitTonnages(20, singles, 10);
  assert.ok(tonnages.length >= 3);
  const res = bestSplits({ total: 20, needBy: "2026-11-01", usagePerMonth: 10, appetite: "balanced", singles, extraOrderCost: 150,
    table: (id, t) => (id === "quick" ? quick(t) : cheap(t)) });
  assert.ok(res.better, "a split should win");
  const [first, second] = res.better.parts;
  assert.equal(first.id, "quick");
  assert.equal(second.id, "cheap");
  assert.equal(second.lateDays, 0);
  assert.ok(res.better.saving > 0);
});

test("splitting: no split when one supplier is simply best", async () => {
  const { bestSplits } = await import("../lib/orderplan.mjs");
  const o = (id, perT) => ({ id, name: id, effectivePerT: perT, worstPerT: perT, arrival: "2026-10-20", leadDays: 5, onTimePct: 95, paymentDays: 30 });
  const singles = scoreOptions([o("a", 700), o("b", 760)], { needBy: "2026-11-01" });
  const res = bestSplits({ total: 20, needBy: "2026-11-01", usagePerMonth: 10, singles, table: (id) => o(id, id === "a" ? 700 : 760) });
  assert.equal(res.better, null);
  assert.equal(res.single.id, "a");
});
