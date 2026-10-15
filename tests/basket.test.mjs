import test from "node:test";
import assert from "node:assert/strict";
import { sizeLoad, planBasket } from "../lib/basket.mjs";

const items = [
  { productId: "a", name: "100×50 Flat", needT: 5, usage: 6 },
  { productId: "b", name: "40×10 Flat", needT: 17, usage: 15 },
  { productId: "c", name: "25 mm Round", needT: 5, usage: 4 },
];
const opt = (perT, extra = {}) => ({ effectivePerT: perT, score: perT, worstPerT: perT, quotaExposure: 0, lateDays: 0, arrival: "2026-11-01", warnings: [], ...extra });

test("a load is topped up to the minimum in proportion to demand", () => {
  const l = sizeLoad(items, { moqMinT: 40, moqMaxT: 40 });
  assert.equal(l.totalT, 40);
  const b = l.lines.find((x) => x.productId === "b");
  assert.ok(b.extraT > l.lines.find((x) => x.productId === "c").extraT); // fastest mover takes most of the top-up
});

test("above one truck, enough loads are planned and the last meets the minimum", () => {
  const l = sizeLoad(items, { moqMinT: 23, moqMaxT: 23 });
  assert.equal(l.loads, 2);
  assert.equal(l.totalT, 46);
});

test("a supplier whose load fits without extra beats a cheaper one that forces overbuying", () => {
  const suppliers = [{ id: "fit", name: "Fits", moqMinT: 25, moqMaxT: 28 }, { id: "big", name: "Big load", moqMinT: 60, moqMaxT: 60 }];
  const line = (sid) => (sid === "fit" ? opt(750) : opt(745));
  const r = planBasket({ items, suppliers, line, money: { ratePct: 8, storagePerTMonth: 20 } });
  assert.equal(r.best.parts[0].supplier, "Fits");
  assert.equal(r.best.extraT, 0);
});

test("products only one supplier sells force a split", () => {
  const suppliers = [{ id: "x", name: "Flats", moqMinT: 20 }, { id: "y", name: "Rounds", moqMinT: 5 }];
  const line = (sid, pid) => (sid === "x" && pid !== "c" ? opt(740) : sid === "y" && pid === "c" ? opt(760) : null);
  const r = planBasket({ items, suppliers, line });
  assert.equal(r.best.kind, "split");
  assert.deepEqual(r.best.parts.map((p) => p.supplier).sort(), ["Flats", "Rounds"]);
});
