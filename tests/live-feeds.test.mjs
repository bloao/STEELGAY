import test from "node:test";
import assert from "node:assert/strict";
import { parseOns, onsUrl, metalsPrice, parseMetalsLatest, parseMetalsTimeseries, changeSince, periodChanges, fetchOns, fetchMetals } from "../lib/live-feeds.mjs";
import { publicSettings, validateSettings } from "../lib/settings.mjs";

test("ONS JSON months → monthly points", () => {
  const pts = parseOns({ months: [{ date: "2026 JUL", value: "201.8" }, { date: "2026 AUG", value: "204.2" }, { date: "junk", value: "x" }] });
  assert.deepEqual(pts, [{ date: "2026-07-01", price: 201.8 }, { date: "2026-08-01", price: 204.2 }]);
  assert.equal(onsUrl("GHAV"), "https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/ghav/ppi/data");
});

test("Metals-API rates: inverse, direct and timeseries", () => {
  assert.equal(metalsPrice({ "STEEL-RE": 0.002 }, "STEEL-RE"), 500);
  assert.equal(metalsPrice({ "STEEL-RE": 540 }, "STEEL-RE"), 540);
  assert.equal(metalsPrice({ "USDSTEEL-RE": 545, "STEEL-RE": 0.0018 }, "STEEL-RE"), 545);
  assert.deepEqual(parseMetalsLatest({ success: true, date: "2026-10-13", rates: { "STEEL-RE": 540 } }, ["STEEL-RE", "STEEL-SC"]), [{ symbol: "STEEL-RE", date: "2026-10-13", price: 540 }]);
  assert.throws(() => parseMetalsLatest({ success: false, error: { info: "Invalid key" } }, ["STEEL-RE"]), /Invalid key/);
  const ts = parseMetalsTimeseries({ success: true, rates: { "2026-10-02": { "STEEL-RE": 530 }, "2026-10-01": { "STEEL-RE": 525 } } }, ["STEEL-RE"]);
  assert.deepEqual(ts.map((p) => p.date), ["2026-10-01", "2026-10-02"]);
});

test("changes over 1, 3 and 12 months", () => {
  const pts = [["2025-08-01", 190], ["2026-05-01", 200], ["2026-07-01", 202], ["2026-08-01", 204]].map(([date, price]) => ({ date, price }));
  const c = periodChanges(pts);
  assert.equal(c.m1.pct, 1);
  assert.equal(c.m3.pct, 2);
  assert.equal(c.m12.pct, 7.4);
  assert.equal(changeSince(pts, "2026-07-15").pct, 1);
});

test("fetchers use the right URLs and report problems clearly", async () => {
  const calls = [];
  const fake = (body, ok = true) => async (url) => { calls.push(url); return { ok, status: ok ? 200 : 500, json: async () => body }; };
  assert.equal((await fetchOns("GHAV", fake({ months: [{ date: "2026 AUG", value: "204.2" }] })))[0].price, 204.2);
  await assert.rejects(fetchOns("GHAV", fake({}, false)), /HTTP 500/);
  await assert.rejects(fetchMetals("", ["STEEL-RE"]), /Settings/);
  const got = await fetchMetals("KEY12345", ["STEEL-RE"], { since: "2026-10-01", fetchImpl: fake({ success: true, date: "2026-10-13", rates: { "STEEL-RE": 0.002 } }) });
  assert.equal(got[0].price, 500);
  assert.match(calls.at(-1), /\/latest\?access_key=KEY12345&base=USD&symbols=STEEL-RE/);
});

test("API key is never sent back to the browser", () => {
  const { settings } = validateSettings({ metalsApiKey: "abcd1234efgh5678" });
  assert.deepEqual([publicSettings(settings).metalsApiKey, publicSettings(settings).hasMetalsApiKey], ["••••5678", true]);
  assert.equal(validateSettings({ metalsApiKey: "••••5678" }, settings).settings.metalsApiKey, "abcd1234efgh5678");
  assert.ok(validateSettings({ metalsApiKey: "bad key!" }).errors.metalsApiKey);
});
