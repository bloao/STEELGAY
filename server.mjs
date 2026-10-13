import { createServer } from "node:http";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { calculate, validateInputs, findCategory, originMatches, ENGINE_VERSION, ORIGINS, INCOTERMS, CURRENCIES } from "./lib/calc.mjs";
import { createStore } from "./lib/store.mjs";
import { buildSampleRecords } from "./lib/demo.mjs";
import { ORDER_LINES, MEASURE, isMeasureOrderNumber, quarterFor } from "./lib/steel-measure.mjs";
import { parseTariffQuotas, toCalcRow, mergeDefinitions, buildLines } from "./lib/quota-feed.mjs";
import { SEED_PRODUCTS, validateProduct, stockMetrics, parseProductTable } from "./lib/products.mjs";
import { createSettingsStore, validateSettings, CATALOGUE_GROUPS } from "./lib/settings.mjs";
import { converse, systemPrompt, DEFAULT_MODEL } from "./lib/assistant.mjs";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const port = Number(process.env.PORT || 3000);
const root = process.cwd();
const STARTED_AT = new Date().toISOString();
const store = createStore(process.env.DATA_DIR || join(root, "var"));
const settingsStore = createSettingsStore(process.env.DATA_DIR || join(root, "var"));
const productStore = createStore(process.env.DATA_DIR || join(root, "var"), "products.json", () => SEED_PRODUCTS.map((p) => validateProduct(p).product));
const allowedOrigin = process.env.ALLOWED_ORIGIN || ""; // e.g. https://app.example.com; empty = same-origin only
const tariffApiBase = "https://www.trade-tariff.service.gov.uk/uk/api";
const quotaCsvUrl =
  "https://data.api.trade.gov.uk/v1/datasets/uk-trade-quotas/versions/latest/reports/quotas-including-current-volumes/data?format=csv&download";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".csv": "text/csv; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

const caches = {
  commodities: { expiresAt: 0, payload: null },
  quotas: { expiresAt: 0, payload: null },
  tradeMeasure: null,
};

// Compressible mime types — text-based payloads that gzip well.
const GZIP_RE = /^(?:text\/|application\/(?:json|javascript|xml|xhtml\+xml|rss\+xml)|image\/svg\+xml)/;

function acceptsGzip(response) {
  const enc = (response.req && response.req.headers && response.req.headers["accept-encoding"]) || "";
  return /\bgzip\b/i.test(enc);
}

function writeBody(response, statusCode, headers, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const contentType = headers["content-type"] || "application/octet-stream";
  if (buf.length > 1024 && GZIP_RE.test(contentType) && acceptsGzip(response)) {
    const gz = gzipSync(buf);
    response.writeHead(statusCode, {
      ...headers,
      "content-encoding": "gzip",
      "content-length": gz.length,
      vary: "Accept-Encoding",
    });
    response.end(gz);
  } else {
    response.writeHead(statusCode, { ...headers, "content-length": buf.length });
    response.end(buf);
  }
}

function sendJson(response, statusCode, payload) {
  writeBody(response, statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...corsHeaders(response.req),
  }, JSON.stringify(payload));
}

// Same-origin only by default. In local development we also allow other
// localhost ports (e.g. PyCharm's preview server on :63342) to call the API.
const isProduction = process.env.NODE_ENV === "production";
function corsHeaders(request) {
  const origin = request?.headers?.origin || "";
  const devOrigin = !isProduction && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : "";
  const allow = allowedOrigin || devOrigin;
  if (!allow) return {};
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    vary: "Origin",
  };
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

// ---- HMRC Trade Tariff access ------------------------------------------
// The API is public, but HMRC rate-limits anonymous traffic. Registered users
// (free, https://hub.trade-tariff.service.gov.uk/) get a higher limit via an
// OAuth client-credentials token. Either set TARIFF_ACCESS_TOKEN directly, or
// TARIFF_CLIENT_ID + TARIFF_CLIENT_SECRET + TARIFF_TOKEN_URL (from the portal).
const tariffCreds = {
  accessToken: process.env.TARIFF_ACCESS_TOKEN || "",
  clientId: process.env.TARIFF_CLIENT_ID || "",
  clientSecret: process.env.TARIFF_CLIENT_SECRET || "",
  tokenUrl: process.env.TARIFF_TOKEN_URL || "",
};
const tariffAuthMode = tariffCreds.accessToken || (tariffCreds.clientId && tariffCreds.clientSecret && tariffCreds.tokenUrl) ? "registered" : "public";
const tariffToken = { value: "", expiresAt: 0 };
let tariffBackoffUntil = 0;

const tariffAuthStatus = { ok: null, checkedAt: null, error: null, method: null };

async function requestTariffToken() {
  // OAuth client-credentials. Identity providers differ on where the secret
  // goes, so try HTTP Basic first (standard for confidential clients), then
  // the secret in the form body.
  const attempts = [
    {
      method: "basic",
      headers: { authorization: `Basic ${Buffer.from(`${tariffCreds.clientId}:${tariffCreds.clientSecret}`).toString("base64")}` },
      body: { grant_type: "client_credentials", client_id: tariffCreds.clientId },
    },
    { method: "body", headers: {}, body: { grant_type: "client_credentials", client_id: tariffCreds.clientId, client_secret: tariffCreds.clientSecret } },
  ];
  let lastError = "";
  for (const attempt of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const response = await fetch(tariffCreds.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...attempt.headers },
      body: new URLSearchParams(attempt.body),
      signal: AbortSignal.timeout(15_000),
    }).catch((error) => ({ ok: false, status: 0, text: async () => error.message }));
    if (response.ok) {
      // eslint-disable-next-line no-await-in-loop
      const data = await response.json();
      if (data.access_token) return { token: data.access_token, expiresIn: Number(data.expires_in) || 3600, method: attempt.method };
      lastError = "token response had no access_token";
    } else {
      // eslint-disable-next-line no-await-in-loop
      const text = String(await response.text()).slice(0, 200).replace(/\s+/g, " ");
      lastError = `HTTP ${response.status}${text ? `: ${text}` : ""}`;
    }
  }
  throw new Error(lastError);
}

async function tariffAuthHeader() {
  if (tariffCreds.accessToken) return `Bearer ${tariffCreds.accessToken}`;
  if (tariffAuthMode !== "registered") return null;
  if (tariffToken.value && tariffToken.expiresAt > Date.now() + 30_000) return `Bearer ${tariffToken.value}`;
  if (!tariffToken.value && tariffAuthStatus.ok === false && tariffToken.expiresAt > Date.now()) return null;
  try {
    const { token, expiresIn, method } = await requestTariffToken();
    tariffToken.value = token;
    tariffToken.expiresAt = Date.now() + expiresIn * 1000;
    Object.assign(tariffAuthStatus, { ok: true, checkedAt: new Date().toISOString(), error: null, method });
    return `Bearer ${token}`;
  } catch (error) {
    Object.assign(tariffAuthStatus, { ok: false, checkedAt: new Date().toISOString(), error: error.message, method: null });
    console.warn(`HMRC Trade Tariff sign-in failed (${error.message}); using public access.`);
    tariffToken.expiresAt = Date.now() + 5 * 60 * 1000; // don't retry the token endpoint on every request
    tariffToken.value = "";
    return null;
  }
}

async function getJson(url) {
  const isTariff = url.startsWith(tariffApiBase);
  if (isTariff && Date.now() < tariffBackoffUntil) {
    throw Object.assign(new Error("HMRC rate limit reached — waiting before retrying"), { rateLimited: true });
  }
  const headers = { accept: "application/json", "user-agent": "datafab-steel-order-tool/1.1" };
  if (isTariff) {
    const auth = await tariffAuthHeader().catch(() => null);
    if (auth) headers.authorization = auth;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });

  if (response.status === 429 && isTariff) {
    const wait = Math.min(Number(response.headers.get("retry-after")) || 60, 900);
    tariffBackoffUntil = Date.now() + wait * 1000;
    console.warn(`HMRC Trade Tariff rate limit hit; pausing tariff requests for ${wait}s.`);
    throw Object.assign(new Error(`HMRC rate limit (429) — paused ${wait}s`), { rateLimited: true });
  }

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }

  return response.json();
}

