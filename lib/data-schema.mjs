// Catalogue of every data point pulled from outside sources: the source
// field, what the platform calls it, its type and unit, and the pages and
// calculations it feeds. Keys match the feed registry in server.mjs.

export const PAGES = {
  assistant: { label: "Assistant", href: "assistant.html", section: "Assistant" },
  orders: { label: "Orders", href: "orders.html", section: "Orders" },
  plan: { label: "Plan an order", href: "plan.html", section: "Orders" },
  assumptions: { label: "Assumptions", href: "assumptions.html", section: "Orders" },
  quotas: { label: "Live quotas", href: "quotas.html", section: "Orders" },
  quota: { label: "Quota profile", href: "quotas.html", section: "Orders" },
  arrivals: { label: "Arrivals", href: "arrivals.html", section: "Orders" },
  products: { label: "Products", href: "products.html", section: "Products" },
  suppliers: { label: "Suppliers", href: "suppliers.html", section: "Suppliers" },
  market: { label: "Market prices", href: "suppliers.html#market", section: "Suppliers" },
  forecast: { label: "Steel forecast", href: "forecast.html", section: "Market" },
  news: { label: "News & regulation", href: "news.html", section: "Market" },
  competition: { label: "Competition", href: "competition.html", section: "Market" },
};

// Calculations the data feeds (shown alongside pages)
export const ENGINES = {
  landed: "Landed cost",
  quotaRisk: "Quota risk",
  fillOutlook: "Fill outlook",
  forecast: "Price forecast",
  planner: "Order planner",
  fx: "Currency conversion",
};

const f = (key, label, type, usedIn, extra = {}) => ({ key, label, type, usedIn, ...extra });

