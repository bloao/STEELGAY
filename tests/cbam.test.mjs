import { test } from "node:test";
import assert from "node:assert/strict";
import { calculate, cbamInScope } from "../lib/calc.mjs";
import { validateSettings, SETTINGS_DEFAULTS } from "../lib/settings.mjs";
import { validateSupplier } from "../lib/suppliers.mjs";

const base = { commodityCode: "7214991000", origin: "European Union", tonnage: 25, importDate: "2026-11-15", incoterm: "DAP", priceAmount: 800, priceCurrency: "GBP" };
const cbamLine = (r) => r.lines.find((l) => l.key === "cbam");

test("UK CBAM scope follows Schedule 16", () => {
  for (const c of ["7214991000", "7216210000", "7208390090", "7306619200", "7308909900", "7326909890", "2601120000"]) assert.equal(cbamInScope(c), true, c);
  for (const c of ["7204100000", "7202210000", "7202300000", "7312100000", "7317000000", "7601100000"]) assert.equal(cbamInScope(c), false, c);
});

test("CBAM toggle: off leaves it out, on prices emissions × (rate − relief)", () => {
  const off = calculate(base, { categories: [] }, { asOf: "2026-10-14", settings: { cbamEnabled: false } });
  assert.equal(cbamLine(off).perTonne, 0);
  assert.equal(cbamLine(off).source, "Switched off");
  const on = calculate({ ...base, emissionsPerT: 2, ukCarbonPrice: 62, overseasCarbonPrice: 12 }, { categories: [] }, { asOf: "2026-10-14", settings: { cbamStartDate: "0000-01-01" } });
  assert.equal(cbamLine(on).perTonne, 100);
  assert.equal(cbamLine(on).status, "included");
  // relief can't go below zero
  const relief = calculate({ ...base, emissionsPerT: 2, ukCarbonPrice: 62, overseasCarbonPrice: 90 }, { categories: [] }, { asOf: "2026-10-14", settings: { cbamStartDate: "0000-01-01" } });
  assert.equal(cbamLine(relief).perTonne, 0);
  // UK goods never pay it
  const uk = calculate({ ...base, origin: "United Kingdom", emissionsPerT: 2, ukCarbonPrice: 62 }, { categories: [] }, { asOf: "2026-10-14", settings: { cbamStartDate: "0000-01-01" } });
  assert.equal(cbamLine(uk).perTonne, 0);
});

test("CBAM values are fixed by regulation; supplier fields validate", () => {
  assert.equal(SETTINGS_DEFAULTS.cbamRatePerT, 62);
  const tried = validateSettings({ cbamRatePerT: "70.5", cbamEafTPerT: "0.4" });
  assert.equal(tried.settings.cbamRatePerT, 62); // settings can't change UK regulation values
  assert.equal(tried.settings.cbamEafTPerT, 0.5);
  const s = validateSupplier({ name: "Mill", productionRoute: "eaf", emissionsPerT: "0.45", carbonPricePaidPerT: "" });
  assert.equal(s.valid, true);
  assert.deepEqual([s.supplier.productionRoute, s.supplier.emissionsPerT, s.supplier.carbonPricePaidPerT], ["eaf", 0.45, null]);
  assert.equal(validateSupplier({ name: "Mill", productionRoute: "coal" }).supplier.productionRoute, "");
  assert.equal(validateSupplier({ name: "Mill", emissionsPerT: 8 }).valid, false);
});