function plainDescription(attributes = {}) {
  return String(
    attributes.description_plain ||
      attributes.formatted_description ||
      attributes.description ||
      ""
  )
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function loadTradeMeasure() {
  if (caches.tradeMeasure) {
    return caches.tradeMeasure;
  }

  const source = await readFile(join(root, "steel-trade-measure.js"), "utf8");
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(source, context);
  caches.tradeMeasure = context.window.STEEL_TRADE_MEASURE;
  return caches.tradeMeasure;
}

async function fetchChapterHeadings(chapterCode) {
  const chapter = await getJson(`${tariffApiBase}/chapters/${chapterCode}`);
  const chapterTitle = plainDescription(chapter.data.attributes);
  const seen = new Set();

  return (chapter.included || [])
    .filter((item) => item.type === "heading")
    .map((heading) => ({
      chapter: chapterCode,
      chapterTitle,
      heading: heading.attributes.goods_nomenclature_item_id.slice(0, 4),
      headingDescription: plainDescription(heading.attributes),
    }))
    .filter((heading) => {
      if (seen.has(heading.heading)) {
        return false;
      }

      seen.add(heading.heading);
      return true;
    });
}

async function fetchHeadingCommodities(heading) {
  const payload = await getJson(`${tariffApiBase}/headings/${heading.heading}`);

  return (payload.included || [])
    .filter((item) => item.type === "commodity")
    .filter((item) => item.attributes.declarable === true)
    .map((commodity) => ({
      code: commodity.attributes.goods_nomenclature_item_id,
      suffix: commodity.attributes.producline_suffix,
      description: plainDescription(commodity.attributes),
      chapter: heading.chapter,
      chapterTitle: heading.chapterTitle,
      heading: heading.heading,
      headingDescription: heading.headingDescription,
    }));
}

async function getSteelCommodities() {
  const now = Date.now();

  if (caches.commodities.payload && caches.commodities.expiresAt > now) {
    return caches.commodities.payload;
  }

  const chapters = ["72", "73"];
  const headings = (await Promise.all(chapters.map(fetchChapterHeadings))).flat();
  const commodities = [];
  const seen = new Set();

  for (const heading of headings) {
    const headingCommodities = await fetchHeadingCommodities(heading);

    for (const commodity of headingCommodities) {
      const key = `${commodity.code}-${commodity.suffix}`;

      if (!seen.has(key)) {
        seen.add(key);
        commodities.push(commodity);
      }
    }
  }

  commodities.sort((a, b) => {
    const codeOrder = a.code.localeCompare(b.code);
    return codeOrder || a.suffix.localeCompare(b.suffix);
  });

  const payload = {
    source: "GOV.UK Trade Tariff API",
    sourceUrl: tariffApiBase,
    liveFetchedAt: new Date().toISOString(),
    cacheSeconds: 86400,
    count: commodities.length,
    commodities,
  };

  caches.commodities = {
    expiresAt: now + 24 * 60 * 60 * 1000,
    payload,
  };
  return payload;
}

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

async function getSteelQuotaRows() {
  const now = Date.now();

  if (caches.quotas.payload && caches.quotas.expiresAt > now) {
    return caches.quotas.payload;
  }

  const tradeMeasure = await loadTradeMeasure();
  const response = await fetch(quotaCsvUrl, {
    headers: {
      accept: "text/csv",
      "user-agent": "steel-arb-prototype/0.1",
    },
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${quotaCsvUrl}`);
  }

  const [headers, ...records] = parseCsv(await response.text());
  const rows = records
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index] || ""])))
    .map((row) => {
      const commodityCodes = row.quota__commodities
        .split("|")
        .map((code) => code.trim())
        .filter(Boolean);

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
        lastAllocationDate:
          row.quota_definition__last_allocation_date === "#NA"
            ? ""
            : row.quota_definition__last_allocation_date,
        initialVolume: toNumber(row.quota_definition__initial_volume),
        balance: toNumber(row.quota_definition__balance),
        fillRate: toNumber(row.quota_definition__fill_rate),
        categoryIds: findCategoryIds(commodityCodes, tradeMeasure.categories),
      };
    })
    .filter((row) => row.categoryIds.length > 0);

  const payload = {
    source: "UK Trade Quotas API",
    sourceUrl: quotaCsvUrl,
    liveFetchedAt: new Date().toISOString(),
    cacheSeconds: 600,
    rows,
  };

  caches.quotas = {
    expiresAt: now + 10 * 60 * 1000,
    payload,
  };
  return payload;
}

function findSteelMeasureCategory(commodityCode, categories) {
  return (
    categories.find((category) =>
      category.commodityPrefixes.some((prefix) => commodityCode.startsWith(prefix))
    ) || null
  );
}

async function resolveCommodityCodeForTariff(commodityCode) {
  const candidates = [commodityCode];

  try {
    await getJson(`${tariffApiBase}/commodities/${commodityCode}`);
    return { code: commodityCode, substituted: false };
  } catch {
    const heading = commodityCode.slice(0, 4);
    const prefix = commodityCode.slice(0, 8);
    const payload = await getJson(`${tariffApiBase}/headings/${heading}`);
    const replacement = (payload.included || [])
      .filter((item) => item.type === "commodity")
      .filter((item) => item.attributes.declarable === true)
      .map((item) => item.attributes.goods_nomenclature_item_id)
      .find((code) => code.startsWith(prefix));

    if (replacement) {
      return { code: replacement, substituted: true, originalCode: commodityCode };
    }
  }

  return { code: candidates[0], substituted: false };
}

function buildIncludedMap(payload) {
  return new Map((payload.included || []).map((item) => [`${item.type}:${item.id}`, item]));
}

function isMeasureActive(measure, importDate) {
  const start = measure.attributes.effective_start_date?.slice(0, 10);
  const end = measure.attributes.effective_end_date?.slice(0, 10);

  return (!start || importDate >= start) && (!end || importDate <= end);
}

function componentLabel(component) {
  if (!component) {
    return "";
  }

  const amount = component.duty_amount;

  if (amount === null || amount === undefined) {
    return "";
  }

  if (component.monetary_unit_code && component.measurement_unit_code === "TNE") {
    return `${amount} ${component.monetary_unit_code}/tonne`;
  }

  if (component.duty_expression_abbreviation === "%") {
    return `${amount}%`;
  }

  return `${amount}${component.duty_expression_abbreviation || ""}`;
}

function componentCost(component, goodsValue, tonnage) {
  if (!component || component.duty_amount === null || component.duty_amount === undefined) {
    return 0;
  }

  if (component.monetary_unit_code === "GBP" && component.measurement_unit_code === "TNE") {
    return Number.isFinite(tonnage) ? component.duty_amount * tonnage : 0;
  }

  if (component.duty_expression_abbreviation === "%") {
    return Number.isFinite(goodsValue) ? goodsValue * (component.duty_amount / 100) : 0;
  }

  return 0;
}

function extractConditionDuty(condition, goodsValue) {
  const expression = condition?.attributes?.duty_expression || "";
  const match = expression.replace(/<[^>]+>/g, "").match(/([0-9]+(?:\.[0-9]+)?)\s*%/);

  if (!match) {
    return null;
  }

  const rate = Number(match[1]);

  return {
    label: `${rate}%`,
    estimatedCost: Number.isFinite(goodsValue) ? goodsValue * (rate / 100) : 0,
    rate,
  };
}

function originMatchesGeography(geography, origin) {
  if (!geography || !origin) {
    return false;
  }

  const description = geography.attributes?.description;

  if (description === "ERGA OMNES" || geography.id === "1011") {
    return true;
  }

  if (originMatches(origin, { id: geography.id, description })) {
    return true;
  }

  // Country groups (e.g. GSP lists) carry their members as children.
  return (geography.childIds || []).some((childId) => originMatches(origin, { id: childId }));
}

function normalizeMeasure(payload, measure, included, goodsValue, tonnage) {
  const measureType = included.get(`measure_type:${measure.relationships.measure_type.data.id}`);
  const geography = included.get(`geographical_area:${measure.relationships.geographical_area.data.id}`);
  const components = (measure.relationships.measure_components.data || [])
    .map((ref) => included.get(`${ref.type}:${ref.id}`)?.attributes)
    .filter(Boolean);
  const conditions = (measure.relationships.measure_conditions.data || [])
    .map((ref) => included.get(`${ref.type}:${ref.id}`))
    .filter(Boolean);
  const conditionDuty = conditions
    .map((condition) => extractConditionDuty(condition, goodsValue))
    .find((duty) => duty && duty.rate > 0);
  const componentLabels = components.map(componentLabel).filter(Boolean);
  const componentCostTotal = components.reduce(
    (total, component) => total + componentCost(component, goodsValue, tonnage),
    0
  );

  const ratePercent = conditionDuty
    ? conditionDuty.rate
    : components
        .filter((c) => c.duty_expression_abbreviation === "%")
        .reduce((sum, c) => sum + Number(c.duty_amount || 0), 0);
  const perTonneGbp = conditionDuty
    ? 0
    : components
        .filter((c) => c.monetary_unit_code === "GBP" && c.measurement_unit_code === "TNE")
        .reduce((sum, c) => sum + Number(c.duty_amount || 0), 0);
  const orderRef = measure.relationships.order_number?.data;
  const orderNumber = orderRef
    ? included.get(`${orderRef.type}:${orderRef.id}`)?.attributes?.number || orderRef.id
    : null;

  return {
    measureTypeId: measureType.id,
    ratePercent,
    perTonneGbp,
    orderNumber,
    geographyId: geography.id,
    geographyChildIds: (geography.relationships?.children_geographical_areas?.data || []).map((c) => c.id),
    measureType: measureType.attributes.description,
    geography: geography.attributes.description,
    label: conditionDuty?.label || componentLabels.join(" + ") || "Conditional",
    estimatedCost: conditionDuty?.estimatedCost ?? componentCostTotal,
    hasConditions: conditions.length > 0,
    startDate: measure.attributes.effective_start_date?.slice(0, 10) || "",
    endDate: measure.attributes.effective_end_date?.slice(0, 10) || "",
  };
}

async function getImportDuty(commodityCode, origin, importDate, goodsValue, tonnage) {
  if (origin === "United Kingdom") {
    return {
      label: "Not applicable for UK-origin goods",
      estimatedCost: 0,
      sourceCode: commodityCode,
      source: "GOV.UK Trade Tariff API",
    };
  }

  const resolved = await resolveCommodityCodeForTariff(commodityCode);
  const payload = await getJson(`${tariffApiBase}/commodities/${resolved.code}`);
  const included = buildIncludedMap(payload);
  const measures = (payload.included || [])
    .filter((item) => item.type === "measure")
    .filter((measure) => measure.attributes.import === true)
    .filter((measure) => isMeasureActive(measure, importDate))
    .map((measure) => normalizeMeasure(payload, measure, included, goodsValue, tonnage))
    .filter((measure) =>
      originMatchesGeography(
        { id: measure.geographyId, attributes: { description: measure.geography }, childIds: measure.geographyChildIds },
        origin
      )
    );

  const preference = measures.find((measure) => measure.measureTypeId === "142");
  const thirdCountry = measures.find((measure) => measure.measureTypeId === "103");
  const selected = preference || thirdCountry || null;

  if (!selected) {
    return {
      label: "No import-duty measure found",
      estimatedCost: 0,
      sourceCode: resolved.code,
      substitutedCode: resolved.substituted,
      source: "GOV.UK Trade Tariff API",
    };
  }

  return {
    ...selected,
    sourceCode: resolved.code,
    substitutedCode: resolved.substituted,
    originalCode: resolved.originalCode || resolved.code,
    source: "GOV.UK Trade Tariff API",
  };
}

// ------------------------------------------------------------ live steel quotas

async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        // eslint-disable-next-line no-await-in-loop
        results[index] = { ok: true, value: await fn(items[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// HMRC Trade Tariff: definitions for one order number active on a date.
async function fetchTariffQuota(orderNumber, isoDate) {
  const [y, m, d] = isoDate.split("-");
  const payload = await getJson(`${tariffApiBase}/quotas/search?order_number=${orderNumber}&year=${y}&month=${m}&day=${d}`);
  return parseTariffQuotas(payload);
}

const measureCache = { payload: null, expiresAt: 0, inflight: null, lastForced: 0 };
let nextQuarterCache = { defs: null, start: null, expiresAt: 0 };

async function loadMeasureQuotas() {
  const asOf = new Date().toISOString().slice(0, 10);
  const nextQuarterStart = (() => {
    const q = quarterFor(asOf);
    const end = new Date(`${q.endDate}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return end.toISOString().slice(0, 10);
  })();
  const tradeMeasure = await loadTradeMeasure();
  const errors = [];

  // 1. HMRC Trade Tariff — current quarter for all 72 lines every refresh;
  //    next quarter's opening volumes only every 6 hours (they rarely change).
  const wantNext = !nextQuarterCache.defs || nextQuarterCache.start !== nextQuarterStart || nextQuarterCache.expiresAt < Date.now();
  const jobs = ORDER_LINES.map((l) => [l.orderNumber, asOf]);
  if (wantNext) jobs.push(...ORDER_LINES.map((l) => [l.orderNumber, nextQuarterStart]));
  const results = await mapPool(jobs, 4, ([order, date]) => fetchTariffQuota(order, date));
  const fetched = results.filter((r) => r.ok).flatMap((r) => r.value).filter((d) => isMeasureOrderNumber(d.orderNumber));
  if (wantNext) {
    const nextDefs = fetched.filter((d) => d.startDate >= nextQuarterStart);
    if (nextDefs.length) nextQuarterCache = { defs: nextDefs, start: nextQuarterStart, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  }
  const tariffDefs = [...fetched.filter((d) => d.startDate < nextQuarterStart), ...(nextQuarterCache.defs || [])];
  const tariffFailures = results.filter((r) => !r.ok);
  if (tariffFailures.length) {
    const limited = tariffFailures.some((r) => r.error.rateLimited);
    errors.push(limited
      ? `HMRC Trade Tariff rate limit reached on ${tariffFailures.length} of ${jobs.length} requests — those lines use the DBT daily dataset.${tariffAuthMode === "public" ? " Registering for free HMRC API credentials raises the limit." : ""}`
      : `HMRC Trade Tariff: ${tariffFailures.length} of ${jobs.length} requests failed (${tariffFailures[0].error.message})`);
  }

  // 2. DBT dataset — fills any line or period HMRC did not return.
  let dbtDefs = [];
  let dbtFetchedAt = null;
  try {
    const q = await getSteelQuotaRows();
    dbtFetchedAt = q.liveFetchedAt;
    dbtDefs = q.rows.filter((r) => isMeasureOrderNumber(r.orderNumber));
  } catch (error) {
    errors.push(`DBT quotas dataset: ${error.message}`);
  }

  const defs = mergeDefinitions(tariffDefs, dbtDefs);
  if (!defs.length) {
    throw new Error(errors.join("; ") || "No quota data returned");
  }
  const lines = buildLines(defs, tradeMeasure.categories, asOf);
  return {
    measure: MEASURE,
    asOf,
    quarter: quarterFor(asOf),
    fetchedAt: new Date().toISOString(),
    sources: {
      tariff: {
        name: "HMRC Trade Tariff API",
        url: `${tariffApiBase}/quotas/search`,
        auth: tariffAuthMode,
        lines: new Set(tariffDefs.filter((d) => asOf >= d.startDate && asOf <= d.endDate).map((d) => d.orderNumber)).size,
      },
      dbt: { name: "DBT UK trade quotas dataset (daily)", url: quotaCsvUrl, fetchedAt: dbtFetchedAt, lines: new Set(dbtDefs.map((d) => d.orderNumber)).size },
    },
    errors,
    lines,
    rows: defs.map((d) => toCalcRow(d, tradeMeasure.categories)),
  };
}

async function getMeasureQuotas({ force = false } = {}) {
  const now = Date.now();
  if (force && now - measureCache.lastForced < 60_000) force = false; // at most one forced refresh a minute
  if (!force && measureCache.payload && measureCache.expiresAt > now) return measureCache.payload;
  if (measureCache.inflight) return measureCache.inflight;
  if (force) measureCache.lastForced = now;
  measureCache.inflight = loadMeasureQuotas()
    .then((payload) => {
      measureCache.payload = payload;
      measureCache.expiresAt = Date.now() + 10 * 60 * 1000;
      return payload;
    })
    .finally(() => { measureCache.inflight = null; });
  return measureCache.inflight;
}

// All import measures that apply to this code, origin and date, normalised
// with machine-readable rates for lib/calc.mjs.
async function getDutyMeasures(commodityCode, origin, importDate) {
  if (origin === "United Kingdom") return { measures: [], sourceCode: commodityCode };
  const resolved = await resolveCommodityCodeForTariff(commodityCode);
  const payload = await getJson(`${tariffApiBase}/commodities/${resolved.code}`);
  const included = buildIncludedMap(payload);
  const measures = (payload.included || [])
    .filter((item) => item.type === "measure")
    .filter((measure) => measure.attributes.import === true)
    .filter((measure) => isMeasureActive(measure, importDate))
    .map((measure) => normalizeMeasure(payload, measure, included, 0, 0))
    .filter((measure) =>
      originMatchesGeography(
        { id: measure.geographyId, attributes: { description: measure.geography }, childIds: measure.geographyChildIds },
        origin
      )
    );
  return { measures, sourceCode: resolved.code, substituted: resolved.substituted, fetchedAt: new Date().toISOString() };
}

const dutyCache = new Map();
async function getDutyMeasuresCached(code, origin, importDate) {
  const key = `${code}|${origin}|${importDate}`;
  const hit = dutyCache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await getDutyMeasures(code, origin, importDate);
  dutyCache.set(key, { value, expiresAt: Date.now() + 6 * 60 * 60 * 1000 });
  if (dutyCache.size > 500) dutyCache.delete(dutyCache.keys().next().value);
  return value;
}

// GBP per 1 unit of currency, from the ECB reference rates (Frankfurter).
const fxCache = new Map();
async function getFx(currency) {
  if (currency === "GBP") return { rate: 1, source: "GBP", date: null };
  const hit = fxCache.get(currency);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const urls = [
    `https://api.frankfurter.dev/v1/latest?base=${currency}&symbols=GBP`,
    `https://api.frankfurter.app/latest?from=${currency}&to=GBP`,
  ];
  for (const fxUrl of urls) {
    try {
      const data = await getJson(fxUrl);
      const rate = data?.rates?.GBP;
      if (rate > 0) {
        const value = { rate, source: "ECB reference rate", date: data.date };
        fxCache.set(currency, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
        return value;
      }
    } catch (error) {
      console.warn(`FX lookup failed: ${fxUrl}: ${error.message}`);
    }
  }
  return null;
}

// Gather live market data, run the engine, and return result + snapshot of
// every external value used, so a saved scenario can always be explained.
async function runScenario(rawInputs) {
  const { inputs, errors, valid } = validateInputs(rawInputs);
  if (!valid) return { ok: false, errors, inputs };

  const tradeMeasure = await loadTradeMeasure();
  const category = findCategory(inputs.commodityCode, tradeMeasure.categories);
  const market = {
    categories: tradeMeasure.categories,
    tradeMeasureEffectiveFrom: tradeMeasure.effectiveFrom,
    quotaRows: [],
    dutyMeasures: [],
    fx: null,
  };
  const sources = { engineVersion: ENGINE_VERSION, calculatedAt: new Date().toISOString() };

  const jobs = [];
  if (category && inputs.origin !== "United Kingdom") {
    jobs.push(getMeasureQuotas().then((q) => {
      market.quotaRows = q.rows;
      sources.quotasFetchedAt = q.fetchedAt;
      sources.quotaSource = q.sources.tariff.lines ? "HMRC Trade Tariff" : "DBT dataset";
    }).catch((error) => { market.quotaError = error.message; }));
  }
  if (inputs.origin !== "United Kingdom") {
    jobs.push(getDutyMeasuresCached(inputs.commodityCode, inputs.origin, inputs.importDate).then((d) => {
      market.dutyMeasures = d.measures;
      sources.tariffFetchedAt = d.fetchedAt;
      sources.tariffCode = d.sourceCode;
    }).catch((error) => { market.dutyError = error.message; }));
  }
  if (inputs.priceCurrency !== "GBP" && !inputs.fxRateOverride) {
    jobs.push(getFx(inputs.priceCurrency).then((fx) => { market.fx = fx; sources.fx = fx; }));
  }
  await Promise.all(jobs);

  if (market.quotaError) {
    return { ok: false, errors: { _: `Live quota data unavailable (${market.quotaError}). Try again shortly.` }, inputs };
  }

  const result = calculate(inputs, market, { asOf: new Date().toISOString().slice(0, 10) });
  if (result.ok) {
    result.sources = sources;
    result.dutyMeasures = market.dutyMeasures.map(({ measureTypeId, measureType, label, ratePercent, perTonneGbp, orderNumber, geography }) =>
      ({ measureTypeId, measureType, label, ratePercent, perTonneGbp, orderNumber, geography }));
  }
  return result;
}

function getQuotaPeriod(value) {
  const date = new Date(`${value}T00:00:00`);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;

  if (month >= 7 && month <= 9) {
    return { label: `Q1 ${year}/${year + 1}`, startDate: `${year}-07-01`, endDate: `${year}-09-30` };
  }

  if (month >= 10 && month <= 12) {
    return { label: `Q2 ${year}/${year + 1}`, startDate: `${year}-10-01`, endDate: `${year}-12-31` };
  }

  if (month >= 1 && month <= 3) {
    return { label: `Q3 ${year - 1}/${year}`, startDate: `${year}-01-01`, endDate: `${year}-03-31` };
  }

  return { label: `Q4 ${year - 1}/${year}`, startDate: `${year}-04-01`, endDate: `${year}-06-30` };
}

function geographyScore(areas, origin) {
  if (!origin || origin === "United Kingdom") {
    return 0;
  }

  if (origin === "European Union" && areas.includes("European Union")) {
    return 100;
  }

  if (areas.includes(origin)) {
    return 100;
  }

  if (origin !== "European Union" && areas.includes("Countries other than Member States of the European Union")) {
    return 50;
  }

  if (areas.includes("ERGA OMNES")) {
    return 10;
  }

  return 0;
}

function getQuotaBalanceTonnes(row) {
  if (!row || row.balance === null) {
    return null;
  }

  if (row.measurementUnit.toLowerCase().includes("kilogram")) {
    return row.balance / 1000;
  }

  if (row.measurementUnit.toLowerCase().includes("tonne")) {
    return row.balance;
  }

  return null;
}

function getInitialVolumeTonnes(row) {
  if (!row || row.initialVolume === null) {
    return null;
  }

  if (row.measurementUnit.toLowerCase().includes("kilogram")) {
    return row.initialVolume / 1000;
  }

  if (row.measurementUnit.toLowerCase().includes("tonne")) {
    return row.initialVolume;
  }

  return null;
}

function calculateExposure(tonnage, basePrice, category, origin, balanceTonnes) {
  if (!Number.isFinite(tonnage) || !Number.isFinite(basePrice)) {
    return null;
  }

  if (!category || !origin || origin === "United Kingdom") {
    return {
      goodsValue: tonnage * basePrice,
      excessTonnes: 0,
      exposedValue: 0,
      tariffCost: 0,
      applicable: false,
    };
  }

  const goodsValue = tonnage * basePrice;
  const excessTonnes = Number.isFinite(balanceTonnes)
    ? Math.max(tonnage - balanceTonnes, 0)
    : tonnage;
  const exposedValue = excessTonnes * basePrice;

  return {
    goodsValue,
    excessTonnes,
    exposedValue,
    tariffCost: exposedValue * 0.5,
    applicable: true,
  };
}

async function quotaCheck(url) {
  const commodityCode = (url.searchParams.get("commodity") || "").trim();
  const origin = (url.searchParams.get("origin") || "").trim();
  const importDate = (url.searchParams.get("date") || "").trim();
  const tonnage = Number(url.searchParams.get("tonnage"));
  const basePrice = Number(url.searchParams.get("basePrice"));

  if (!/^\d{8,10}$/.test(commodityCode)) {
    return { statusCode: 400, payload: { error: "Commodity must be an 8- or 10-digit code." } };
  }

  if (!origin || !/^\d{4}-\d{2}-\d{2}$/.test(importDate)) {
    return { statusCode: 400, payload: { error: "Origin and date are required." } };
  }

  const code = commodityCode.length === 8 ? `${commodityCode}00` : commodityCode;
  const tradeMeasure = await loadTradeMeasure();
  const category = findSteelMeasureCategory(code, tradeMeasure.categories);
  const quotaPeriod = getQuotaPeriod(importDate);
  const quotaPayload = await getSteelQuotaRows();
  const matches = category
    ? quotaPayload.rows
        .filter((row) => row.categoryIds.includes(category.id))
        .filter((row) =>
          row.commodityCodes.some(
            (quotaCode) => quotaCode === code || quotaCode.startsWith(code.slice(0, 8))
          )
        )
        .filter((row) => importDate >= row.startDate && importDate <= row.endDate)
        .map((row) => ({ row, score: geographyScore(row.geographicalAreas, origin) }))
        .filter((match) => match.score > 0)
        .sort((a, b) => b.score - a.score || a.row.orderNumber.localeCompare(b.row.orderNumber))
    : [];

  const quotaRow = matches[0]?.row || null;
  const balanceTonnes = getQuotaBalanceTonnes(quotaRow);
  const initialVolumeTonnes = getInitialVolumeTonnes(quotaRow);
  const exposure = calculateExposure(tonnage, basePrice, category, origin, balanceTonnes);
  const goodsValue = Number.isFinite(tonnage) && Number.isFinite(basePrice) ? tonnage * basePrice : 0;
  const apiImportDuty = await getImportDuty(code, origin, importDate, goodsValue, tonnage);
  const importDuty =
    category && quotaRow
      ? {
          label: `0% under quota order ${quotaRow.orderNumber}`,
          estimatedCost: 0,
          measureType: "Non preferential tariff quota",
          geography: quotaRow.geographicalAreas.join(", "),
          sourceCode: apiImportDuty.sourceCode,
          substitutedCode: apiImportDuty.substitutedCode,
          originalCode: apiImportDuty.originalCode,
          source: "GOV.UK Trade Tariff API",
          note: "The 50% steel measure is shown separately as out-of-quota exposure.",
        }
      : apiImportDuty;

  return {
    statusCode: 200,
    payload: {
      commodityCode: code,
      liveFetchedAt: quotaPayload.liveFetchedAt,
      quotaPeriod,
      category: category
        ? {
            id: category.id,
            name: category.name,
            authorisedUse: category.authorisedUse === true,
          }
        : null,
      quota: quotaRow
        ? {
            orderNumber: quotaRow.orderNumber,
            geographicalAreas: quotaRow.geographicalAreas,
            status: quotaRow.status,
            startDate: quotaRow.startDate,
            endDate: quotaRow.endDate,
            lastAllocationDate: quotaRow.lastAllocationDate,
            measurementUnit: quotaRow.measurementUnit,
            balanceTonnes,
            initialVolumeTonnes,
            fillRate: quotaRow.fillRate,
          }
        : null,
      importDuty,
      exposure,
    },
  };
}

// Never serve source, config, raw data, git metadata or the scenario store.
const PRIVATE_DIRS = new Set(["var", "lib", "src", "data", "tests", "scripts", "config", "__pycache__", "node_modules"]);
const PRIVATE_FILES = /^(server\.mjs|main\.py|package(-lock)?\.json|Dockerfile|fly\.toml|requirements\.txt|README\.md)$/i;
function isPrivatePath(safePath) {
  const parts = safePath.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return false;
  if (parts.some((part) => part.startsWith("."))) return true;
  if (parts.length > 1 && PRIVATE_DIRS.has(parts[0])) return true;
  if (parts.length === 1 && PRIVATE_FILES.test(parts[0])) return true;
  return /\.py$/i.test(safePath);
}

async function serveStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === "/" ? "/the-plan.html" : requestUrl.pathname;
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || isPrivatePath(safePath)) {
    sendError(response, 404, "Not found");
    return;
  }

  try {
    const body = await readFile(filePath);
    const contentType = mimeTypes[extname(filePath)] || "application/octet-stream";
    // Static assets can be cached briefly by the browser — dev-friendly TTL.
    writeBody(response, 200, {
      "content-type": contentType,
      "cache-control": "public, max-age=60",
    }, body);
  } catch {
    sendError(response, 404, "Not found");
  }
}

// Site-wide HTTP Basic Auth. When SITE_PASSWORD is set in the environment
// every request must present matching credentials; when it is unset the site
// stays open, so `node server.mjs` still works for local development.
const AUTH_USER = process.env.SITE_USER || "team";
const AUTH_PASS = process.env.SITE_PASSWORD || "";
const AUTH_REALM = process.env.SITE_REALM || "Datafab AGX";
// Named accounts: SITE_USERS="george:secret:admin,sam:secret2:buyer,jo:pw:approver"
// Roles: buyer (create/edit/submit), approver (also approve/reject), admin (all).
const SITE_USERS = (process.env.SITE_USERS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const [name, pass, role = "buyer"] = entry.split(":");
    return { name, pass, role };
  })
  .filter((u) => u.name && u.pass);
