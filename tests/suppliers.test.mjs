import test from "node:test";
import assert from "node:assert/strict";
import { seedSuppliers, sheetUpdates, SHEET_VERSION, validateSupplier, validateContact, validateQuote, validateRfq, supplierMetrics, quotaLineFor } from "../lib/suppliers.mjs";
import { ORDER_LINES } from "../lib/steel-measure.mjs";

test("seed holds the supplier list as given", () => {
  const seed = seedSuppliers("2026-10-13T09:00:00.000Z");
  const by = Object.fromEntries(seed.map((s) => [s.name, s]));
  const row = (n) => { const s = by[n]; return [s.origin, s.priceCovers, s.onTimePct, s.moqMinT, s.moqMaxT, s.ddp, s.paymentDays, s.currency, s.quotes[0].pricePerT]; };
  assert.deepEqual(row("Tata Steel UK"), ["UK", "everything", 70, 23, 23, "na", 30, "GBP", 728]);
  assert.deepEqual(row("7 Steel"), ["UK", "everything", 80, 25, 28, "na", 60, "GBP", 755]);
  assert.deepEqual(row("LME"), ["France", "except-duty", 80, 25, 28, "no", 60, "GBP", 755]);
  assert.deepEqual(row("Megasa"), ["Spain", "everything", 80, 25, 28, "yes", 60, "GBP", 755]);
  assert.deepEqual(row("Olifer"), ["Italy", "except-duty", 70, 25, 28, "no", 60, "GBP", 800]);
  assert.deepEqual(by["Tata Steel UK"].pricingSources, ["Competition – UK", "Competition – imports", "MEPS", "Kallanish"]);
  assert.ok(by["7 Steel"].pricingSources.includes("Market intel"));
  assert.equal(by["7 Steel"].paymentNote, "Maybe going to 30 days");
  for (const s of seed) assert.equal(s.activity[0].action, "created");
});

test("supplier validation", () => {
  assert.equal(validateSupplier({}).errors.name, "Enter the supplier name.");
  const v = validateSupplier({ name: "X", origin: "Narnia", onTimePct: "120%", moqMinT: 28, moqMaxT: 25, website: "acme.co.uk" });
  assert.ok(v.errors.origin && v.errors.onTimePct && v.errors.moqMaxT);
  assert.equal(v.supplier.website, "https://acme.co.uk");
  assert.equal(validateSupplier({ name: "X", pricingSources: ["MEPS", "Nope"] }).supplier.pricingSources.join(), "MEPS");
});

test("contact, quote and RFQ validation", () => {
  assert.ok(validateContact({ name: "A" }).errors.email);
  assert.ok(validateContact({ name: "A", email: "nope" }).errors.email);
  assert.equal(validateContact({ name: "A", email: "A@B.COM" }).contact.email, "a@b.com");
  assert.ok(validateQuote({}).errors.pricePerT);
  assert.ok(validateQuote({ pricePerT: 700, date: "2030-01-01" }, { asOf: "2026-10-13" }).errors.date);
  assert.ok(validateQuote({ pricePerT: 700, date: "2026-10-10", validUntil: "2026-10-01" }, { asOf: "2026-10-13" }).errors.validUntil);
  assert.equal(validateQuote({ pricePerT: "£742.50" }, { asOf: "2026-10-13" }).quote.pricePerT, 742.5);
  assert.ok(validateRfq({ lines: [] }).errors.lines);
  assert.equal(validateRfq({ lines: [{ name: "40×10 Flat", tonnage: "16" }] }).rfq.lines[0].tonnage, 16);
});

