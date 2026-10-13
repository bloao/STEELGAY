// API feed connector for market prices. Each source can be pointed at a URL
// (and token) in .env once you hold a data licence:
//
//   MEPS_FEED_URL=https://…           MEPS_FEED_TOKEN=…
//   KALLANISH_FEED_URL=https://…      KALLANISH_FEED_TOKEN=…
//   FASTMARKETS_FEED_URL / _TOKEN, ARGUS_FEED_URL / _TOKEN
//
// The URL can return JSON — an array of {date, series, price, currency}, or
// {data: [...]} — or CSV/TSV in any layout parseBenchmarkTable understands.
// Series names are matched to saved series by name or alias; unmatched ones
// are reported so you can map them once on the Market prices page.

import { parseBenchmarkTable } from "./benchmarks.mjs";

export const FEED_SOURCES = ["MEPS", "Kallanish", "Fastmarkets", "Argus"];
const envKey = (source) => source.toUpperCase().replace(/[^A-Z]/g, "");

export function feedConfig(env = process.env) {
  return Object.fromEntries(FEED_SOURCES.map((s) => {
    const url = env[`${envKey(s)}_FEED_URL`] || "";
    return [s, { configured: Boolean(url), url, token: env[`${envKey(s)}_FEED_TOKEN`] || "", envUrl: `${envKey(s)}_FEED_URL`, envToken: `${envKey(s)}_FEED_TOKEN` }];
  }));
}

export function parseFeedPayload(body, contentType = "") {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (/json/i.test(contentType) || /^\s*[[{]/.test(text)) {
    const data = typeof body === "string" ? JSON.parse(body) : body;
    const list = Array.isArray(data) ? data : Array.isArray(data.data) ? data.data : Array.isArray(data.prices) ? data.prices : [];
    const rows = list.map((r) => ({
      date: r.date || r.assessmentDate || r.period, series: r.series || r.name || r.symbol || r.description,
      price: r.price ?? r.value ?? r.mid ?? (r.low !== undefined && r.high !== undefined ? (Number(r.low) + Number(r.high)) / 2 : undefined),
      currency: r.currency || null,
    }));
    const header = ["date", "series", "price", "currency"];
    return parseBenchmarkTable([header, ...rows.map((r) => [r.date ?? "", r.series ?? "", r.price ?? "", r.currency ?? ""])]);
  }
  return parseBenchmarkTable(text);
}

export async function fetchFeed(source, cfg, fetchImpl = fetch) {
  if (!cfg || !cfg.configured) throw new Error(`${source} feed is not set up — add ${cfg ? cfg.envUrl : `${envKey(source)}_FEED_URL`} to .env`);
  const res = await fetchImpl(cfg.url, {
    headers: { accept: "application/json, text/csv;q=0.9, */*;q=0.5", ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`${source} feed returned HTTP ${res.status}`);
  const type = res.headers.get("content-type") || "";
  return parseFeedPayload(await res.text(), type);
}