const authEnabled = Boolean(AUTH_PASS) || SITE_USERS.length > 0;

function basicCredentials(request) {
  const [scheme, encoded] = (request.headers.authorization || "").split(" ");
  if (scheme !== "Basic" || !encoded) return null;
  const decoded = Buffer.from(encoded, "base64").toString("utf-8");
  const idx = decoded.indexOf(":");
  return idx < 0 ? null : { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
}

function findUser(creds) {
  if (!creds) return null;
  for (const u of SITE_USERS) {
    if (timingSafeEqualStr(creds.user, u.name) && timingSafeEqualStr(creds.pass, u.pass)) return { name: u.name, role: u.role };
  }
  if (AUTH_PASS && timingSafeEqualStr(creds.user, AUTH_USER) && timingSafeEqualStr(creds.pass, AUTH_PASS)) {
    return { name: AUTH_USER, role: "admin" };
  }
  return null;
}

function currentUser(request) {
  if (!authEnabled) return { name: "local", role: "admin" };
  return findUser(basicCredentials(request));
}

const can = (user, action) => {
  if (!user) return false;
  if (user.role === "admin") return true;
  if (action === "approve") return user.role === "approver";
  return ["buyer", "approver"].includes(user.role);
};

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  // Node's timingSafeEqual requires equal length; use it when available.
  return timingSafeEqual(ab, bb);
}

