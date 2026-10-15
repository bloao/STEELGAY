import { test } from "node:test";
import assert from "node:assert/strict";
import { calculate, quotaExposure, validateInputs, originMatches } from "../lib/calc.mjs";

const categories = [{ id: "1", name: "Hot-rolled sheets", commodityPrefixes: ["72083900"] }];
const base = {
  commodityCode: "7208390090",
  origin: "Turkey",
  tonnage: 100,
  importDate: "2026-11-15",
  incoterm: "FOB",
  priceAmount: 600,
  priceCurrency: "GBP",
  freightToUkPerT: 40,
  insurancePerT: 5,
};
const quotaRow = (over = {}) => ({
  orderNumber: "058001",
  geographicalAreas: ["Türkiye"],
  commodityCodes: ["7208390090"],
  categoryIds: ["1"],
  measurementUnit: "Kilogram (kg)",
  startDate: "2026-10-01",
  endDate: "2026-12-31",
  status: "Open",
  initialVolume: 1_000_000, // 1,000 t
  balance: 1_000_000,
  ...over,
});
const asOf = "2026-10-11";

test("validation rejects missing fields and pads 8-digit codes", () => {
  const bad = validateInputs({});
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.commodityCode && bad.errors.tonnage && bad.errors.priceAmount);
  const ok = validateInputs({ ...base, commodityCode: "72083900" });
  assert.equal(ok.inputs.commodityCode, "7208390000");
});

test("origin aliases match GOV.UK spellings", () => {
  assert.ok(originMatches("Turkey", { description: "Türkiye" }));
  assert.ok(originMatches("South Korea", { description: "Korea, Republic of (South Korea)" }));
  assert.ok(originMatches("India", { id: "IN" }));
  assert.ok(!originMatches("India", { description: "Indonesia" }));
});

test("FOB adds freight + insurance to customs value; duty applies to CIF value", () => {
  const r = calculate(base, {
    categories: [],
    dutyMeasures: [{ measureTypeId: "103", measureType: "Third country duty", label: "10%", ratePercent: 10, perTonneGbp: 0 }],
  }, { asOf });
  assert.equal(r.ok, true);
  assert.equal(r.customsValuePerT, 645);
  assert.equal(r.lines.find((l) => l.key === "duty").perTonne, 64.5);
  assert.equal(r.totals.expectedPerT, 645 + 64.5);
  assert.equal(r.totals.vatPerT, Math.round((645 + 64.5) * 0.2 * 100) / 100);
});

test("CFR excludes entered freight because it is already in the price", () => {
  const r = calculate({ ...base, incoterm: "CFR" }, { categories: [] }, { asOf });
  assert.equal(r.lines.find((l) => l.key === "freight").perTonne, 0);
  assert.equal(r.customsValuePerT, 605);
});

test("DDP moves duty and quota to the supplier", () => {
  const r = calculate({ ...base, incoterm: "DDP" }, { categories, quotaRows: [quotaRow({ balance: 0 })] }, { asOf });
  assert.equal(r.buyerImports, false);
  assert.equal(r.lines.find((l) => l.key === "quota").status, "supplier");
  assert.equal(r.totals.vatPerT, 0);
});

test("plenty of quota headroom gives ~0 expected steel-measure charge", () => {
  const r = calculate(base, { categories, quotaRows: [quotaRow()] }, { asOf });
  assert.equal(r.quota.matched, true);
  assert.equal(r.quota.probability, 0);
  assert.equal(r.lines.find((l) => l.key === "quota").perTonne, 0);
});

test("exhausted quota charges 50% of customs value on every tonne", () => {
  const r = calculate(base, { categories, quotaRows: [quotaRow({ balance: 0 })] }, { asOf });
  assert.equal(r.quota.probability, 1);
  assert.equal(r.lines.find((l) => l.key === "quota").perTonne, 645 * 0.5);
});

