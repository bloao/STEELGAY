import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import * as C from "../lib/competition.mjs";

test("names and ids match the Python pipeline", () => {
  assert.equal(C.normalizeName("Murray Plate Group Limited"), "MURRAY PLATE GROUP LTD");
  assert.equal(C.companyId("MURRAY PLATE GROUP LTD", "M337RR"), "129df7bb5cf9");
  assert.equal(C.matchKey("Barrett Steel Limited"), "BARRETT");
});

test("zip entries, bulk links and importer rows parse", () => {
  const data = Buffer.from("202607\tx\tBARRETT STEEL LIMITED\t1 Road\t\t\tBRADFORD\t\tBD4 6AH\t72149110\t39269097\t72162100\n202607\tx\tNOT STEEL LTD\ta\t\t\t\t\tAB1 1AA\t39269097\n");
  const comp = deflateRawSync(data), nm = Buffer.from("importers2607.txt");
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(8, 8); local.writeUInt32LE(comp.length, 18); local.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(comp.length, 20); cd.writeUInt16LE(nm.length, 28);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(30 + nm.length + comp.length, 16);
  const [entry] = C.readZip(Buffer.concat([local, nm, comp, cd, nm, eocd]));
  const rows = C.parseImporters(entry.data.toString("latin1"));
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].codes, ["72149110", "72162100"]);
  assert.equal(rows[0].town, "BRADFORD");
  const links = C.findBulkLinks('<a href="/media/abc/importers2607.zip">x</a><a href="https://www.uktradeinfo.com/media/d/BDSimp2606.zip">y</a>');
  assert.equal(links.importers["202607"], "https://www.uktradeinfo.com/media/abc/importers2607.zip");
  assert.ok(links.imports["202606"]);
});

test("import volumes aggregate and flag unusual months", () => {
  const line = (p, code, o, t, v) => `${p}1${p}${code}67600001${o}001LON001${o}10${String(v).padStart(12, "0")}${String(t * 1000).padStart(12, "0")}${"0".padStart(12, "0")}0IMP1`;
  const agg = C.parseImports([line("202601", "72149110", "ES", 100, 64000), line("202601", "72149110", "TR", 50, 30000), line("202601", "39269097", "CN", 9, 9)].join("\n"));
  assert.deepEqual(Object.keys(agg["202601"]), ["72149110"]);
  assert.equal(agg["202601"]["72149110"].t, 150);
  const trade = {};
  for (let i = 1; i <= 14; i++) trade[`2025${String(i).padStart(2, "0")}`.replace(/20251(\d)$/, (m, d) => `20260${Number(d) - 2 + 1}`)] = { 72149110: { t: i === 14 ? 200 : 100, v: 1, o: {} } };
  const rows = C.marketVolume(trade, ["7214911090"]);
  assert.ok(rows[rows.length - 1].vsAvgPct > 90);
});

test("competitor patterns and accounts", () => {
  const months = Array.from({ length: 15 }, (_, i) => `2025${String(i + 1).padStart(2, "0")}`);
  const m = {}; months.forEach((p, i) => { if (i % 3 === 0 || i >= 12) m[p] = ["72149110"]; });
  const a = C.analyseCompany({ m }, { months, yourCodes: ["7214911090"] });
  assert.equal(a.signal, "stepping-up");
  assert.equal(a.overlapCodes.length, 1);
  const quiet = C.analyseCompany({ m: Object.fromEntries(months.slice(0, 11).map((p) => [p, ["72162100"]])) }, { months, yourCodes: [] });
  assert.equal(quiet.signal, "quiet");
  const acc = C.parseAccountsIxbrl(`<xbrli:context id="a"><xbrli:period><xbrli:instant>2025-12-31</xbrli:instant></xbrli:period></xbrli:context><xbrli:context id="b"><xbrli:period><xbrli:instant>2024-12-31</xbrli:instant></xbrli:period></xbrli:context><xbrli:context id="s"><xbrli:segment><xbrldi:explicitMember>x</xbrldi:explicitMember></xbrli:segment><xbrli:period><xbrli:instant>2025-12-31</xbrli:instant></xbrli:period></xbrli:context>
    <ix:nonFraction name="core:Inventories" contextRef="a" scale="3">48,200</ix:nonFraction><ix:nonFraction name="core:Inventories" contextRef="b" scale="3">34,100</ix:nonFraction><ix:nonFraction name="core:Inventories" contextRef="s" scale="3">999,999</ix:nonFraction>`);
  assert.deepEqual(acc.stock, [{ date: "2025-12-31", value: 48200000 }, { date: "2024-12-31", value: 34100000 }]);
});