// Short-lived, single-use tokens issued to headless Chrome so the PDF
// renderer can fetch auth-protected pages without embedding credentials
// in URLs. Tokens expire quickly and are consumed on first use.
const pdfTokens = new Map();
function issuePdfToken() {
  const token = randomBytes(24).toString("hex");
  pdfTokens.set(token, Date.now() + 30_000);
  return token;
}
function tokenValid(token) {
  if (!token) return false;
  const expiry = pdfTokens.get(token);
  if (!expiry || expiry < Date.now()) {
    pdfTokens.delete(token);
    return false;
  }
  return true;
}

function extractCookie(header, name) {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx) === name) return part.slice(idx + 1);
  }
  return null;
}

function requireAuth(request, response) {
  if (!authEnabled) return true;
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const urlToken = url.searchParams.get("pdf_token");
    const cookieToken = extractCookie(request.headers.cookie, "pdf_token");
    if (tokenValid(urlToken)) {
      // Plant the token as a cookie so Chrome sends it with every
      // subresource fetch (styles.css, JS, favicon) during PDF render.
      response.setHeader("Set-Cookie", `pdf_token=${urlToken}; Path=/; HttpOnly; Max-Age=30; SameSite=Lax`);
      return true;
    }
    if (tokenValid(cookieToken)) return true;
  } catch { /* fall through */ }
  if (findUser(basicCredentials(request))) return true;
  response.writeHead(401, {
    "WWW-Authenticate": `Basic realm="${AUTH_REALM.replace(/"/g, "'")}", charset="UTF-8"`,
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Authentication required");
  return false;
}

// Locate a headless-Chrome binary. Prefers the standard macOS install; falls
// back to `chrome` / `chromium` on PATH so the endpoint also works on Linux
// hosts that have chromium installed system-wide.
function resolveChromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

async function renderPlanPdf(request, response) {
  const chrome = resolveChromePath();
  if (!chrome) {
    sendError(response, 500, "No Chrome/Chromium binary found. Set CHROME_PATH.");
    return;
  }

  const path = (new URL(request.url, `http://${request.headers.host}`).searchParams.get("path")) || "/the-plan.html";
  if (!/^\/[a-z0-9._\-\/]*$/i.test(path)) {
    sendError(response, 400, "Invalid path");
    return;
  }

  const token = authEnabled ? issuePdfToken() : null;
  const query = token ? `?pdf_token=${token}&print=1` : `?print=1`;
  const target = `http://127.0.0.1:${port}${path}${query}`;

  const workDir = await mkdtemp(join(tmpdir(), "plan-pdf-"));
  const pdfPath = join(workDir, "out.pdf");

  // Classic --headless (not =new) prints reliably on macOS Chrome; the new
  // headless mode hangs indefinitely with --print-to-pdf on this install.
  const args = [
    "--headless",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    `--user-data-dir=${workDir}/profile`,
    "--virtual-time-budget=5000",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    target,
  ];

  // stdio "ignore" on stdout: Chrome can otherwise fill the unread pipe and
  // block on write. We keep stderr piped so we can surface render errors.
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", () => {});

  // Headless Chrome writes the PDF and then keeps running on macOS; poll for
  // the output file and kill Chrome as soon as it appears, rather than waiting
  // for a graceful exit that never comes.
  const deadline = Date.now() + 25_000;
  let ready = false;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 250));
    if (existsSync(pdfPath)) {
      // Wait one more tick so Chrome finishes flushing before we read.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 300));
      ready = true;
      break;
    }
    if (child.exitCode !== null) break;
  }
  try { child.kill("SIGKILL"); } catch {}
  if (token) pdfTokens.delete(token);

  if (!ready) {
    console.error("Chrome print failed to produce PDF within 25s:", stderr.slice(0, 400));
    await rm(workDir, { recursive: true, force: true });
    sendError(response, 500, "PDF render failed");
    return;
  }

  try {
    const pdf = await readFile(pdfPath);
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": pdf.length,
      "content-disposition": 'inline; filename="datafab-agx-plan.pdf"',
      "cache-control": "no-store",
    });
    response.end(pdf);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ assistant

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const ASSISTANT_MODEL = process.env.ASSISTANT_MODEL || DEFAULT_MODEL;
const assistantRate = new Map(); // user -> recent request timestamps