export const SCHEMA = {
  "hmrc-quotas": {
    format: "JSON:API", endpoint: "GET /uk/api/quotas/search?order_number=…", grain: "One row per quota line per quarter",
    fields: [
      f("quota_order_number_id", "Order number", "string", ["quotas", "quota", "orders", "plan", "assistant"], { sample: "orderNumber" }),
      f("validity_start_date", "Quarter start", "date", ["quotas", "quota"], { sample: "startDate" }),
      f("validity_end_date", "Quarter end", "date", ["quotas", "quota"], { sample: "endDate" }),
      f("initial_volume", "Opening balance", "number", ["quotas", "quota", "plan"], { unit: "t", sample: "initialT", engines: ["quotaRisk", "fillOutlook"] }),
      f("balance", "Balance left", "number", ["quotas", "quota", "orders", "plan", "assistant"], { unit: "t", sample: "balanceT", engines: ["quotaRisk", "fillOutlook", "planner"] }),
      f("measurement_unit", "Unit", "string", ["quotas"], { sample: "unit" }),
      f("status", "Status", "enum", ["quotas", "quota"], { sample: "status" }),
      f("last_allocation_date", "Last allocation", "date", ["quotas", "quota"], { sample: "lastAllocationDate", engines: ["fillOutlook"] }),
      f("— derived", "Used / burn per day / run-out date", "number", ["quotas", "quota", "orders", "plan", "assistant"], { unit: "t · t/d · date", derived: true, sample: "burnPerDayT", engines: ["quotaRisk", "planner"] }),
    ],
  },
  "dbt-quotas": {
    format: "CSV", endpoint: "GET /v1/datasets/uk-trade-quotas/…/data?format=csv", grain: "One row per quota definition (quarter)",
    fields: [
      f("quota__order_number", "Order number", "string", ["quotas", "quota"], { sample: "orderNumber" }),
      f("quota__geographical_areas", "Origin", "string[]", ["quotas", "quota", "plan"], { sample: "geographicalAreas" }),
      f("quota__headings", "Headings", "string", ["quotas"], { sample: "headings" }),
      f("quota__commodities", "Commodity codes", "string[]", ["quotas", "products", "plan"], { sample: "commodityCodes", engines: ["quotaRisk"] }),
      f("quota__measurement_unit", "Unit", "string", ["quotas"], { sample: "measurementUnit" }),
      f("quota_definition__description", "Description", "string", ["quota"], { sample: "description" }),
      f("quota_definition__validity_start_date", "Quarter start", "date", ["quotas", "quota"], { sample: "startDate" }),
      f("quota_definition__validity_end_date", "Quarter end", "date", ["quotas", "quota"], { sample: "endDate" }),
      f("quota_definition__status", "Status", "enum", ["quota"], { sample: "status" }),
      f("quota_definition__last_allocation_date", "Last allocation", "date", ["quota"], { sample: "lastAllocationDate", engines: ["fillOutlook"] }),
      f("quota_definition__initial_volume", "Opening balance", "number", ["quotas", "quota"], { unit: "t", sample: "initialVolume", engines: ["fillOutlook"] }),
      f("quota_definition__balance", "Balance", "number", ["quotas", "quota"], { unit: "t", sample: "balance", engines: ["fillOutlook", "quotaRisk"] }),
      f("quota_definition__fill_rate", "Fill rate", "number", ["quota"], { unit: "%", sample: "fillRate", engines: ["fillOutlook"] }),
      f("— derived", "Steel category", "string[]", ["quotas", "quota", "products"], { derived: true, sample: "categoryIds" }),
    ],
  },
  ons: {
    format: "JSON", endpoint: "GET /economy/inflationandpriceindices/timeseries/{id}/ppi/data", grain: "Monthly index per series (GHAV · GHCZ · EZWP)",
    fields: [
      f("months[].date", "Month", "date", ["forecast", "market"], { sample: "date" }),
      f("months[].value", "Index (2015 = 100)", "number", ["forecast", "market", "plan", "assistant"], { unit: "index", sample: "price", engines: ["forecast", "planner"] }),
      f("— series id", "Series", "string", ["forecast", "market"], { sample: "series" }),
    ],
  },
  lme: {
    format: "JSON", endpoint: "GET /api/latest · /api/timeseries", grain: "Daily price per symbol (STEEL-RE · STEEL-SC · STEEL-HR)",
    fields: [
      f("date", "Date", "date", ["market"], { sample: "date" }),
      f("rates.{symbol}", "Price", "number", ["market", "suppliers", "forecast"], { unit: "USD/t", sample: "price", engines: ["forecast"] }),
      f("symbol", "Symbol", "string", ["market"], { sample: "series" }),
    ],
  },
  fx: {
    format: "JSON", endpoint: "GET /v1/latest?base={EUR|USD}&symbols=GBP", grain: "Daily ECB reference rate",
    fields: [
      f("rates.GBP (EUR)", "EUR → GBP", "number", ["plan", "orders", "suppliers", "market"], { sample: "eur", engines: ["fx", "landed"] }),
      f("rates.GBP (USD)", "USD → GBP", "number", ["plan", "orders", "suppliers", "market"], { sample: "usd", engines: ["fx", "landed"] }),
      f("date", "Rate date", "date", ["plan"], { sample: "date" }),
    ],
  },
  news: {
    format: "Atom XML", endpoint: "GET gov.uk/search/all.atom?keywords=…", grain: "One entry per announcement",
    fields: [
      f("entry/id", "ID", "string", ["news"], { sample: "id" }),
      f("entry/title", "Title", "string", ["news", "assistant"], { sample: "title" }),
      f("entry/summary", "Summary", "string", ["news"], { sample: "summary" }),
      f("entry/link@href", "Link", "url", ["news"], { sample: "url" }),
      f("entry/updated", "Published", "datetime", ["news"], { sample: "at" }),
      f("— derived", "Topic", "enum", ["news", "forecast"], { derived: true, sample: "topic", engines: ["forecast"] }),
    ],
  },
  "hmrc-trade": {
    format: "Fixed-width + TSV (zip)", endpoint: "uktradeinfo.com bulk datasets (SMKI · importer lists)", grain: "Monthly, per commodity code and per importer",
    fields: [
      f("period", "Month", "string", ["competition", "arrivals"], { sample: "period" }),
      f("comcode", "Commodity code", "string", ["competition", "arrivals", "products"], { sample: "code" }),
      f("net_mass_kg", "Tonnes imported", "number", ["competition", "arrivals"], { unit: "t", sample: "t" }),
      f("stat_value", "Value", "number", ["competition"], { unit: "£", sample: "v" }),
      f("country_of_origin", "Origin", "string", ["competition", "arrivals"], { sample: "origin" }),
      f("port", "Port of entry", "string", ["arrivals"], { sample: "port" }),
      f("mode_of_transport", "Transport mode", "string", ["arrivals"], { sample: "mode" }),
      f("importer_name", "Importer", "string", ["competition"], { sample: "name" }),
      f("importer_postcode", "Postcode", "string", ["competition"], { sample: "postcode" }),
    ],
  },
  "companies-house": {
    format: "iXBRL (XHTML)", endpoint: "GET /company/{number}/filing-history → accounts document", grain: "One filing per competitor per year",
    fields: [
      f("Inventories / Stocks", "Stock held", "number", ["competition"], { unit: "£", sample: "stock" }),
      f("Turnover / Revenue", "Turnover", "number", ["competition"], { unit: "£", sample: "turnover" }),
      f("CashBankOnHand", "Cash", "number", ["competition"], { unit: "£", sample: "cash" }),
      f("context endDate / instant", "Period end", "date", ["competition"], { sample: "date" }),
    ],
  },
  ais: {
    format: "WebSocket JSON", endpoint: "wss://stream.aisstream.io/v0/stream", grain: "Live message per ship (position + static data)",
    fields: [
      f("MetaData.MMSI", "MMSI", "string", ["arrivals"], { sample: "mmsi" }),
      f("ShipStaticData.ImoNumber", "IMO", "string", ["arrivals"], { sample: "imo" }),
      f("MetaData.ShipName", "Ship name", "string", ["arrivals"], { sample: "name" }),
      f("MetaData.latitude / longitude", "Position", "lat/lon", ["arrivals"], { sample: "pos" }),
      f("PositionReport.Sog", "Speed", "number", ["arrivals"], { unit: "kn", sample: "sog" }),
      f("ShipStaticData.Destination", "Destination", "string", ["arrivals"], { sample: "destination" }),
      f("ShipStaticData.Eta", "ETA", "datetime", ["arrivals", "orders"], { sample: "eta" }),
      f("ShipStaticData.MaximumStaticDraught", "Draught", "number", ["arrivals"], { unit: "m", sample: "draught" }),
      f("ShipStaticData.Type", "Ship type", "number", ["arrivals"], { sample: "type" }),
    ],
  },
  "tariff-codes": {
    format: "JSON:API", endpoint: "GET /uk/api/headings/{heading}", grain: "One row per commodity code (chapters 72–73)",
    fields: [
      f("goods_nomenclature_item_id", "Commodity code", "string", ["products", "plan", "quotas"], { sample: "code", engines: ["landed", "quotaRisk"] }),
      f("producline_suffix", "Suffix", "string", ["products"], { sample: "suffix" }),
      f("description", "Description", "string", ["products"], { sample: "description" }),
    ],
  },
  prices: {
    format: "JSON or CSV", endpoint: "Your subscription URL (.env)", grain: "One price per series per date",
    fields: [
      f("date", "Date", "date", ["market"], { sample: "date" }),
      f("series", "Series", "string", ["market", "suppliers"], { sample: "series" }),
      f("price", "Price", "number", ["market", "suppliers", "plan", "forecast"], { unit: "per t", sample: "price", engines: ["forecast", "planner"] }),
      f("currency", "Currency", "string", ["market"], { sample: "currency", engines: ["fx"] }),
    ],
  },
};