test("burn projection: line likely to run out gives a partial expected charge", () => {
  // 900 t used in 11 days (~82 t/day) leaves 100 t; import is 35 days away.
  const q = quotaExposure({
    row: quotaRow({ balance: 100_000 }), burnRow: null, tonnage: 100,
    importDate: "2026-11-15", asOf, valuePerT: 600, rate: 0.5,
  });
  assert.equal(q.probability, 1);
  assert.equal(q.expected, 100 * 600 * 0.5);

  // Slow burn: 10 t used in 11 days, 990 t left → safe.
  const slow = quotaExposure({
    row: quotaRow({ balance: 990_000 }), burnRow: null, tonnage: 100,
    importDate: "2026-11-15", asOf, valuePerT: 600, rate: 0.5,
  });
  assert.equal(slow.probability, 0);

  // Borderline: projected balance near the order size gives 0 < P < 1.
  const mid = quotaExposure({
    row: quotaRow({ balance: 600_000 }), burnRow: null, tonnage: 100,
    importDate: "2026-11-01", asOf, valuePerT: 600, rate: 0.5,
  });
  assert.ok(mid.probability > 0 && mid.probability < 1, `P=${mid.probability}`);
  assert.ok(mid.low < mid.expected && mid.expected < mid.high);
});

test("no quota line for a steel-measure product means all tonnes exposed", () => {
  const r = calculate({ ...base, origin: "India" }, { categories, quotaRows: [quotaRow()] }, { asOf });
  assert.equal(r.quota.matched, false);
  assert.equal(r.quota.probability, 1);
});

test("non-GBP quote needs a rate and uses it", () => {
  const none = calculate({ ...base, priceCurrency: "USD" }, { categories: [] }, { asOf });
  assert.equal(none.ok, false);
  assert.ok(none.errors.fxRateOverride);
  const r = calculate({ ...base, priceCurrency: "USD", fxBufferPct: 2 }, { categories: [], fx: { rate: 0.75, source: "test", date: "2026-10-10" } }, { asOf });
  assert.equal(r.lines[0].perTonne, 450);
  assert.equal(r.lines.find((l) => l.key === "fxBuffer").perTonne, 9);
});

test("CBAM: not costed without data after 2027, costed with data", () => {
  const later = { ...base, importDate: "2027-02-01" };
  const missing = calculate(later, { categories: [] }, { asOf });
  assert.equal(missing.complete, false);
  assert.equal(missing.lines.find((l) => l.key === "cbam").status, "missing");
  const r = calculate({ ...later, emissionsPerT: 2, ukCarbonPrice: 50, overseasCarbonPrice: 10 }, { categories: [] }, { asOf });
  assert.equal(r.lines.find((l) => l.key === "cbam").perTonne, 80);
});

test("trade remedies are added on top of ordinary duty", () => {
  const r = calculate(base, {
    categories: [],
    dutyMeasures: [
      { measureTypeId: "103", label: "0%", ratePercent: 0, perTonneGbp: 0 },
      { measureTypeId: "552", measureType: "Definitive anti-dumping duty", label: "£20/t", ratePercent: 0, perTonneGbp: 20 },
    ],
  }, { asOf });
  assert.equal(r.lines.find((l) => l.key === "remedies").perTonne, 20);
});

test("quota risk early in a quarter leans on the pace of past quarters", () => {
  const row = { orderNumber: "058623", startDate: "2026-10-01", endDate: "2026-12-31", initialVolume: 5000, balance: 4800, measurementUnit: "Tonne" };
  const base = { tonnage: 25, importDate: "2026-11-20", asOf: "2026-10-05", valuePerT: 700, rate: 0.5 };
  const quiet = quotaExposure({ ...base, row });
  const busy = quotaExposure({ ...base, row: { ...row, historicBurnPerDayT: 120 } });
  assert.ok(quiet.probability < 0.5); // 200 t in 5 days: plenty left by 20 Nov
  assert.ok(busy.probability > quiet.probability); // past quarters ran ~120 t/day: likely gone by then
  assert.match(busy.basis, /past quarters/);
  // later in the quarter the quarter's own pace dominates
  const late = quotaExposure({ ...base, asOf: "2026-11-25", importDate: "2026-12-10", row: { ...row, balance: 4000, historicBurnPerDayT: 120 } });
  assert.match(late.basis, /100% this period/);
});
