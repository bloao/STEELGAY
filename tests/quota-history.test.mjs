import { test } from "node:test";
import assert from "node:assert/strict";
import { originFor, periodsByLine, analyseLine, quotaHistory } from "../lib/quota-history.mjs";
import { lineFor } from "../lib/steel-measure.mjs";

const row = (o) => ({ measurementUnit: "Kilogram (kg)", status: "Closed", lastAllocationDate: "#NA", categoryIds: ["12B"], ...o });

test("past safeguard origins map onto today's lines", () => {
  assert.equal(originFor(["Türkiye"], "12B"), "Turkey");
  assert.equal(originFor(["Germany"], "12B"), "European Union");
  assert.equal(originFor(["ERGA OMNES"], "12B"), "Residual");
  assert.equal(originFor(["China"], "12B"), "Residual"); // no line of its own now
  assert.equal(originFor(["India"], "1"), "India");
});

test("quarters are aggregated per line with fill, run-out day and pace", () => {
  const rows = [
    // Turkey 12B: ran out on day 31 in Q3 2025, 60% used in Q4 2025
    row({ orderNumber: "058050", geographicalAreas: ["Turkey"], startDate: "2025-07-01", endDate: "2025-09-30", status: "Exhausted", lastAllocationDate: "2025-07-31", initialVolume: 30000000, balance: 0 }),
    row({ orderNumber: "058050", geographicalAreas: ["Turkey"], startDate: "2025-10-01", endDate: "2025-12-31", initialVolume: 30000000, balance: 12000000 }),
    // residual: two old lines in the same quarter add up
    row({ orderNumber: "058051", geographicalAreas: ["China"], startDate: "2025-10-01", endDate: "2025-12-31", initialVolume: 1000000, balance: 0, status: "Exhausted", lastAllocationDate: "2025-11-15" }),
    row({ orderNumber: "058052", geographicalAreas: ["Other countries"], startDate: "2025-10-01", endDate: "2025-12-31", initialVolume: 3000000, balance: 1000000 }),
    // annual periods are skipped
    row({ orderNumber: "058053", geographicalAreas: ["Turkey"], startDate: "2024-01-01", endDate: "2024-12-31", initialVolume: 1, balance: 0 }),
  ];
  const by = periodsByLine(rows, "2026-10-15", { since: null });
  const tr = by.get("058623");
  assert.equal(tr.length, 2);
  assert.equal(tr[0].exhausted, true);
  assert.equal(tr[0].dayFull, 31);
  assert.ok(Math.abs(tr[0].perDayT - 30000 / 31) < 1);
  assert.equal(Math.round(tr[1].fillPct), 60);
  const res = by.get("058624");
  assert.equal(res[0].initialT, 4000);
  assert.equal(res[0].usedT, 3000);
  assert.equal(res[0].exhausted, false); // only one of the two ran out
});

test("outlook blends this quarter's pace with history and says when it fills", () => {
  const periods = [1, 2, 3, 4].map((i) => ({ startDate: `2025-0${i}-01`, endDate: `2025-0${i}-28`, length: 90, initialT: 9000, usedT: 9000, fillPct: 100, exhausted: true, dayFull: 30, perDayT: 300, regime: "safeguard", current: false }));
  const live = { found: true, startDate: "2026-10-01", endDate: "2026-12-31", initialT: 4600, usedT: 1500, balanceT: 3100, burnPerDayT: 100 };
  const a = analyseLine(lineFor("058623"), periods, live, "2026-10-15");
  assert.equal(a.exhaustedCount, 4);
  assert.equal(a.dayFullMedian, 30);
  assert.ok(a.outlook.paceT > 100 && a.outlook.paceT < 300); // blended
  assert.equal(a.outlook.lastsQuarter, false);
  assert.ok(a.outlook.fullOn > "2026-10-15" && a.outlook.fullOn < "2026-12-31");
  assert.ok(a.outlook.safeUntil < a.outlook.fullOn);
  const quiet = analyseLine(lineFor("058623"), [], { ...live, usedT: 50, balanceT: 4550, burnPerDayT: 50 / 15 }, "2026-10-15");
  assert.equal(quiet.outlook.lastsQuarter, true);
  assert.equal(quiet.outlook.verdict, "lasts");
});

test("quotaHistory returns all 72 lines", () => {
  const h = quotaHistory([], [], "2026-10-15");
  assert.equal(h.lines.length, 72);
  assert.equal(h.firstPeriod, null);
});

test("trade-agreement quotas on the same codes are ignored", () => {
  const rows = [
    { orderNumber: "058601", geographicalAreas: ["India"], categoryIds: ["1"], startDate: "2026-07-01", endDate: "2026-09-30", initialVolume: 8364000, balance: 1000000, measurementUnit: "Kilogram (kg)", status: "Closed" },
    { orderNumber: "054321", geographicalAreas: ["India"], categoryIds: ["1"], startDate: "2026-07-01", endDate: "2026-09-30", initialVolume: 238000000, balance: 238000000, measurementUnit: "Kilogram (kg)", status: "Open" },
  ];
  const p = periodsByLine(rows, "2026-10-15").get("058601");
  assert.equal(p.length, 1);
  assert.equal(p[0].initialT, 8364);
});

test("history only covers the current measure, from 1 July 2026", () => {
  const rows = [
    { orderNumber: "058050", geographicalAreas: ["Turkey"], categoryIds: ["12B"], startDate: "2026-04-01", endDate: "2026-06-30", initialVolume: 30000000, balance: 0, measurementUnit: "Kilogram (kg)", status: "Exhausted", lastAllocationDate: "2026-05-01" },
    { orderNumber: "058623", geographicalAreas: ["Turkey"], categoryIds: ["12B"], startDate: "2026-07-01", endDate: "2026-09-30", initialVolume: 4663000, balance: 500000, measurementUnit: "Kilogram (kg)", status: "Closed", lastAllocationDate: "#NA" },
  ];
  const h = quotaHistory(rows, [], "2026-10-15");
  assert.equal(h.since, "2026-07-01");
  const tr = h.lines.find((l) => l.orderNumber === "058623");
  assert.equal(tr.quarters, 1);
  assert.equal(tr.history[0].regime, "measure");
});
