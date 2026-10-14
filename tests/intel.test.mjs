import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAtom, mergeNews, validateNote, REGULATION } from "../lib/news.mjs";
import * as F from "../lib/forecast.mjs";

const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>a</id><updated>2026-10-01T10:00:00+01:00</updated><link rel="alternate" type="text/html" href="https://www.gov.uk/x"/><title>Steel quota volumes &amp; balances</title><summary type="html">&lt;p&gt;HMRC update&lt;/p&gt;</summary></entry>
<entry><id>b</id><updated>2026-10-02T10:00:00+01:00</updated><link rel="alternate" href="https://www.gov.uk/y"/><title>New flood defences</title><summary>Flood scheme</summary></entry>
<entry><id>c</id><updated>2026-10-03T10:00:00+01:00</updated><link rel="alternate" href="https://www.gov.uk/z"/><title>UK CBAM rate published</title><summary>Carbon border adjustment mechanism</summary></entry></feed>`;

test("GOV.UK atom parses, filters to steel/trade/carbon and tags topics", () => {
  const items = parseAtom(atom, { id: "t", label: "GOV.UK" });
  assert.equal(items.length, 3);
  assert.equal(items[0].title, "Steel quota volumes & balances");
  assert.equal(items[0].summary, "HMRC update");
  const merged = mergeNews([items, items]);
  assert.deepEqual(merged.map((x) => x.topic), ["Carbon", "Tariffs & quotas"]);
});

test("insight notes validate", () => {
  const ok = validateNote({ title: "Mill +£20/t", impact: "up", strength: "2", horizonMonths: "3" }, { asOf: "2026-10-14" });
  assert.equal(ok.valid, true);
  assert.equal(ok.note.strength, 2);
  assert.equal(validateNote({ title: "" }).valid, false);
  assert.equal(validateNote({ title: "x", date: "2027-01-01" }, { asOf: "2026-10-14" }).valid, false);
  assert.ok(REGULATION.every((r) => r.source.url.startsWith("https://")));
});

const series = (n, start = 100, step = 0.5) => Array.from({ length: n }, (_, i) => ({ date: F.addMonths("2024-01-01", i), price: start + i * step }));

test("forecast follows a steady trend and widens its range with time", () => {
  const p = F.project(F.monthly(series(30)), { horizon: 6 });
  assert.ok(p.trendPerMonthPct > 0.3 && p.trendPerMonthPct < 0.5);
  assert.ok(p.path[5].mid > p.path[0].mid && p.path[0].mid > p.last);
  // flat history → flat forecast
  const flat = F.project(F.monthly(series(30, 100, 0)), { horizon: 3 });
  assert.ok(Math.abs(flat.path[2].mid - 100) < 1e-9);
  assert.equal(F.project(F.monthly(series(6)), {}), null);
});

test("drivers ramp in from their start month", () => {
  const d = [{ pct: 3, from: "2027-01-01", rampMonths: 3 }];
  assert.equal(F.driverPctAt(d, "2026-12-01"), 0);
  assert.equal(F.driverPctAt(d, "2027-01-01"), 1);
  assert.equal(F.driverPctAt(d, "2027-06-01"), 3);
  const c = F.cbamDriver({ ratePerT: 62, emissionsPerT: 2, referencePrice: 800, passThroughPct: 30 });
  assert.ok(Math.abs(c.pct - 4.65) < 1e-9);
  const notes = F.noteDrivers([{ id: "1", title: "x", impact: "down", strength: 3, horizonMonths: 3, date: "2026-10-01" }, { id: "2", title: "old", impact: "up", strength: 1, horizonMonths: 1, date: "2026-01-01" }], "2026-10-14");
  assert.deepEqual(notes.map((n) => n.pct), [-5]);
});

test("backtest scores past forecasts and buy-ahead nets out holding costs", () => {
  const s = F.monthly(series(36));
  const b = F.backtest(s, { h: 3, origins: 12 });
  assert.equal(b.rows.length, 12);
  assert.ok(b.mapePct < b.naiveMapePct); // a steady trend beats "no change"
  const path = [{ date: "x", mid: 101, low: 100.5, high: 101.5 }, { date: "y", mid: 102, low: 101, high: 103 }];
  const ba = F.buyAhead({ priceNow: 800, indexNow: 100, path, monthlyUsageT: 10, months: 2, costOfCapitalPct: 0, storagePerTMonth: 0 });
  assert.equal(Math.round(ba.netMid), (808 - 800) * 10 + (816 - 800) * 10);
  assert.equal(ba.signal, "buy-ahead");
  const costly = F.buyAhead({ priceNow: 800, indexNow: 100, path, monthlyUsageT: 10, months: 2, costOfCapitalPct: 8, storagePerTMonth: 20 });
  assert.equal(costly.signal, "buy-as-needed");
});