let fallbackCommodities = null;
async function commodityList() {
  if (caches.commodities.payload?.commodities?.length) return caches.commodities.payload.commodities;
  if (!fallbackCommodities) {
    const context = { window: {} };
    vm.createContext(context);
    vm.runInContext(await readFile(join(root, "steel-commodities.js"), "utf8"), context);
    fallbackCommodities = context.window.STEEL_COMMODITIES?.commodities || [];
  }
  return fallbackCommodities;
}

async function callAnthropic(body) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.error?.message || response.statusText;
    const hint = response.status === 401 ? " — check ANTHROPIC_API_KEY in .env"
      : response.status === 404 ? ` — model "${body.model}" not available to this key; set ASSISTANT_MODEL`
      : response.status === 429 ? " — rate limited, try again shortly" : "";
    throw Object.assign(new Error(`Claude API ${response.status}: ${message}${hint}`), { statusCode: 502 });
  }
  return data;
}

async function handleAssistantApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  if (url.pathname === "/api/assistant/status" && request.method === "GET") {
    sendJson(response, 200, { configured: Boolean(ANTHROPIC_API_KEY), model: ASSISTANT_MODEL });
    return;
  }
  if (url.pathname !== "/api/assistant" || request.method !== "POST") return sendError(response, 404, "Not found");
  if (!ANTHROPIC_API_KEY) return sendError(response, 503, "The assistant is not set up yet: add ANTHROPIC_API_KEY to .env and restart the server.");

  const now = Date.now();
  const recent = (assistantRate.get(user.name) || []).filter((t) => now - t < 60_000);
  if (recent.length >= 20) return sendError(response, 429, "Too many questions in a minute — wait a moment.");
  recent.push(now);
  assistantRate.set(user.name, recent);

  const body = await readJsonBody(request, 200_000);
  const messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  const clean = messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 8000) }));
  while (clean.length && clean[0].role !== "user") clean.shift();
  if (!clean.length || clean[clean.length - 1].role !== "user") return sendError(response, 400, "Send a question.");

  const tradeMeasure = await loadTradeMeasure();
  const data = {
    products: async () => Promise.all((await productStore.list()).filter((p) => p.status !== "archived").map(productView)),
    scenarios: async () => (await store.list()).map(summarise),
    scenario: async (id) => store.get(String(id)),
    quotas: () => getMeasureQuotas(),
    price: (inputs) => runScenario(inputs),
    commodities: commodityList,
    categoryFor: (code) => findCategory(code, tradeMeasure.categories)?.id || null,
  };
  const result = await converse({
    messages: clean,
    callModel: callAnthropic,
    data,
    model: ASSISTANT_MODEL,
    system: systemPrompt({ today: new Date().toISOString().slice(0, 10), user: user.name }),
  });
  sendJson(response, 200, { ...result, model: ASSISTANT_MODEL });
}

