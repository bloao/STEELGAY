// Sample scenarios for demos and first-run. They are calculated against a
// fixed, clearly labelled sample market (not live GOV.UK data) so the tool can
// be shown offline. "Recalculate with latest data" on any of them switches it
// to live data.

import { calculate } from "./calc.mjs";

function isoDaysFrom(base, days) {
  return new Date(Date.parse(`${base}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function quarterStart(iso) {
  const [y, m] = iso.split("-").map(Number);
  const q = m >= 10 ? 10 : m >= 7 ? 7 : m >= 4 ? 4 : 1;
  return `${y}-${String(q).padStart(2, "0")}-01`;
}

function quarterEnd(start) {
  const [y, m] = start.split("-").map(Number);
  const end = new Date(Date.UTC(y, m - 1 + 3, 0));
  return end.toISOString().slice(0, 10);
}

export function sampleMarket(categories, asOf) {
  const start = quarterStart(asOf);
  const end = quarterEnd(start);
  const nextStart = isoDaysFrom(end, 1);
  const nextEnd = quarterEnd(nextStart);
  // Real order numbers from the July 2026 measure, with sample balances (tonnes).
  const row = (orderNumber, areas, categoryIds, initialT, balanceT, s = start, e = end) => {
    const category = categories.find((c) => c.id === categoryIds[0]);
    return {
      orderNumber, geographicalAreas: areas, headings: "", commodityCodes: category ? category.commodityPrefixes : [], categoryIds,
      measurementUnit: "Kilogram (kg)", description: "Sample quota balance", startDate: s, endDate: e,
      status: s === start ? "Open" : "Future", lastAllocationDate: "", initialVolume: initialT * 1000,
      balance: balanceT * 1000, fillRate: 1 - balanceT / initialT,
    };
  };
  const quotaRows = [
    // Cat 1 Residual (covers Turkey, China…): heavily used — likely to run out this quarter
    row("058603", ["Residual — all other origins"], ["1"], 12_441, 3_000),
    row("058603", ["Residual — all other origins"], ["1"], 12_441, 12_441, nextStart, nextEnd),
    // Cat 1 India: borderline
    row("058601", ["India"], ["1"], 8_364, 7_064),
    row("058601", ["India"], ["1"], 8_364, 8_364, nextStart, nextEnd),
    // Cat 4 EU: plenty of headroom
    row("058604", ["European Union"], ["4"], 127_568, 100_000),
    row("058604", ["European Union"], ["4"], 127_568, 127_568, nextStart, nextEnd),
    // Cat 4 South Korea: nearly gone
    row("058606", ["South Korea"], ["4"], 25_188, 2_000),
  ];
  const dutyByOrigin = {
    China: [{ measureTypeId: "552", measureType: "Definitive anti-dumping duty (sample)", label: "22.5%", ratePercent: 22.5, perTonneGbp: 0 }],
  };
  return {
    categories,
    tradeMeasureEffectiveFrom: "2026-07-01",
    quotaRows,
    fx: { rate: 0.79, source: "Sample FX", date: asOf },
    dutyFor(origin) {
      return [
        { measureTypeId: "103", measureType: "Third country duty (sample)", label: "0%", ratePercent: 0, perTonneGbp: 0 },
        { measureTypeId: "122", measureType: "Non preferential tariff quota (sample)", label: "0%", ratePercent: 0, perTonneGbp: 0, orderNumber: null },
        ...(dutyByOrigin[origin] || []),
      ];
    },
  };
}

export function sampleScenarios(asOf) {
  const d = (n) => isoDaysFrom(asOf, n);
  return [
    {
      status: "submitted",
      inputs: {
        title: "HR coil 2mm — Supplier A (Turkey, FOB)", commodityCode: "7208390090",
        commodityDescription: "Hot-rolled coil, < 3 mm", spec: "1250 × 2.0 mm, S275JR",
        origin: "Turkey", tonnage: 500, importDate: d(45), supplier: "Supplier A", mill: "Mill Y",
        incoterm: "FOB", priceAmount: 640, priceCurrency: "USD", freightToUkPerT: 38, insurancePerT: 3,
        inlandFreightPerT: 14, brokeragePerShipment: 180, paymentTerms: "60 days LC", financeRatePct: 7.5,
        financeDays: 60, leadTimeWeeks: 7, quoteValidUntil: d(4),
      },
      activity: [{ by: "sam", action: "submitted", detail: "Cheapest headline price — please review quota risk" }],
    },
    {
      status: "draft",
      inputs: {
        title: "HR coil 2mm — Trader B (Turkey, DDP)", commodityCode: "7208390090",
        commodityDescription: "Hot-rolled coil, < 3 mm", spec: "1250 × 2.0 mm, S275JR",
        origin: "Turkey", tonnage: 500, importDate: d(45), supplier: "Trader B", mill: "Mill Y",
        incoterm: "DDP", priceAmount: 712, priceCurrency: "GBP", paymentTerms: "30 days", leadTimeWeeks: 6,
        quoteValidUntil: d(10),
      },
    },
    {
      status: "draft",
      inputs: {
        title: "HR coil 2mm — Mill Z (India, CFR)", commodityCode: "7208390090",
        commodityDescription: "Hot-rolled coil, < 3 mm", spec: "1250 × 2.0 mm, S275JR",
        origin: "India", tonnage: 500, importDate: d(60), supplier: "Mill Z direct", mill: "Mill Z",
        incoterm: "CFR", priceAmount: 615, priceCurrency: "USD", insurancePerT: 3, inlandFreightPerT: 14,
        brokeragePerShipment: 180, paymentTerms: "90 days DA", financeRatePct: 7.5, financeDays: 90,
        leadTimeWeeks: 10, quoteValidUntil: d(14),
      },
    },
    {
      status: "approved",
      inputs: {
        title: "Galvanised sheet — EU mill (CIF)", commodityCode: "7210490090",
        commodityDescription: "Zinc-coated flat-rolled", spec: "1500 × 0.8 mm DX51D Z275",
        origin: "European Union", tonnage: 220, importDate: d(30), supplier: "EU Steel GmbH", mill: "EU Steel Duisburg",
        incoterm: "CIF", priceAmount: 860, priceCurrency: "EUR", inlandFreightPerT: 18, brokeragePerShipment: 120,
        paymentTerms: "30 days", leadTimeWeeks: 4, quoteValidUntil: d(7),
      },
      activity: [
        { by: "sam", action: "submitted", detail: "" },
        { by: "jo", action: "approved", detail: "OK — book before quota tightens" },
      ],
    },
    {
      status: "rejected",
      inputs: {
        title: "Galvanised sheet — Korea (CFR)", commodityCode: "7210490090",
        commodityDescription: "Zinc-coated flat-rolled", spec: "1500 × 0.8 mm DX51D Z275",
        origin: "South Korea", tonnage: 220, importDate: d(55), supplier: "KR Trading", mill: "",
        incoterm: "CFR", priceAmount: 790, priceCurrency: "USD", insurancePerT: 4, inlandFreightPerT: 18,
        brokeragePerShipment: 120, leadTimeWeeks: 9, quoteValidUntil: d(-3),
      },
      activity: [
        { by: "sam", action: "submitted", detail: "" },
        { by: "jo", action: "rejected", detail: "Korea line is nearly used up and no mill named" },
      ],
    },
    {
      status: "draft",
      inputs: {
        title: "HR coil — China (CFR, Q1 shipment)", commodityCode: "7208390090",
        commodityDescription: "Hot-rolled coil, < 3 mm", spec: "1500 × 3.0 mm",
        origin: "China", tonnage: 300, importDate: d(110), supplier: "CN Export Co", mill: "Mill Q",
        incoterm: "CFR", priceAmount: 560, priceCurrency: "USD", insurancePerT: 3, inlandFreightPerT: 14,
        brokeragePerShipment: 180, leadTimeWeeks: 12, quoteValidUntil: d(20),
        emissionsPerT: 2.3, ukCarbonPrice: null,
      },
    },
  ];
}

export function buildSampleRecords(categories, asOf) {
  const market = sampleMarket(categories, asOf);
  return sampleScenarios(asOf).map((s) => {
    const result = calculate(s.inputs, { ...market, dutyMeasures: market.dutyFor(s.inputs.origin) }, { asOf });
    if (!result.ok) throw new Error(`Sample scenario invalid: ${JSON.stringify(result.errors)}`);
    result.sources = {
      engineVersion: result.engineVersion,
      calculatedAt: new Date().toISOString(),
      sample: true,
      note: "Sample market data — not live. Use “Recalculate with latest data” to price against GOV.UK.",
    };
    return { status: s.status, inputs: result.inputs, result, demo: true, activity: s.activity || [] };
  });
}
