import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreOptions, recommend } from "../lib/orderplan.mjs";

const opts = [
  { id: "a", name: "Cheap import", effectivePerT: 740, worstPerT: 1110, probability: 0.4, arrival: "2026-11-04", covers: "except-duty", quoteScope: "product", onTimePct: 90 },
  { id: "b", name: "UK all-in", effectivePerT: 760, worstPerT: 760, probability: null, arrival: "2026-10-20", covers: "everything", quoteScope: "product", onTimePct: 95 },
  { id: "c", name: "Late", effectivePerT: 700, worstPerT: 700, arrival: "2027-01-20", quoteScope: "general" },
];
const product = { name: "40×10 Flat", monthlyUsageT: 16, costPerT: 756, coverMonths: 2, moqT: 0 };

test("risk appetite and lateness change the ranking", () => {
  const bold = scoreOptions(opts, { needBy: "2026-12-14", appetite: "bold" });
  assert.equal(bold[0].id, "a"); // £740 beats £760 when quota risk is ignored; late one is penalised
  assert.ok(bold.find((o) => o.id === "c").lateDays > 30);
  const cautious = scoreOptions(opts, { needBy: "2026-12-14", appetite: "cautious" });
  assert.equal(cautious[0].id, "b");
  assert.ok(cautious.find((o) => o.id === "a").warnings.some((w) => /quota runs out/.test(w)));
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
  assert.equal(recommend({ ...base, thresholds: { buyAheadTriggerPct: 4 } }).timing.action, "order-now"); // +3% isn't enough
  assert.equal(recommend({ ...base, thresholds: { buyAheadMinSaving: 500 } }).timing.action, "order-now"); // £400 saving too small
  assert.equal(recommend({ ...base, thresholds: { holdMinScore: 80 } }).timing.action, "order-now"); // not safe enough to hold
  // weighting the quota-miss cost at 0% makes the cheaper import win under "balanced"
  assert.equal(scoreOptions(opts, { needBy: "2026-12-14", appetite: "balanced", thresholds: { quotaWeightBalancedPct: 0 } })[0].id, "a");
  assert.ok(!scoreOptions(opts, { needBy: "2026-12-14", thresholds: { onTimeWarnPct: 85 } }).find((o) => o.id === "a").warnings.some((w) => /on time/.test(w)));
  assert.ok(scoreOptions(opts, { needBy: "2026-12-14", thresholds: { onTimeWarnPct: 92 } }).find((o) => o.id === "a").warnings.some((w) => /on time/.test(w)));
});
