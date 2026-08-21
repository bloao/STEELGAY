import { readFile, writeFile } from "node:fs/promises";

const sourceUrl =
  "https://data.api.trade.gov.uk/v1/datasets/uk-trade-quotas/versions/latest/reports/quotas-including-current-volumes/data?format=csv&download";

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === '"' && inQuotes && next === '"') {
      field += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }

      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }

  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function toNumber(value) {
  if (!value || value === "#NA") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(value) {
  if (!value || value === "#NA") {
    return "";
  }

  return value.replace(/\|/g, " ").replace(/\s+/g, " ").trim();
}

function findCategoryIds(commodityCodes, categories) {
  return categories
    .filter((category) =>
      commodityCodes.some((code) =>
        category.commodityPrefixes.some((prefix) => code.startsWith(prefix))
      )
    )
    .map((category) => category.id);
}

global.window = {};
await import("../steel-trade-measure.js");

const response = await fetch(sourceUrl, {
  headers: {
    accept: "text/csv",
    "user-agent": "steel-arb-prototype/0.1",
  },
});

if (!response.ok) {
  throw new Error(`${response.status} ${response.statusText}: ${sourceUrl}`);
}

const csv = await response.text();
await writeFile("uk-trade-quotas-latest.csv", csv);

const [headers, ...records] = parseCsv(csv);
const tradeMeasure = window.STEEL_TRADE_MEASURE;
const rows = records
  .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ""])))
  .map((row) => {
    const commodityCodes = row.quota__commodities
      .split("|")
      .map((code) => code.trim())
      .filter(Boolean);
    const categoryIds = findCategoryIds(commodityCodes, tradeMeasure.categories);

    return {
      orderNumber: row.quota__order_number,
      geographicalAreas: row.quota__geographical_areas
        .split("|")
        .map(cleanText)
        .filter(Boolean),
      headings: cleanText(row.quota__headings),
      commodityCodes,
      measurementUnit: cleanText(row.quota__measurement_unit),
      description: cleanText(row.quota_definition__description),
      startDate: row.quota_definition__validity_start_date,
      endDate: row.quota_definition__validity_end_date,
      status: cleanText(row.quota_definition__status),
      lastAllocationDate: row.quota_definition__last_allocation_date === "#NA"
        ? ""
        : row.quota_definition__last_allocation_date,
      initialVolume: toNumber(row.quota_definition__initial_volume),
      balance: toNumber(row.quota_definition__balance),
      fillRate: toNumber(row.quota_definition__fill_rate),
      categoryIds,
    };
  })
  .filter((row) => row.categoryIds.length > 0)
  .sort((a, b) => {
    const dateOrder = a.startDate.localeCompare(b.startDate);
    return dateOrder || a.orderNumber.localeCompare(b.orderNumber);
  });

const payload = {
  source: "UK Trade Quotas API",
  sourceUrl,
  generatedAt: new Date().toISOString(),
  count: rows.length,
  rows,
};

await writeFile(
  "steel-quotas.js",
  `window.STEEL_QUOTAS = ${JSON.stringify(payload, null, 2)};\n`
);

console.log(`Wrote ${rows.length} steel quota records.`);