export function schemaFor(feedKey) {
  if (SCHEMA[feedKey]) return SCHEMA[feedKey];
  if (feedKey.startsWith("prices-")) return SCHEMA.prices;
  return null;
}

// Fold everything into the shape the page draws: sources with fields,
// plus a reverse index of pages → data points.
export function buildSchema(feeds, samples = {}) {
  const sources = feeds.map((feed) => {
    const s = schemaFor(feed.key) || { fields: [] };
    const sample = samples[feed.key] || {};
    const fields = s.fields.map((x) => ({ ...x, example: x.sample && sample[x.sample] !== undefined && sample[x.sample] !== null ? sample[x.sample] : null }));
    const pages = [...new Set(fields.flatMap((x) => x.usedIn))];
    return { key: feed.key, name: feed.name, provider: feed.source, url: feed.url, status: feed.status, every: feed.every, lastOkAt: feed.lastOkAt, detail: feed.detail,
      format: s.format || "", endpoint: s.endpoint || "", grain: s.grain || "", fields, pages };
  });
  const byPage = Object.entries(PAGES).map(([key, p]) => ({
    key, ...p,
    feeds: sources.map((src) => ({ key: src.key, name: src.name, status: src.status, fields: src.fields.filter((x) => x.usedIn.includes(key)).map((x) => x.label) })).filter((x) => x.fields.length),
  })).filter((p) => p.feeds.length);
  const totals = { sources: sources.length, fields: sources.reduce((n, s) => n + s.fields.length, 0), pages: byPage.length };
  return { totals, sources, pages: byPage, engines: ENGINES };
}
