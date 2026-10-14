import { test } from "node:test";
import assert from "node:assert/strict";
import * as A from "../lib/arrivals.mjs";

test("AIS messages build a vessel and score steel likelihood", () => {
  const vs = {};
  const now = new Date("2026-10-14T10:00:00Z");
  A.applyMessage(vs, { MetaData: { MMSI: 255806001, latitude: 43.36, longitude: -3.05 }, Message: { ShipStaticData: { Name: "ESTRELA", Type: 70, Destination: "GB GOO@@", Eta: { Month: 10, Day: 18, Hour: 6, Minute: 0 }, MaximumStaticDraught: 6.8, Dimension: { A: 70, B: 20 } } } }, now);
  const v = A.applyMessage(vs, { MetaData: { MMSI: 255806001, latitude: 43.36, longitude: -3.05 }, Message: { PositionReport: { Sog: 0.1 } } }, now);
  assert.equal(v.destPort, "GOO");
  assert.equal(v.destination, "GB GOO");
  assert.equal(v.eta, "2026-10-18T06:00:00.000Z");
  assert.equal(v.steelPort.id, "BIO");
  assert.equal(A.steelLikelihood(v).level, "high");
  A.applyMessage(vs, { MetaData: { MMSI: 255806001, latitude: 45.1, longitude: -6.2 }, Message: { PositionReport: { Sog: 10 } } }, now);
  assert.equal(vs["255806001"].area, "At sea");
  assert.equal(A.applyMessage(vs, { MetaData: { MMSI: 12 } }), null);
  const tanker = A.applyMessage(vs, { MetaData: { MMSI: 235000004, latitude: 53.6, longitude: 0.1 }, Message: { ShipStaticData: { Type: 80, Destination: "IMMINGHAM" } } }, now);
  assert.equal(A.steelLikelihood(tanker).level, "none");
});

test("destinations match UK steel ports and ETAs roll into next year", () => {
  assert.equal(A.matchUkPort("HULL UK").id, "HUL");
  assert.equal(A.matchUkPort("GBIMM").id, "IMM");
  assert.equal(A.matchUkPort("FOR ORDERS"), null);
  const vs = {};
  const v = A.applyMessage(vs, { MetaData: { MMSI: 111111111, latitude: 53.6, longitude: 0.2 }, Message: { ShipStaticData: { Type: 70, Eta: { Month: 1, Day: 5, Hour: 8, Minute: 0 } } } }, new Date("2026-12-20T00:00:00Z"));
  assert.equal(v.eta.slice(0, 10), "2027-01-05");
  assert.ok(Math.abs(A.distanceNm(53.74, -0.29, 53.63, -0.19) - 7.3) < 1);
});

test("HMRC ports and routes for your codes", () => {
  const trade = { 202606: { 72149110: { t: 100, v: 1, o: {}, pt: { IMM: 70, DOV: 30 }, md: { 10: 70, 30: 30 }, pm: { "IMM|10": 70, "DOV|30": 30 } }, 72085120: { t: 999, pt: { TEE: 999 }, md: { 10: 999 } } } };
  const r = A.portsAndRoutes(trade, ["7214911090"]);
  assert.deepEqual(r.ports.map((p) => [p.port, p.total]), [["IMM", 70], ["DOV", 30]]);
  assert.equal(r.routes["Road / Ro-Ro"], 30);
  assert.equal(r.ports[1].routes["Road / Ro-Ro"], 30);
});
