// UK steel trade measure from 1 July 2026 — the parts that do not change
// day to day. Source: GOV.UK "UK's steel trade measure from 1 July 2026"
// (Tables 3 and 4; page last updated 1 October 2026).
// Live opening volumes and balances come from HMRC's Trade Tariff API.

export const MEASURE = {
  name: "UK steel trade measure",
  effectiveFrom: "2026-07-01",
  outOfQuotaRate: 0.5,
  sourceUrl: "https://www.gov.uk/government/publications/uks-steel-trade-measure-from-1-july-2026/uks-steel-trade-measure-from-1-july-2026",
  guidanceUpdated: "2026-10-01",
};

// Origins excluded from the measure entirely.
export const EXCLUDED_ORIGINS = ["Ukraine"];

// Commodity codes taken out of scope after launch.
export const SCOPE_REMOVALS = [
  { prefixes: ["72173049", "72173090"], from: "2026-10-01", note: "Removed from Category 28 on 1 October 2026 (now 0%)." },
];

// Table 4 order numbers with Table 3 annual volumes (tonnes).
// [orderNumber, category, origin, annualTonnes]
const TABLE = [
  ["058600", "1", "European Union", 375000], ["058601", "1", "India", 33456], ["058602", "1", "South Korea", 8785], ["058603", "1", "Residual", 49763],
  ["058604", "4", "European Union", 510273], ["058605", "4", "India", 125796], ["058606", "4", "South Korea", 100753], ["058607", "4", "Vietnam", 174367], ["058608", "4", "Residual", 100116],
  ["058609", "5", "European Union", 49836], ["058610", "5", "South Korea", 19694], ["058611", "5", "Residual", 5993],
  ["058612", "6", "European Union", 39795], ["058613", "6", "Japan", 315], ["058614", "6", "South Korea", 2534], ["058615", "6", "Residual", 27151],
  ["058616", "7", "European Union", 200868], ["058617", "7", "South Korea", 33795], ["058618", "7", "United States", 766], ["058619", "7", "Residual", 14415],
  ["058620", "12A", "European Union", 83558], ["058621", "12A", "Residual", 22342],
  ["058622", "12B", "European Union", 47618], ["058623", "12B", "Turkey", 18654], ["058624", "12B", "Residual", 4540],
  ["058625", "13", "European Union", 149024], ["058626", "13", "Turkey", 50582], ["058627", "13", "Residual", 68374],
  ["058628", "14", "European Union", 16543], ["058629", "14", "United States", 1782], ["058630", "14", "Residual", 2360],
  ["058631", "15", "European Union", 955], ["058632", "15", "South Korea", 135], ["058633", "15", "Residual", 237],
  ["058634", "16", "European Union", 168471], ["058635", "16", "Residual", 10504],
  ["058636", "17", "European Union", 253678], ["058637", "17", "South Korea", 3002], ["058638", "17", "United States", 852], ["058639", "17", "Residual", 13230],
  ["058640", "19", "European Union", 7436], ["058641", "19", "Residual", 46],
  ["058642", "20", "European Union", 17896], ["058643", "20", "India", 8777], ["058644", "20", "Turkey", 29917], ["058645", "20", "Residual", 5008],
  ["058646", "21", "European Union", 35236], ["058647", "21", "Turkey", 99399], ["058648", "21", "Residual", 11498],
  ["058649", "25A", "European Union", 7067], ["058650", "25A", "Japan", 413], ["058651", "25A", "South Korea", 659], ["058652", "25A", "United States", 495], ["058653", "25A", "Residual", 1538],
  ["058654", "25B", "European Union", 25219], ["058655", "25B", "Japan", 267], ["058656", "25B", "South Korea", 3493], ["058657", "25B", "Turkey", 5110], ["058658", "25B", "Residual", 3202],
  ["058659", "26", "European Union", 30026], ["058660", "26", "Switzerland", 1092], ["058661", "26", "Turkey", 14517], ["058662", "26", "United Arab Emirates", 10944], ["058663", "26", "United States", 3649], ["058664", "26", "Residual", 16327],
  ["058665", "27", "European Union", 19808], ["058666", "27", "Turkey", 5371], ["058667", "27", "Residual", 4351],
  ["058668", "28", "European Union", 43157], ["058669", "28", "Japan", 378], ["058670", "28", "United States", 6076], ["058671", "28", "Residual", 10123],
];

export const ORDER_LINES = TABLE.map(([orderNumber, categoryId, origin, annualTonnes]) => ({
  orderNumber,
  categoryId,
  origin,
  annualTonnes,
  residual: origin === "Residual",
}));

const byOrder = new Map(ORDER_LINES.map((l) => [l.orderNumber, l]));
export const isMeasureOrderNumber = (n) => byOrder.has(String(n));
export const lineFor = (n) => byOrder.get(String(n)) || null;

// Named origins for a category — the Residual line covers everyone else.
export function namedOriginsFor(categoryId) {
  return ORDER_LINES.filter((l) => l.categoryId === categoryId && !l.residual).map((l) => l.origin);
}

export function isRemovedFromScope(commodityCode, date) {
  return SCOPE_REMOVALS.some((r) => date >= r.from && r.prefixes.some((p) => commodityCode.startsWith(p)));
}

export function quarterFor(isoDate) {
  const [y, m] = isoDate.split("-").map(Number);
  if (m >= 7 && m <= 9) return { label: `Q1 ${y}/${String(y + 1).slice(2)}`, startDate: `${y}-07-01`, endDate: `${y}-09-30` };
  if (m >= 10) return { label: `Q2 ${y}/${String(y + 1).slice(2)}`, startDate: `${y}-10-01`, endDate: `${y}-12-31` };
  if (m <= 3) return { label: `Q3 ${y - 1}/${String(y).slice(2)}`, startDate: `${y}-01-01`, endDate: `${y}-03-31` };
  return { label: `Q4 ${y - 1}/${String(y).slice(2)}`, startDate: `${y}-04-01`, endDate: `${y}-06-30` };
}
