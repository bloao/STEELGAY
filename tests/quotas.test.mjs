import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTariffQuotas, mergeDefinitions, buildLines, toCalcRow, unitToTonnes } from "../lib/quota-feed.mjs";
import { ORDER_LINES, namedOriginsFor, isRemovedFromScope } from "../lib/steel-measure.mjs";
import { calculate } from "../lib/calc.mjs";

const categories = [{ id: "1", name: "Hot-rolled sheets", commodityPrefixes: ["72083900"] }];
const tariffPayload = (order, { initial = "40000000.0", balance = "9000000.0", start = "2026-10-01T00:00:00.000Z", end = "2026-12-31T23:59:59.000Z" } = {}) => ({
  data: [{
    id: "123", type: "definition",
    attributes: {
      quota_definition_sid: "123", quota_order_number_id: order, initial_volume: initial, balance,
      validity_start_date: start, validity_end_date: end, status: "Open", measurement_unit: "Kilogram (kg)",
      last_allocation_date: "2026-10-10",
    },
    relationships: { order_number: { data: { id: order, type: "order_number" } }, measures: { data: [] } },
  }],
  meta: { pagination: { page: 1, per_page: 5, total_count: 1 } },
});

test("the measure has 72 lines, 058600–058671, across 20 categories", () => {
  assert.equal(ORDER_LINES.length, 72);
  assert.equal(new Set(ORDER_LINES.map((l) => l.categoryId)).size, 20);
  assert.deepEqual(namedOriginsFor("1"), ["European Union", "India", "South Korea"]);
});

test("HMRC payload parses string or number volumes", () => {
  const [d] = parseTariffQuotas(tariffPayload("058600"));
  assert.equal(d.orderNumber, "058600");
  assert.equal(d.startDate, "2026-10-01");
  assert.equal(d.endDate, "2026-12-31");
  assert.equal(d.initialVolume, 40000000);
  assert.equal(unitToTonnes(d.balance, d.measurementUnit), 9000);
  const [n] = parseTariffQuotas(tariffPayload("058600", { initial: 1000, balance: 250 }));
  assert.equal(n.balance, 250);
  assert.deepEqual(parseTariffQuotas({}), []);
});

test("HMRC data wins over the DBT daily row for the same period", () => {
  const tariff = parseTariffQuotas(tariffPayload("058600", { balance: "5000000" }));
  const dbt = [{ orderNumber: "058600", startDate: "2026-10-01", endDate: "2026-12-31", initialVolume: 40000000, balance: 8000000, measurementUnit: "Kilogram (kg)" },
    { orderNumber: "058601", startDate: "2026-10-01", endDate: "2026-12-31", initialVolume: 8000000, balance: 8000000, measurementUnit: "Kilogram (kg)" }];
  const merged = mergeDefinitions(tariff, dbt);
  assert.equal(merged.find((d) => d.orderNumber === "058600").balance, 5000000);
  assert.equal(merged.find((d) => d.orderNumber === "058600").source, "tariff");
  assert.equal(merged.find((d) => d.orderNumber === "058601").source, "dbt");
});

test("lines get burn rate, run-out date and risk", () => {
  const defs = parseTariffQuotas(tariffPayload("058600")); // 31,000 t used in 11 days, 9,000 t left
  const lines = buildLines(defs, categories, "2026-10-11");
  assert.equal(lines.length, 72);
  const eu = lines.find((l) => l.orderNumber === "058600");
  assert.equal(eu.found, true);
  assert.equal(Math.round(eu.burnPerDayT), 2818);
  assert.equal(eu.runOutDate, "2026-10-14");
  assert.equal(eu.risk, "critical");
  assert.equal(lines.find((l) => l.orderNumber === "058601").risk, "unknown");
});

test("calc rows carry the category and the residual label", () => {
  const row = toCalcRow({ orderNumber: "058603", startDate: "2026-10-01", endDate: "2026-12-31", initialVolume: 1, balance: 1, measurementUnit: "kg" }, categories);
  assert.deepEqual(row.categoryIds, ["1"]);
  assert.deepEqual(row.commodityCodes, ["72083900"]);
  assert.match(row.geographicalAreas[0], /Residual/);
});

const base = { commodityCode: "7208390090", tonnage: 100, importDate: "2026-11-15", incoterm: "CFR", priceAmount: 600, priceCurrency: "GBP" };
const rowsFor = (balances) => Object.entries(balances).map(([order, balanceT]) => toCalcRow({
  orderNumber: order, startDate: "2026-10-01", endDate: "2026-12-31", initialVolume: 10_000_000, balance: balanceT * 1000, measurementUnit: "Kilogram (kg)", status: "Open",
}, categories));
const market = (extra = {}) => ({ categories, quotaRows: rowsFor({ "058600": 10000, "058601": 10000, "058602": 10000, "058603": 0 }), ...extra });
const asOf = "2026-10-11";

test("named origins use their own line, everyone else uses Residual", () => {
  assert.equal(calculate({ ...base, origin: "India" }, market(), { asOf }).quota.orderNumber, "058601");
  assert.equal(calculate({ ...base, origin: "European Union" }, market(), { asOf }).quota.orderNumber, "058600");
  const china = calculate({ ...base, origin: "China" }, market(), { asOf });
  assert.equal(china.quota.orderNumber, "058603");
  assert.equal(china.quota.probability, 1); // residual is used up
  assert.equal(calculate({ ...base, origin: "Turkey" }, market(), { asOf }).quota.orderNumber, "058603");
});

test("50% steel duty is added on top of ordinary duty", () => {
  const r = calculate({ ...base, origin: "China" }, market({
    dutyMeasures: [{ measureTypeId: "103", measureType: "Third country duty", label: "10%", ratePercent: 10, perTonneGbp: 0 }],
  }), { asOf });
  assert.equal(r.lines.find((l) => l.key === "duty").perTonne, 60);
  assert.equal(r.lines.find((l) => l.key === "quota").perTonne, 300);
  assert.equal(r.totals.expectedPerT, 960);
});

test("Ukraine is outside the measure", () => {
  const r = calculate({ ...base, origin: "Ukraine" }, market(), { asOf });
  assert.equal(r.quota, null);
  assert.equal(r.lines.find((l) => l.key === "quota").perTonne, 0);
});

test("wire codes removed from 1 October 2026 are out of scope", () => {
  assert.equal(isRemovedFromScope("7217304900", "2026-09-30"), false);
  assert.equal(isRemovedFromScope("7217304900", "2026-10-01"), true);
  const cats = [{ id: "28", name: "Non-alloy wire", commodityPrefixes: ["72173049"] }];
  const r = calculate({ ...base, commodityCode: "7217304900", origin: "China" }, { categories: cats, quotaRows: [] }, { asOf });
  assert.equal(r.lines.find((l) => l.key === "quota").status, "n/a");
});
