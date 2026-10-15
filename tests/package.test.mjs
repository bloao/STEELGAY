import test from "node:test";
import assert from "node:assert/strict";
import { packageFor, planPackages } from "../lib/package.mjs";

const lines = [
  { productId: "a", name: "100×50 Flat", category: "Flat", needT: 5, usage: 6, coverMonths: 0.7 },
  { productId: "b", name: "40×10 Flat", category: "Flat", needT: 17, usage: 15, coverMonths: 2 },
  { productId: "c", name: "25 mm Round", category: "Bar", needT: 5, usage: 4, coverMonths: 2 },
];
const price = () => 750;

test("needed products share one load when together they meet the minimum", () => {
  const p = packageFor({ id: "s", name: "Mill", supplies: ["Flat", "Bar"], moqMinT: 25, moqMaxT: 28 }, { lines, price });
  assert.equal(p.totalT, 27);
  assert.equal(p.extraT, 0);
  assert.equal(p.loads, 1);
  assert.ok(p.meetsMoq);
});

test("a short load brings forward other products before topping up", () => {
  const fillers = [{ productId: "d", name: "Angle", category: "Flat", needT: 0, usage: 10, coverMonths: 3 }];
  const p = packageFor({ id: "s", name: "Mill", supplies: ["Flat"], moqMinT: 30, moqMaxT: 30 }, { lines, fillers, price });
  assert.equal(p.needT, 22); // round not supplied
  assert.equal(p.totalT, 30);
  assert.equal(p.items.find((x) => x.productId === "d").tonnes, 8);
  assert.deepEqual(p.uncovered, ["25 mm Round"]);
});

test("with no filler the lines on the load are topped up to the minimum", () => {
  const p = packageFor({ id: "s", name: "Mill", supplies: ["Flat", "Bar"], moqMinT: 40, moqMaxT: 40 }, { lines, price });
  assert.equal(p.totalT, 40);
  assert.equal(p.extraT, 13);
});

test("suppliers covering every product rank first", () => {
  const r = planPackages({ lines, suppliers: [{ id: "x", name: "Flat only", supplies: ["Flat"], moqMinT: 20 }, { id: "y", name: "All", supplies: ["Flat", "Bar"], moqMinT: 25, moqMaxT: 28 }], price });
  assert.equal(r.best.supplier, "All");
});