// ------------------------------------------------------------ product API

const PRODUCT_LABELS = {
  name: "Description", category: "Category", spec: "Specification", commodityCode: "Commodity code",
  stockT: "Current stock (t)", stockAsOf: "Stock as of", monthlyUsageT: "Monthly usage (t)", costPerT: "Stock cost price (£/t)",
  leadTimeWeeks: "Lead time (weeks)", moqT: "MOQ (t)", safetyStockT: "Safety stock (t)", targetCoverMonths: "Cover after delivery (months)",
  targetBuyPrice: "Target buy price (£/t)", notes: "Notes",
};

function productChanges(before, after) {
  const blank = (v) => (v === undefined || v === null || v === "" ? null : v);
  const was = (k) => blank(k === "stockAsOf" ? before.stockAsOf || (before.createdAt || "").slice(0, 10) : before[k]);
  const defaults = { safetyStockT: 0, targetCoverMonths: 3 };
  return Object.keys(PRODUCT_LABELS)
    .filter((k) => k in after)
    .filter((k) => JSON.stringify(blank(after[k]) ?? defaults[k] ?? null) !== JSON.stringify(was(k) ?? defaults[k] ?? null))
    .map((k) => ({ field: k, label: PRODUCT_LABELS[k], from: before[k] ?? null, to: after[k] ?? null }));
}

async function productView(p) {
  const tradeMeasure = await loadTradeMeasure();
  const category = findCategory(p.commodityCode, tradeMeasure.categories);
  return {
    ...p,
    stockAsOf: p.stockAsOf || (p.createdAt || "").slice(0, 10) || null,
    steelCategory: category ? { id: category.id, name: category.name } : null,
    metrics: stockMetrics({ ...p, stockAsOf: p.stockAsOf || (p.createdAt || "").slice(0, 10) || undefined }),
    activity: p.activity || [],
  };
}

