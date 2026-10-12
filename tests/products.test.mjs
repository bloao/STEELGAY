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

// ---- data points added on the products-tab branch
import { parseProductTable } from "../lib/products.mjs";

test("stock recorded on an earlier date is drawn down by usage", () => {
  const p = validateProduct({ name: "x", commodityCode: "7216210000", stockT: 30, monthlyUsageT: 10, costPerT: 800, stockAsOf: "2026-09-12" }, { asOf }).product;
  const m = stockMetrics(p, asOf); // ~1 month later
  assert.equal(m.estimated, true);
  assert.equal(Math.round(m.stockNowT), 20);
  assert.equal(m.stockValue, m.stockNowT * 800); // valued at cost on estimated stock
});

test("stock date cannot be in the future", () => {
  assert.ok(validateProduct({ name: "x", commodityCode: "7216210000", stockT: 1, monthlyUsageT: 1, costPerT: 1, stockAsOf: "2099-01-01" }, { asOf }).errors.stockAsOf);
});

test("suggested order is rounded up to the MOQ", () => {
  const m = stockMetrics(P({ stockT: 25, moqT: 20 }), asOf); // would suggest 5 t
  assert.equal(m.suggestedOrderT, 20);
  assert.equal(m.moqApplied, true);
  assert.equal(stockMetrics(P({ stockT: 40, moqT: 20 }), asOf).suggestedOrderT, 0); // nothing needed → no MOQ order
});

test("pasted spreadsheet rows (tab-separated, with a category heading row) import", () => {
  const text = [
    "Category\tDescription\tProduct Code\tCurrent Stock\tMonthly Usage\tStock Cost Price",
    "Merchant Bar\t\t\t\t\t",
    "\t40×40×3 Angle\t7216210000\t36t\t10t\t£766",
    "\t100×50 Flat\t7214 9110 90\t1.5t\t2t\t£781",
  ].join("\n");
  const { rows, error, columns } = parseProductTable(text);
  assert.equal(error, null);
  assert.equal(columns.commodityCode, 2);
  assert.equal(rows.length, 2);
  const v = validateProduct(rows[1], { asOf });
  assert.equal(v.valid, true);
  assert.equal(v.product.category, "Merchant Bar");
  assert.equal(v.product.commodityCode, "7214911090");
  assert.equal(v.product.stockT, 1.5);
  assert.equal(v.product.costPerT, 781);
});

test("CSV with quotes and optional columns imports", () => {
  const { rows } = parseProductTable('Description,Commodity code,Stock,Usage,Cost,Lead time,MOQ\n"Angle, 50×50×6",72162100,"1,200",80,"£812",8 weeks,25t');
  const v = validateProduct(rows[0], { asOf });
  assert.equal(v.valid, true);
  assert.equal(v.product.name, "Angle, 50×50×6");
  assert.equal(v.product.stockT, 1200);
  assert.equal(v.product.leadTimeWeeks, 8);
  assert.equal(v.product.moqT, 25);
});

test("text without a recognisable header is rejected with a helpful message", () => {
  assert.match(parseProductTable("hello\tworld").error, /header row/);
});
