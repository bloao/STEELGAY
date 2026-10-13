import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { validateProduct } from "../lib/products.mjs";
import { validateSettings, SETTINGS_DEFAULTS, CATALOGUE_GROUPS } from "../lib/settings.mjs";

const ctx = { window: {} };
vm.createContext(ctx);
for (const f of ["steel-commodities.js", "steel-trade-measure.js", "steel-catalogue.js"]) {
  vm.runInContext(readFileSync(new URL(`../${f}`, import.meta.url), "utf8"), ctx);
}
const CAT = ctx.window.STEEL_CATALOGUE;
const CODES = new Set(ctx.window.STEEL_COMMODITIES.commodities.map((c) => c.code));
const categoryOf = (code) => ctx.window.STEEL_TRADE_MEASURE.categories.find((c) => c.commodityPrefixes.some((p) => code.startsWith(p)))?.id || null;

function* everySelection(fam) {
  let combos = [{}];
  for (const f of fam.fields.slice(1)) combos = combos.flatMap((c) => f.values.map((v) => ({ ...c, [f.key]: v })));
  for (const size of fam.fields[0].values) for (const c of combos) yield { ...c, size };
}

test("every catalogue selection resolves to a real UK tariff code (or a real prefix to choose from)", () => {
  let n = 0;
  for (const fam of CAT.families) {
    for (const sel of everySelection(fam)) {
      const r = CAT.resolve(fam.id, sel);
      n++;
      assert.ok(r.name && r.category, `${fam.id} ${sel.size}`);
      if (r.commodityCode) assert.ok(CODES.has(r.commodityCode), `${fam.id} ${sel.size} → ${r.commodityCode}`);
      else assert.ok([...CODES].some((c) => c.startsWith(r.choosePrefix)), `${fam.id} prefix ${r.choosePrefix}`);
    }
  }
  assert.ok(n > 10_000);
});

test("catalogue groups match the settings list", () => {
  assert.deepEqual([...CAT.groups].sort(), [...CATALOGUE_GROUPS].sort());
});

test("codes follow size, grade and finish", () => {
  const code = (f, s) => CAT.resolve(f, s).commodityCode;
  assert.equal(code("equal-angle", { size: "40×40×3" }), "7216210000");
  assert.equal(code("equal-angle", { size: "100×100×10" }), "7216401000");
  assert.equal(code("flat-bar", { size: "40×10" }), "7214911090");
  assert.equal(code("flat-bar", { size: "40×10", grade: "EN8 / 080M40" }), "7214919090");
  assert.equal(code("round-bar", { size: "25 mm" }), "7214993900");
  assert.equal(code("round-bar", { size: "100 mm" }), "7214993100");
  assert.equal(code("ub", { size: "203×133×25" }), "7216321100");
  assert.equal(code("ub", { size: "254×146×31" }), "7216329100");
  assert.equal(code("uc", { size: "152×152×23" }), "7216331000");
  assert.equal(code("uc", { size: "203×203×46" }), "7216339000");
  assert.equal(code("shs", { size: "40×40×2" }), "7306619200");
  assert.equal(code("shs", { size: "40×40×3" }), "7306619900");
  assert.equal(code("chs", { size: "48.3×3.2", finish: "Galvanised" }), "7306307280");
  assert.equal(code("plate", { size: "20 mm", sheet: "2500×1250" }), "7208512010");
  assert.equal(code("plate", { size: "12 mm", sheet: "6000×2500" }), "7208519110");
  assert.equal(code("plate", { size: "12 mm", sheet: "3000×1500" }), "7208519810");
  assert.equal(categoryOf(code("ub", { size: "203×133×25" })), "17");
  assert.equal(categoryOf(code("rhs", { size: "100×50×5" })), "21");
  assert.equal(CAT.resolve("rebar", { size: "12 mm" }).choosePrefix, "72142000");
});

test("the five pilot products match catalogue entries with the same code", () => {
  const seed = [["40×40×3 Angle", "7216210000", "equal-angle"], ["50×40×5 Angle", "7216210000", "unequal-angle"], ["40×10 Flat", "7214911090", "flat-bar"], ["100×50 Flat", "7214911090", "flat-bar"], ["25 mm Round", "7214993900", "round-bar"]];
  for (const [name, code, fam] of seed) assert.equal(CAT.match(name, code)?.family, fam, name);
});

test("search finds sizes typed loosely and respects allowed groups", () => {
  assert.equal(CAT.search("40x40x3 angle")[0].label, "40×40×3 Equal Angle");
  assert.equal(CAT.search("40 x 40 x 3")[0].size, "40×40×3");
  assert.ok(CAT.search("203 ub").every((h) => h.family === "ub"));
  assert.ok(CAT.search("box section").some((h) => h.family === "shs"));
  assert.ok(CAT.search("", { groups: ["Stainless"] }).every((h) => h.group === "Stainless"));
});

test("validateProduct keeps a catalogue pick only when one is sent", () => {
  const base = { name: "x", commodityCode: "7216210000", stockT: 1, monthlyUsageT: 1, costPerT: 1 };
  assert.equal("catalog" in validateProduct(base).product, false);
  assert.deepEqual(validateProduct({ ...base, catalog: { family: "equal-angle", values: { size: "40×40×3", grade: "S275JR", bad: { x: 1 } } } }).product.catalog,
    { family: "equal-angle", values: { size: "40×40×3", grade: "S275JR" } });
  assert.equal(validateProduct({ ...base, catalog: null }).product.catalog, null);
});

test("settings validate ranges and product groups", () => {
  const ok = validateSettings({ defaultLeadTimeWeeks: "6", defaultMoqT: "", catalogueGroups: ["Stainless", "Nope"] });
  assert.equal(ok.valid, true);
  assert.equal(ok.settings.defaultLeadTimeWeeks, 6);
  assert.equal(ok.settings.defaultMoqT, null);
  assert.deepEqual(ok.settings.catalogueGroups, ["Stainless"]);
  const bad = validateSettings({ defaultTargetCoverMonths: 0, catalogueGroups: [] });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.defaultTargetCoverMonths && bad.errors.catalogueGroups);
  assert.equal(validateSettings({}).settings.defaultTargetCoverMonths, SETTINGS_DEFAULTS.defaultTargetCoverMonths);
});