async function handleProductApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  const method = request.method;
  if (url.pathname === "/api/products" && method === "GET") {
    const products = (await productStore.list()).filter((p) => p.status !== "archived");
    sendJson(response, 200, { products: await Promise.all(products.map(productView)) });
    return;
  }
  if (url.pathname === "/api/products/preview" && method === "POST") {
    const { product, errors, valid } = validateProduct(await readJsonBody(request));
    const tradeMeasure = await loadTradeMeasure();
    const category = /^\d{10}$/.test(product.commodityCode) ? findCategory(product.commodityCode, tradeMeasure.categories) : null;
    const canCompute = product.stockT !== null && product.monthlyUsageT !== null && product.costPerT !== null && !errors.stockAsOf;
    return sendJson(response, 200, {
      valid,
      errors,
      steelCategory: category ? { id: category.id, name: category.name } : null,
      metrics: canCompute ? stockMetrics(product) : null,
    });
  }

  if (url.pathname === "/api/products/import" && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot add products.");
    const body = await readJsonBody(request, 500_000);
    const parsed = typeof body.text === "string" ? parseProductTable(body.text) : { rows: Array.isArray(body.rows) ? body.rows : [], columns: {}, unmatched: [] };
    if (parsed.error) return sendJson(response, 422, { ok: false, error: parsed.error });
    const existing = (await productStore.list()).filter((p) => p.status !== "archived");
    const key = (p) => p.name.trim().toLowerCase();
    const seen = new Set();
    const results = parsed.rows.slice(0, 500).map((raw, index) => {
      const { product, errors, valid } = validateProduct({ ...(body.defaults || {}), ...raw });
      const match = existing.find((p) => key(p) === key(product));
      if (seen.has(key(product))) errors.name = "Duplicate of an earlier row.";
      seen.add(key(product));
      return { index, product, errors, valid: valid && !errors.name, action: match ? "update" : "create", existingId: match?.id || null };
    });
    if (body.commit) {
      let created = 0;
      let updated = 0;
      for (const r of results.filter((x) => x.valid)) {
        if (r.existingId) {
          const current = existing.find((p) => p.id === r.existingId);
          const incoming = Object.fromEntries(Object.entries(r.product).filter(([, v]) => v !== null && v !== ""));
          const changes = productChanges(current, incoming);
          if (changes.length) {
            // eslint-disable-next-line no-await-in-loop
            await productStore.update(r.existingId, (p) => Object.assign(p, incoming), user.name, "updated by import", changes.map((c) => c.label).join(", "), { changes });
          }
          updated += 1;
        } else {
          // eslint-disable-next-line no-await-in-loop
          await productStore.create({ ...r.product, status: "active" }, user.name);
          created += 1;
        }
      }
      return sendJson(response, 200, { ok: true, created, updated, skipped: results.length - created - updated });
    }
    return sendJson(response, 200, { ok: true, columns: parsed.columns, unmatched: parsed.unmatched, results });
  }

  if (url.pathname === "/api/products" && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot add products.");
    const { product, errors, valid } = validateProduct(await readJsonBody(request));
    const clash = (await productStore.list()).find((p) => p.status !== "archived" && p.name.trim().toLowerCase() === product.name.trim().toLowerCase());
    if (clash) errors.name = "A product with this description already exists.";
    if (!valid || clash) return sendJson(response, 422, { ok: false, errors });
    const saved = await productStore.create({ ...product, status: "active" }, user.name);
    sendJson(response, 201, await productView(saved));
    return;
  }
  const match = url.pathname.match(/^\/api\/products\/([0-9a-f-]{36})(?:\/(archive))?$/);
  if (!match) return sendError(response, 404, "Not found");
  const [, id, action] = match;
  const existing = await productStore.get(id);
  if (!existing || existing.status === "archived") return sendError(response, 404, "Product not found");
  if (!action && method === "GET") return sendJson(response, 200, await productView(existing));
  if (!action && method === "PUT") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot edit products.");
    const body = await readJsonBody(request);
    const { product, errors, valid } = validateProduct(body);
    const clash = (await productStore.list()).find((p) => p.id !== id && p.status !== "archived" && p.name.trim().toLowerCase() === product.name.trim().toLowerCase());
    if (clash) errors.name = "Another product already has this description.";
    if (!valid || clash) return sendJson(response, 422, { ok: false, errors });
    const changes = productChanges(existing, product);
    const catalogChanged = "catalog" in product && JSON.stringify(product.catalog ?? null) !== JSON.stringify(existing.catalog ?? null);
    if (!changes.length && !catalogChanged) return sendJson(response, 200, await productView(existing));
    if (!changes.length) {
      const linked = await productStore.update(id, (p) => { p.catalog = product.catalog; }, user.name, "linked to catalogue", product.catalog ? product.catalog.family : "unlinked");
      return sendJson(response, 200, await productView(linked));
    }
    const stockOnly = changes.every((c) => ["stockT", "stockAsOf"].includes(c.field));
    const saved = await productStore.update(id, (p) => Object.assign(p, product), user.name,
      stockOnly ? "stock updated" : "edited", changes.map((c) => c.label).join(", "), { changes });
    return sendJson(response, 200, await productView(saved));
  }
  if (action === "archive" && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot archive products.");
    await productStore.update(id, (p) => { p.status = "archived"; }, user.name, "archived");
    return sendJson(response, 200, { ok: true });
  }
  sendError(response, 405, "Method not allowed");
}

// ------------------------------------------------------------ settings API

async function handleSettingsApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  if (url.pathname === "/api/settings" && request.method === "GET") {
    return sendJson(response, 200, { settings: await settingsStore.get(), catalogueGroups: CATALOGUE_GROUPS, canEdit: can(user, "edit") });
  }
  if (url.pathname === "/api/settings" && request.method === "PUT") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot change settings.");
    const { settings, errors, valid } = validateSettings(await readJsonBody(request), await settingsStore.get());
    if (!valid) return sendJson(response, 422, { ok: false, errors });
    return sendJson(response, 200, { settings: await settingsStore.save(settings, user.name) });
  }
  if (url.pathname === "/api/backup" && request.method === "GET") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot download backups.");
    const body = JSON.stringify({
      exportedAt: new Date().toISOString(), exportedBy: user.name,
      settings: await settingsStore.get(), products: await productStore.list(), scenarios: await store.list(),
    }, null, 2);
    response.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="agx-order-tool-backup-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    });
    return response.end(body);
  }
  sendError(response, 404, "Not found");
}

// ------------------------------------------------------------ scenario API

async function readJsonBody(request, limit = 100_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Request body too large"), { statusCode: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Body must be JSON"), { statusCode: 400 });
  }
}

function summarise(s) {
  const r = s.result || {};
  return {
    id: s.id,
    title: s.inputs.title || r.inputs?.commodityDescription || s.inputs.commodityCode,
    commodityCode: s.inputs.commodityCode,
    commodityDescription: s.inputs.commodityDescription,
    categoryId: r.category?.id || null,
    supplier: s.inputs.supplier,
    mill: s.inputs.mill,
    origin: s.inputs.origin,
    incoterm: s.inputs.incoterm,
    tonnage: s.inputs.tonnage,
    importDate: s.inputs.importDate,
    quoteValidUntil: s.inputs.quoteValidUntil,
    expectedPerT: r.totals?.expectedPerT ?? null,
    expectedTotal: r.totals?.expectedTotal ?? null,
    quotaProbability: r.quota ? r.quota.probability : null,
    quotaMatched: r.quota ? r.quota.matched : null,
    quotaOrderNumber: r.quota?.orderNumber || null,
    status: s.status,
    demo: Boolean(s.demo),
    sample: Boolean(r.sources?.sample),
    createdBy: s.createdBy,
    updatedAt: s.updatedAt,
    calculatedAt: r.sources?.calculatedAt || null,
  };
}

