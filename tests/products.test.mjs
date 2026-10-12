import { test } from "node:test";
import assert from "node:assert/strict";
import { SEED_PRODUCTS, validateProduct, stockMetrics } from "../lib/products.mjs";

const asOf = "2026-10-12";
const P = (over = {}) => validateProduct({ name: "Test", commodityCode: "7216210000", stockT: 30, monthlyUsageT: 10, costPerT: 800, ...over }).product;

test("the five sample products load and validate", () => {
  assert.equal(SEED_PRODUCTS.length, 5);
  for (const p of SEED_PRODUCTS) assert.equal(validateProduct(p).valid, true, p.name);
});

test("validation catches missing fields and pads 8-digit codes", () => {
  const bad = validateProduct({ name: "", commodityCode: "12", stockT: -1 });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.name && bad.errors.commodityCode && bad.errors.stockT && bad.errors.monthlyUsageT && bad.errors.costPerT);
  assert.equal(P({ commodityCode: "72162100" }).commodityCode, "7216210000");
  assert.equal(validateProduct({ name: "x", commodityCode: "7216210000", stockT: "1,500", monthlyUsageT: "2t", costPerT: "£781" }).product.stockT, 1500);
});

test("cover, stock-out date and stock value", () => {
  const m = stockMetrics(P(), asOf);
  assert.equal(m.coverMonths, 3);
  assert.equal(m.stockOutDate, "2027-01-11"); // 3 × 30.44 days = 91 days
  assert.equal(m.stockValue, 24000);
});

test("without a lead time: <1 month is critical, <2 is low", () => {
  assert.equal(stockMetrics(P({ stockT: 8 }), asOf).status, "critical");
  assert.equal(stockMetrics(P({ stockT: 15 }), asOf).status, "low");
  assert.equal(stockMetrics(P({ stockT: 25 }), asOf).status, "ok");
});

test("with a lead time: reorder point, order-by date and suggested quantity", () => {
  // 10 t/month, 8.69 weeks ≈ 2 months lead time, 5 t safety, 3 months target
  const m = stockMetrics(P({ stockT: 24, leadTimeWeeks: 8.69, safetyStockT: 5 }), asOf);
  assert.equal(Math.round(m.reorderPointT), 25);
  assert.equal(m.status, "reorder");
  assert.equal(m.suggestedOrderT, Math.ceil(10 * (8.69 / 4.345 + 3) + 5 - 24));
  assert.ok(m.latestOrderDate < asOf); // already past the order-by date
});

test("100×50 Flat (1.5 t, 2 t/month) is the urgent sample line", () => {
  const flat = validateProduct(SEED_PRODUCTS.find((p) => p.name === "100×50 Flat")).product;
  const m = stockMetrics(flat, asOf);
  assert.equal(m.status, "critical");
  assert.equal(m.stockOutDate, "2026-11-04");
  assert.equal(m.suggestedOrderT, 5);
});
