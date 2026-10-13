import test from "node:test";
import assert from "node:assert/strict";
import { parseBenchmarkTable, parseDate, planImport, mergePoints, latest, competitionSeries, compareQuote, validateSeries, validatePoint, normKey } from "../lib/benchmarks.mjs";
import { parseFeedPayload, feedConfig } from "../lib/benchmark-feed.mjs";

test("dates in the formats exports use", () => {
  for (const [v, want] of [["2026-10-13", "2026-10-13"], ["13/10/2026", "2026-10-13"], ["13-Oct-2026", "2026-10-13"], ["13 October 2026", "2026-10-13"], ["Oct 2026", "2026-10-01"], ["2026-10", "2026-10-01"], [46308, "2026-10-13"]]) {
    assert.equal(parseDate(v), want, String(v));
  }
  assert.equal(parseDate("soon"), null);
});

test("wide export (Kallanish Price Analyser style) with a title line", () => {
  const t = "Kallanish Price Analyser\n\nDate\tMerchant bar UK delivered (GBP/t)\tRebar Turkey FOB (USD/t)\n01/09/2026\t760\t540\n01/10/2026\t748\t548";
  const r = parseBenchmarkTable(t);
  assert.equal(r.format, "wide");
  assert.equal(r.rows.length, 4);
  assert.deepEqual(r.rows[1], { date: "2026-09-01", series: "Rebar Turkey FOB (USD/t)", price: 540, currency: "USD" });
});

test("long CSV with quoted thousands, and low/high averaged", () => {
  const r = parseBenchmarkTable('date,series,price,currency\n2026-09-30,MEPS UK merchant bar,"1,020",GBP\nbad,x,1,GBP');
  assert.equal(r.rows[0].price, 1020);
  assert.equal(r.errors.length, 1);
  assert.equal(parseBenchmarkTable("Date,Low,High\n2026-10-01,700,720", { defaultSeries: "Trader A" }).rows[0].price, 710);
  assert.ok(parseBenchmarkTable("nothing").errors.length);
});

test("import plan matches saved series by alias; points merge by date", () => {
  const plan = planImport([{ date: "2026-10-01", series: "UK Bar", price: 750 }, { date: "2026-09-01", series: "UK bar", price: 760 }, { date: "2026-10-01", series: "New", price: 1 }], [{ id: "a", name: "UK merchant bar", keys: [normKey("uk bar")] }]);
  assert.equal(plan.length, 2);
  assert.deepEqual([plan[0].seriesId, plan[0].count, plan[0].from, plan[0].to, plan[0].latestPrice], ["a", 2, "2026-09-01", "2026-10-01", 750]);
  assert.equal(plan[1].seriesId, null);
  const merged = mergePoints([{ date: "2026-09-01", price: 1 }], [{ date: "2026-09-01", price: 2 }, { date: "2026-08-01", price: 3 }]);
  assert.deepEqual(merged.map((p) => p.price), [3, 2]);
  assert.equal(latest(merged, "2026-12-31").change, -1);
});

test("competition series from supplier quotes and quote vs benchmark", () => {
  const suppliers = [
    { id: "1", origin: "UK", supplies: ["Merchant Bar"], quotes: [{ date: "2026-09-01", pricePerT: 760, currency: "GBP" }, { date: "2026-10-01", pricePerT: 740, currency: "GBP" }] },
    { id: "2", origin: "UK", supplies: ["Merchant Bar"], quotes: [{ date: "2026-09-15", pricePerT: 780, currency: "GBP" }] },
    { id: "3", origin: "Spain", supplies: ["Merchant Bar"], quotes: [{ date: "2026-10-01", pricePerT: 700, currency: "EUR" }] },
  ];
  const [uk, imp] = competitionSeries(suppliers, "Merchant Bar", { GBP: 1, EUR: 0.85 });
  assert.deepEqual(uk.points.map((p) => [p.date, p.price, p.low]), [["2026-09-01", 760, 760], ["2026-09-15", 770, 760], ["2026-10-01", 760, 740]]);
  assert.equal(imp.points[0].price, 595);
  const cmp = compareQuote(755, [{ id: "m", name: "MEPS", currency: "EUR", points: [{ date: "2026-10-01", price: 900 }] }], { GBP: 1, EUR: 0.85 }, "2026-10-13");
  assert.deepEqual([cmp[0].benchmark, cmp[0].diff, cmp[0].pct, cmp[0].ageDays], [765, -10, -1.3, 12]);
});

test("series and point validation", () => {
  assert.ok(validateSeries({}).errors.name);
  assert.deepEqual(validateSeries({ name: "MEPS UK", source: "MEPS", group: "Merchant Bar" }).series.keys, ["meps uk"]);
  assert.ok(validatePoint({ date: "2030-01-01", price: 1 }, { asOf: "2026-10-13" }).errors.date);
  assert.equal(validatePoint({ date: "13/10/2026", price: "£742" }, { asOf: "2026-10-13" }).point.price, 742);
});

test("feed payloads: JSON array or CSV; config from env", () => {
  const j = parseFeedPayload(JSON.stringify({ data: [{ date: "2026-10-01", name: "UK bar", value: 750, currency: "GBP" }] }), "application/json");
  assert.deepEqual(j.rows[0], { date: "2026-10-01", series: "UK bar", price: 750, currency: "GBP" });
  assert.equal(parseFeedPayload("date,series,price\n2026-10-01,UK bar,750", "text/csv").rows[0].price, 750);
  const cfg = feedConfig({ MEPS_FEED_URL: "https://x", MEPS_FEED_TOKEN: "t" });
  assert.equal(cfg.MEPS.configured, true);
  assert.equal(cfg.Kallanish.configured, false);
});