test("metrics: latest quote, duty exposure, awaiting reply", () => {
  const s = {
    origin: "Italy", priceCovers: "except-duty",
    quotes: [{ date: "2026-09-01", pricePerT: 800, currency: "GBP" }, { date: "2026-10-01", pricePerT: 780, currency: "GBP", validUntil: "2026-10-08" }],
    rfqs: [{ status: "open", at: "2026-10-10T10:00:00Z", lines: [{ name: "a" }] }],
    contacts: [{ name: "B" }, { name: "P", primary: true }],
  };
  const m = supplierMetrics(s, "2026-10-13");
  assert.equal(m.pricePerT, 780);
  assert.equal(m.priceAgeDays, 12);
  assert.equal(m.priceExpired, true);
  assert.equal(m.worstCasePerT, 1170);
  assert.equal(m.awaitingQuote.days, 3);
  assert.equal(m.primaryContact.name, "P");
  assert.equal(supplierMetrics({ ...s, origin: "UK" }, "2026-10-13").dutyExposed, false);
  assert.equal(supplierMetrics({ ...s, priceCovers: "everything", quotes: [{ date: "2026-10-01", pricePerT: 755, covers: "everything" }] }, "2026-10-13").worstCasePerT, 755);
});

test("origins map to the right quota line", () => {
  const lines = ORDER_LINES.map((l) => ({ ...l }));
  assert.equal(quotaLineFor("UK", "12B", lines).kind, "domestic");
  assert.equal(quotaLineFor("Ukraine", "12B", lines).kind, "excluded");
  assert.equal(quotaLineFor("Spain", "12B", lines).line.orderNumber, "058622");
  assert.equal(quotaLineFor("Turkey", "12B", lines).line.orderNumber, "058623");
  assert.equal(quotaLineFor("China", "12B", lines).line.orderNumber, "058624");
});

test("supplier sheet: every column from the Supplier Options sheet is held", () => {
  const by = Object.fromEntries(seedSuppliers().map((s) => [s.name, s]));
  const sheet = {
    "7 Steel": ["Delivered to depot", 755, "included", "Not applicable", "Not applicable", "Zero", 2, 3, "days"],
    LME: ["DAP", 755, "included", "Up to 50%", "0%", "Medium to high depending on where we are in the quarter, load by load.", 2, 3, "weeks"],
    Olifer: ["DAP", 800, "included", "Up to 50%", "0%", "Medium to high depending on where we are in the quarter, load by load.", 2, 3, "weeks"],
    Megasa: ["DDP", 755, "included", "Not applicable", "Not applicable", "Low — but risk of non-delivery if quota critical or exceeded.", 2, 3, "weeks"],
    Venete: ["DAP", 770, "included", "Up to 50%", "0%", "Shipment via vessel, usually plan for start of quarter. Medium risk.", 5, 6, "weeks"],
  };
  for (const [name, row] of Object.entries(sheet)) {
    const s = by[name];
    assert.deepEqual([s.deliveryTerms, s.quotes[0].pricePerT, s.transport, s.dutyCosts, s.otherDuty, s.dutyRiskNote, s.leadTimeMin, s.leadTimeMax, s.leadTimeUnit], row, name);
    assert.deepEqual([s.supplies, s.moqMinT, s.moqMaxT, s.moqNote], [["Merchant Bar"], 25, 28, "25–28 t load"], name);
  }
});

test("sheet update fills gaps in older files but never overwrites edits", () => {
  const old = { name: "LME", dutyRiskNote: "Duty up to 50%. Medium to high depending on quarter position, load by load.", moqNote: "", transport: "included", supplies: ["Merchant Bar"], moqMinT: 25, moqMaxT: 28, deliveryTerms: "DAP", leadTimeMin: 2, leadTimeMax: 3, leadTimeUnit: "weeks" };
  const fields = sheetUpdates(old).map((c) => c.field).sort();
  assert.deepEqual(fields, ["dutyCosts", "dutyRiskNote", "moqNote", "otherDuty"]);
  assert.deepEqual(sheetUpdates({ ...old, dutyRiskNote: "My own note" }).map((c) => c.field).includes("dutyRiskNote"), false);
  assert.deepEqual(sheetUpdates({ ...old, sheetVersion: SHEET_VERSION }), []);
  assert.deepEqual(sheetUpdates({ name: "Someone else" }), []);
});