const csvCell = (v) => {
  const text = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(text) || /^[=+\-@]/.test(text) ? `"${text.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : text;
};

const STATUS_FLOW = {
  submit: { from: ["draft", "rejected"], to: "submitted", role: "edit" },
  approve: { from: ["submitted"], to: "approved", role: "approve" },
  reject: { from: ["submitted"], to: "rejected", role: "approve" },
  reopen: { from: ["approved", "rejected", "submitted"], to: "draft", role: "edit" },
  archive: { from: ["draft", "rejected", "approved", "submitted"], to: "archived", role: "edit" },
};

async function handleScenarioApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  const method = request.method;
  const path = url.pathname;

  if (path === "/api/steel-quotas/live" && method === "GET") {
    const data = await getMeasureQuotas({ force: url.searchParams.get("refresh") === "1" });
    const { rows, ...rest } = data;
    sendJson(response, 200, rest);
    return;
  }

  if (path === "/api/health" && method === "GET") {
    sendJson(response, 200, { ok: true, app: "steel-order-tool", engineVersion: ENGINE_VERSION, root, startedAt: STARTED_AT, tariffAccess: tariffAuthMode, tariffSignIn: tariffAuthStatus });
    return;
  }

  if (path === "/api/tariff-auth-check" && method === "GET") {
    if (tariffAuthMode !== "registered") {
      sendJson(response, 200, { mode: "public", message: "No HMRC credentials loaded. Start with: node --env-file=.env server.mjs" });
      return;
    }
    tariffToken.value = "";
    tariffToken.expiresAt = 0;
    tariffAuthStatus.ok = null;
    const header = await tariffAuthHeader();
    let apiTest = null;
    if (header) {
      try {
        const defs = await fetchTariffQuota("058600", new Date().toISOString().slice(0, 10));
        apiTest = { ok: true, linesReturned: defs.length };
      } catch (error) {
        apiTest = { ok: false, error: error.message };
      }
    }
    sendJson(response, 200, { mode: "registered", signIn: tariffAuthStatus, quotaApiTest: apiTest });
    return;
  }

  if (path === "/api/me" && method === "GET") {
    sendJson(response, 200, { ...user, authEnabled, canApprove: can(user, "approve"), canEdit: can(user, "edit") });
    return;
  }

  if (path === "/api/options" && method === "GET") {
    sendJson(response, 200, { origins: ORIGINS, incoterms: INCOTERMS, currencies: CURRENCIES, engineVersion: ENGINE_VERSION });
    return;
  }

  if (path === "/api/data-status" && method === "GET") {
    sendJson(response, 200, {
      quotasFetchedAt: measureCache.payload?.fetchedAt || caches.quotas.payload?.liveFetchedAt || null,
      quotaSource: measureCache.payload ? (measureCache.payload.sources.tariff.lines ? "HMRC Trade Tariff" : "DBT dataset") : null,
      commoditiesFetchedAt: caches.commodities.payload?.liveFetchedAt || null,
      quotaCacheSeconds: 600,
    });
    return;
  }

  if (path === "/api/sample-data" && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create scenarios.");
    const existing = (await store.list()).filter((s) => s.demo);
    const outdated = existing.filter((s) => String(s.result?.quota?.orderNumber || "").startsWith("SAMPLE-"));
    if (existing.length && !outdated.length) return sendJson(response, 200, { created: 0, message: "Sample scenarios are already loaded." });
    for (const old of existing) {
      // eslint-disable-next-line no-await-in-loop
      await store.update(old.id, (s) => { s.status = "archived"; }, user.name, "archived", "Replaced by updated sample scenarios");
    }
    const tradeMeasure = await loadTradeMeasure();
    const records = buildSampleRecords(tradeMeasure.categories, new Date().toISOString().slice(0, 10));
    for (const record of records) {
      const { activity, ...data } = record;
      // eslint-disable-next-line no-await-in-loop
      const saved = await store.create(data, "sam");
      for (const entry of activity) {
        // eslint-disable-next-line no-await-in-loop
        await store.update(saved.id, () => {}, entry.by, entry.action, entry.detail);
      }
    }
    sendJson(response, 201, { created: records.length });
    return;
  }

  if (path === "/api/calculate" && method === "POST") {
    const body = await readJsonBody(request);
    const result = await runScenario(body.inputs || body);
    sendJson(response, result.ok ? 200 : 422, result);
    return;
  }

  if (path === "/api/scenarios.csv" && method === "GET") {
    const rows = (await store.list()).map(summarise);
    const cols = ["id", "title", "commodityCode", "supplier", "origin", "incoterm", "tonnage", "importDate", "expectedPerT", "expectedTotal", "quotaProbability", "status", "createdBy", "updatedAt"];
    const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
    response.writeHead(200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="order-scenarios.csv"',
      ...corsHeaders(request),
      "cache-control": "no-store",
    });
    response.end(csv);
    return;
  }

  if (path === "/api/scenarios" && method === "GET") {
    const rows = (await store.list()).map(summarise).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    sendJson(response, 200, { scenarios: rows });
    return;
  }

  if (path === "/api/scenarios" && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create scenarios.");
    const body = await readJsonBody(request);
    const result = await runScenario(body.inputs || {});
    if (!result.ok) return sendJson(response, 422, result);
    const saved = await store.create({ inputs: result.inputs, result }, user.name);
    sendJson(response, 201, saved);
    return;
  }

  const match = path.match(/^\/api\/scenarios\/([0-9a-f-]{36})(?:\/(duplicate|status|recalculate))?$/);
  if (!match) return sendError(response, 404, "Not found");
  const [, id, action] = match;
  const existing = await store.get(id);
  if (!existing) return sendError(response, 404, "Scenario not found");

  if (!action && method === "GET") {
    sendJson(response, 200, existing);
    return;
  }

  if (!action && method === "PUT") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot edit scenarios.");
    const body = await readJsonBody(request);
    const result = await runScenario(body.inputs || {});
    if (!result.ok) return sendJson(response, 422, result);
    const changed = Object.keys(result.inputs).filter((k) => JSON.stringify(result.inputs[k]) !== JSON.stringify(existing.inputs[k]));
    const detail = changed.slice(0, 6).map((k) => `${k}: ${existing.inputs[k] ?? "—"} → ${result.inputs[k] ?? "—"}`).join("; ");
    const wasLocked = ["submitted", "approved"].includes(existing.status);
    const saved = await store.update(id, (s) => {
      s.inputs = result.inputs;
      s.result = result;
      if (wasLocked) s.status = "draft";
    }, user.name, wasLocked ? "edited (moved back to draft)" : "edited", detail);
    sendJson(response, 200, saved);
    return;
  }

  if (action === "recalculate" && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot edit scenarios.");
    const result = await runScenario(existing.inputs);
    if (!result.ok) return sendJson(response, 422, result);
    const before = existing.result?.totals?.expectedPerT;
    const saved = await store.update(id, (s) => { s.result = result; }, user.name, "recalculated with latest data",
      `£${before ?? "—"}/t → £${result.totals.expectedPerT}/t`);
    sendJson(response, 200, saved);
    return;
  }

  if (action === "duplicate" && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create scenarios.");
    const inputs = { ...existing.inputs, title: `${existing.inputs.title || existing.inputs.commodityCode} (alternative)` };
    const result = await runScenario(inputs);
    const saved = await store.create({ inputs: result.ok ? result.inputs : inputs, result: result.ok ? result : existing.result, createdFrom: existing.id }, user.name);
    sendJson(response, 201, saved);
    return;
  }

  if (action === "status" && method === "POST") {
    const body = await readJsonBody(request);
    const step = STATUS_FLOW[body.action];
    if (!step) return sendError(response, 400, "Unknown status action");
    if (!can(user, step.role)) return sendError(response, 403, "Your account cannot do that.");
    if (!step.from.includes(existing.status)) return sendError(response, 409, `Cannot ${body.action} a ${existing.status} scenario.`);
    if (body.action === "approve" && existing.createdBy === user.name && user.role !== "admin") {
      return sendError(response, 403, "Someone other than the creator must approve.");
    }
    const note = String(body.note || "").slice(0, 500);
    const saved = await store.update(id, (s) => { s.status = step.to; }, user.name, step.to, note);
    sendJson(response, 200, saved);
    return;
  }

  sendError(response, 405, "Method not allowed");
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }

    if (!requireAuth(request, response)) return;

    if (url.pathname === "/api/steel-commodities") {
      sendJson(response, 200, await getSteelCommodities());
      return;
    }

    if (url.pathname === "/api/steel-quotas") {
      sendJson(response, 200, await getSteelQuotaRows());
      return;
    }

    if (url.pathname === "/api/quota-check") {
      const result = await quotaCheck(url);
      sendJson(response, result.statusCode, result.payload);
      return;
    }

    if (url.pathname.startsWith("/api/assistant")) {
      await handleAssistantApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/products")) {
      await handleProductApi(request, response, url);
      return;
    }

    if (url.pathname === "/api/settings" || url.pathname === "/api/backup") {
      await handleSettingsApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/scenarios") || ["/api/calculate", "/api/me", "/api/options", "/api/data-status", "/api/sample-data", "/api/health", "/api/steel-quotas/live", "/api/tariff-auth-check"].includes(url.pathname)) {
      await handleScenarioApi(request, response, url);
      return;
    }

    if (url.pathname === "/api/plan.pdf") {
      await renderPlanPdf(request, response);
      return;
    }

    await serveStatic(url, response);
  } catch (error) {
    if (error.statusCode) {
      sendError(response, error.statusCode, error.message);
      return;
    }
    console.error(error);
    sendError(response, 500, "Unexpected server error");
  }
});

// Bind to 0.0.0.0 in production (Render/Fly/etc need external reachability);
// keep local dev on 127.0.0.1 to avoid announcing the dev server on the LAN.
const bindHost = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`\nPort ${port} is already in use — an older copy of the server is probably still running.`);
    console.error(`Stop it with:  lsof -ti :${port} | xargs kill`);
    console.error("then run node server.mjs again (or start on another port: PORT=3001 node server.mjs).\n");
    process.exit(1);
  }
  throw error;
});

server.listen(port, bindHost, () => {
  console.log(`Steel ARB live app running at http://${bindHost}:${port}`);
  console.log(`Order tool:   http://${bindHost}:${port}/orders.html   (engine v${ENGINE_VERSION}, from ${root})`);
  console.log(`HMRC Trade Tariff access: ${tariffAuthMode === "registered" ? "registered credentials loaded" : "public (no credentials)"}`);
  console.log(`Assistant: ${ANTHROPIC_API_KEY ? `ready (${ASSISTANT_MODEL})` : "not set up — add ANTHROPIC_API_KEY to .env"}`);
});
