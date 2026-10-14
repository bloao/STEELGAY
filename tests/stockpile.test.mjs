import { test } from "node:test";
import assert from "node:assert/strict";
import * as S from "../lib/stockpile.mjs";
import { validateNote, notesFor, noteActive } from "../lib/news.mjs";

const trade = {};
for (let i = 0; i < 12; i++) {
  const p = `2026${String(i + 1).padStart(2, "0")}`.replace("202613", "202701");
  trade[p] = { 72149110: { t: 1000 + (i % 2) * 50, v: (1000 + (i % 2) * 50) * (640 + (i % 2 ? 40 : -40)) }, 72162100: { t: 300, v: 300 * 700 } };
}
const summary = [{ codes: ["72149110", "72162100"] }, { codes: ["72149110"] }, { codes: ["72149110"] }];
const products = [
  { id: "a", name: "40×10 Flat", commodityCode: "7214911090", monthlyUsageT: 16, stockT: 32, family: "flat-bar" },
  { id: "b", name: "Tee", commodityCode: "7216210000", monthlyUsageT: 1, stockT: 10, family: "tee" },
];

test("stockpile ranking blends versatility, buyers, demand, steadiness and turnover", () => {
  const rows = S.scoreProducts(products, { trade, summary });
  assert.deepEqual(rows.map((r) => r.id), ["a", "b"]);
  assert.equal(rows[0].parts.buyers.value, 3);
  assert.equal(rows[0].parts.versatility.value, 5);
  assert.ok(rows[0].volatilityPct > rows[1].volatilityPct); // flats' unit value swings, angles' doesn't
  assert.equal(rows[1].volatilityRank, 2);
  const manual = S.scoreProducts([{ ...products[1], versatility: 5 }], { trade, summary });
  assert.equal(manual[0].parts.versatility.why, "Set by your team");
});

test("market intel notes carry a scope and a £/t or % effect", () => {
  const n = validateNote({ title: "x", scope: "supplier", targetId: "s1", effectUnit: "perT", effectValue: "-15", effectiveFrom: "2026-11-01", horizonMonths: 3 }, { asOf: "2026-10-14" });
  assert.equal(n.valid, true);
  assert.equal(n.note.impact, "down");
  assert.equal(validateNote({ title: "x", scope: "product" }).valid, false);
  assert.equal(validateNote({ title: "x", effectUnit: "pct", effectValue: 90 }).valid, false);
  const notes = [{ ...n.note, status: "active" }, { ...validateNote({ title: "m", effectUnit: "pct", effectValue: 3 }, { asOf: "2026-10-14" }).note, date: "2026-10-14", status: "active" }];
  assert.equal(notesFor(notes, { supplierId: "s1", date: "2026-11-15" }).length, 2);
  assert.equal(notesFor(notes, { supplierId: "s2", date: "2026-11-15" }).length, 1);
  assert.equal(noteActive(notes[0], "2027-02-01"), false);
});
