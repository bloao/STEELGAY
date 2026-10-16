import { createServer } from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, dirname } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual, randomUUID } from "node:crypto";
import { calculate, validateInputs, findCategory, originMatches, ENGINE_VERSION, ORIGINS, INCOTERMS, CURRENCIES } from "./lib/calc.mjs";
import { createStore } from "./lib/store.mjs";
import { ORDER_LINES, MEASURE, isMeasureOrderNumber, quarterFor } from "./lib/steel-measure.mjs";
import { parseTariffQuotas, toCalcRow, mergeDefinitions, buildLines } from "./lib/quota-feed.mjs";
import { SEED_PRODUCTS, validateProduct, stockMetrics, parseProductTable } from "./lib/products.mjs";
import { quotaHistory, lineProfile } from "./lib/quota-history.mjs";
import { createFeedManager } from "./lib/feeds.mjs";
import { buildSchema } from "./lib/data-schema.mjs";
import { planPackages } from "./lib/package.mjs";
import { planBasket } from "./lib/basket.mjs";
import { createSettingsStore, validateSettings, publicSettings, CATALOGUE_GROUPS, PLAN_ASSUMPTION_KEYS, ASSUMPTION_LIMITS, SETTINGS_DEFAULTS, UK_CBAM } from "./lib/settings.mjs";
import * as LIVE from "./lib/live-feeds.mjs";
import * as SUP from "./lib/suppliers.mjs";
import * as BM from "./lib/benchmarks.mjs";
import { feedConfig, fetchFeed, FEED_SOURCES } from "./lib/benchmark-feed.mjs";
import * as NEWS from "./lib/news.mjs";
import * as FC from "./lib/forecast.mjs";
import * as COMP from "./lib/competition.mjs";
import * as ARR from "./lib/arrivals.mjs";
import * as STOCK from "./lib/stockpile.mjs";
import * as PLAN from "./lib/orderplan.mjs";
import { converse, systemPrompt, DEFAULT_MODEL, PROVIDERS, toOpenAI, fromOpenAI, pickModel, FREE_LIMITS } from "./lib/assistant.mjs";
import { gzipSync } from "node:zlib";
import vm from "node:vm";

const port = Number(process.env.PORT || 3000);
const root = process.cwd();
const STARTED_AT = new Date().toISOString();
const store = createStore(process.env.DATA_DIR || join(root, "var"));
const supplierStore = createStore(process.env.DATA_DIR || join(root, "var"), "suppliers.json", () => SUP.seedSuppliers());
const benchmarkStore = createStore(process.env.DATA_DIR || join(root, "var"), "benchmarks.json");
const newsStore = createStore(process.env.DATA_DIR || join(root, "var"), "news-notes.json");
const competitorStore = createStore(process.env.DATA_DIR || join(root, "var"), "competitors.json");
const shipmentStore = createStore(process.env.DATA_DIR || join(root, "var"), "shipments.json");
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
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
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

async function getSteelCommodities({ force = false } = {}) {
  const now = Date.now();

  if (!force && caches.commodities.payload && caches.commodities.expiresAt > now) {
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

async function getSteelQuotaRows({ force = false } = {}) {
  const now = Date.now();

  if (!force && caches.quotas.payload && caches.quotas.expiresAt > now) {
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

// Past pace of use per line (t/day), cached for the engine.
let paceCache = { at: 0, map: new Map() };
async function cachedQuotaPace() {
  if (Date.now() - paceCache.at < 10 * 60_000) return paceCache.map;
  try {
    const h = await steelQuotaHistory();
    paceCache = { at: Date.now(), map: new Map(h.lines.filter((l) => l.paceT > 0).map((l) => [l.orderNumber, l.paceT])) };
  } catch { paceCache = { at: Date.now() - 9 * 60_000, map: paceCache.map }; } // retry in a minute
  return paceCache.map;
}

// Past quarters for every line (DBT dataset, from 2021), with an outlook for this quarter.
async function steelQuotaHistory() {
  const [dbt, live] = await Promise.all([getSteelQuotaRows(), getMeasureQuotas()]);
  const asOf = new Date().toISOString().slice(0, 10);
  const tm = await loadTradeMeasure();
  const h = quotaHistory(dbt.rows, live.lines, asOf);
  const names = new Map(tm.categories.map((c) => [c.id, c.name]));
  const { byLine, ...rest } = h;
  return { ok: true, ...rest, source: { name: "DBT UK trade quotas dataset", url: dbt.sourceUrl, fetchedAt: dbt.liveFetchedAt }, liveFetchedAt: live.fetchedAt,
    lines: h.lines.map((l) => ({ ...l, categoryName: names.get(l.categoryId) || `Category ${l.categoryId}` })), periods: byLine };
}

// One quota line in full: analysis, every past quarter, and what it means for you.
async function quotaLineProfile(orderNumber) {
  const h = await steelQuotaHistory();
  const line = h.lines.find((l) => l.orderNumber === orderNumber);
  if (!line) return null;
  const live = (await getMeasureQuotas()).lines.find((l) => l.orderNumber === orderNumber) || null;
  const products = (await Promise.all((await productStore.list()).filter((p) => p.status !== "archived").map(productView))).filter((p) => p.steelCategory && p.steelCategory.id === line.categoryId);
  const named = ORDER_LINES.filter((l) => l.categoryId === line.categoryId && !l.residual).map((l) => l.origin);
  const EU = ["France", "Germany", "Italy", "Spain", "Netherlands", "Belgium", "Poland", "Portugal", "Austria", "Czechia", "Sweden", "Finland", "Ireland", "Greece", "Romania", "Slovakia", "Slovenia", "Hungary", "Luxembourg", "Denmark", "Croatia", "Bulgaria", "Lithuania", "Latvia", "Estonia", "Cyprus", "Malta"];
  const lineOrigin = (o) => { if (!o || o === "UK") return null; const x = EU.includes(o) ? "European Union" : o === "Korea" ? "South Korea" : o; return named.includes(x) ? x : "Residual"; };
  const groups = new Set(products.map((p) => p.category));
  const suppliers = (await supplierStore.list()).filter((s) => s.status !== "archived" && lineOrigin(s.origin) === line.origin && (s.supplies || []).some((g) => groups.has(g)))
    .map((s) => ({ id: s.id, name: s.name, origin: s.origin }));
  const scenarios = (await store.list()).map(summarise).filter((x) => x.quotaOrderNumber === orderNumber)
    .map((x) => ({ id: x.id, title: x.title, tonnage: x.tonnage, importDate: x.importDate, status: x.status, afterSafe: Boolean(line.outlook && line.outlook.safeUntil && x.importDate > line.outlook.safeUntil) }));
  return { ok: true, asOf: h.asOf, since: h.since, source: h.source, line: lineProfile(line, h.periods.get(orderNumber) || []), live, products: products.map((p) => ({ id: p.id, name: p.name })), suppliers, scenarios };
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
async function runScenario(rawInputs, engineSettings = {}) {
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
    jobs.push(Promise.all([getMeasureQuotas(), cachedQuotaPace()]).then(([q, pace]) => {
      // each quota row also carries the pace of use from past quarters, so the
      // run-out risk isn't judged on this quarter's first few days alone
      market.quotaRows = q.rows.map((r) => (pace.has(r.orderNumber) ? { ...r, historicBurnPerDayT: pace.get(r.orderNumber) } : r));
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

  const result = calculate(inputs, market, { asOf: new Date().toISOString().slice(0, 10), settings: engineSettings });
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
  const pathname = requestUrl.pathname === "/" ? "/assistant.html" : requestUrl.pathname; // the assistant is the home page
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root) || isPrivatePath(safePath)) {
    sendError(response, 404, "Not found");
    return;
  }

  try {
    const body = await readFile(filePath);
    const contentType = mimeTypes[extname(filePath)] || "application/octet-stream";
    // Browsers re-check static files on every load so updates show at once.
    writeBody(response, 200, {
      "content-type": contentType,
      "cache-control": "no-cache",
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

// Which model answers: Claude if there's a key, otherwise a free option —
// Groq or Gemini with a free key (in .env or Settings), or Ollama running on
// this computer. LLM_PROVIDER or Settings → Assistant can pick one.
let ollamaCache = { at: 0, value: null };
async function ollamaStatus(base = process.env.OLLAMA_URL || "http://localhost:11434") {
  if (Date.now() - ollamaCache.at < 15_000 && ollamaCache.value) return ollamaCache.value;
  let value = { running: false, models: [] };
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1200) });
    if (r.ok) { const j = await r.json(); value = { running: true, models: (j.models || []).map((m) => m.name) }; }
  } catch { /* not running */ }
  ollamaCache = { at: Date.now(), value };
  return value;
}
async function assistantConfig() {
  const ws = await settingsStore.get();
  const keys = { anthropic: ANTHROPIC_API_KEY, groq: process.env.GROQ_API_KEY || ws.groqApiKey || "", gemini: process.env.GEMINI_API_KEY || ws.geminiApiKey || "" };
  const ollama = await ollamaStatus();
  const ollamaModel = process.env.OLLAMA_MODEL || ws.ollamaModel || PROVIDERS.ollama.model;
  let provider = process.env.LLM_PROVIDER || ws.assistantProvider || "auto";
  if (provider === "auto") provider = keys.anthropic ? "anthropic" : keys.groq ? "groq" : keys.gemini ? "gemini" : ollama.running ? "ollama" : null;
  const p = provider ? PROVIDERS[provider] : null;
  const found = provider ? modelCache.get(`${provider}|${String(keys[provider] || "").slice(-6)}`) : null;
  const model = provider === "anthropic" ? ASSISTANT_MODEL : provider === "ollama" ? ollamaModel : process.env.ASSISTANT_MODEL && process.env.LLM_PROVIDER === provider ? process.env.ASSISTANT_MODEL : found || (p && p.model);
  const hasOllamaModel = ollama.models.some((m) => m === ollamaModel || m.split(":")[0] === ollamaModel.split(":")[0] && !ollamaModel.includes(":"));
  const configured = provider === "ollama" ? ollama.running && hasOllamaModel : Boolean(provider && keys[provider]);
  return { provider, label: p ? p.label : null, model, key: provider ? keys[provider] : "", configured, ollama: { ...ollama, model: ollamaModel, hasModel: hasOllamaModel } };
}
const modelCache = new Map(); // `${provider}|${key tail}` → model id this key can use
const providerUsage = new Map(); // provider → latest rate-limit headers (free-tier allowance left)
async function discoverModel(cfg, base) {
  const ck = `${cfg.provider}|${String(cfg.key).slice(-6)}`;
  if (modelCache.has(ck)) return modelCache.get(ck);
  const r = await fetch(`${base}/models`, { headers: cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}, signal: AbortSignal.timeout(10_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(`${PROVIDERS[cfg.provider].label} ${r.status}: ${j?.error?.message || r.statusText}${r.status === 401 || r.status === 403 ? " — check the API key" : ""}`), { statusCode: 502 });
  const model = pickModel(cfg.provider, (j.data || j.models || []).map((m) => m.id || m.name));
  if (!model) throw Object.assign(new Error(`${PROVIDERS[cfg.provider].label}: no chat model available to this key`), { statusCode: 502 });
  modelCache.set(ck, model);
  return model;
}
function callOpenAICompatible(cfg) {
  const base = cfg.provider === "ollama" ? `${(process.env.OLLAMA_URL || "http://localhost:11434").replace(/\/$/, "")}/v1` : PROVIDERS[cfg.provider].baseUrl;
  const fixedModel = cfg.provider === "ollama" || (process.env.ASSISTANT_MODEL && process.env.LLM_PROVIDER === cfg.provider);
  return async (body, retried = false) => {
    if (!fixedModel) body = { ...body, model: await discoverModel(cfg, base) };
    cfg.model = body.model;
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cfg.key ? { authorization: `Bearer ${cfg.key}` } : {}) },
      body: JSON.stringify(toOpenAI(body)),
      signal: AbortSignal.timeout(cfg.provider === "ollama" ? 180_000 : 90_000),
    });
    const h = (n) => response.headers.get(n);
    if (h("x-ratelimit-limit-requests")) providerUsage.set(cfg.provider, { limitRequests: Number(h("x-ratelimit-limit-requests")), remainingRequests: Number(h("x-ratelimit-remaining-requests")), limitTokens: Number(h("x-ratelimit-limit-tokens")) || null, remainingTokens: Number(h("x-ratelimit-remaining-tokens")) || null, at: new Date().toISOString() });
    // free-tier minute limit: wait as told (if short) and try once more
    if (response.status === 429 && !retried) {
      const wait = Math.ceil(Number(h("retry-after")) || 0);
      if (wait > 0 && wait <= 20) { await new Promise((r) => setTimeout(r, wait * 1000)); return callOpenAICompatible(cfg)(body, true); }
    }
    const data = await response.json().catch(() => ({}));
    if (response.status === 404 && !fixedModel && !retried) { modelCache.delete(`${cfg.provider}|${String(cfg.key).slice(-6)}`); return callOpenAICompatible(cfg)(body, true); }
    if (!response.ok) {
      const message = data?.error?.message || (Array.isArray(data) ? data[0]?.error?.message : "") || response.statusText;
      const hint = response.status === 401 || response.status === 403 ? " — check the API key" : response.status === 404 ? ` — model "${body.model}" not found` : response.status === 429 ? " — free-tier limit reached; it resets within a minute (or tomorrow for the daily limit)" : response.status === 413 ? " — question too large for the free tier; ask something narrower" : "";
      throw Object.assign(new Error(`${PROVIDERS[cfg.provider].label} ${response.status}: ${message}${hint}`), { statusCode: 502 });
    }
    return fromOpenAI(data);
  };
}
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
    const cfg = await assistantConfig();
    sendJson(response, 200, { configured: cfg.configured, provider: cfg.provider, label: cfg.label, model: cfg.model, ollama: cfg.ollama, canEdit: can(user, "edit"), free: ["groq", "gemini", "ollama"].includes(cfg.provider), usage: providerUsage.get(cfg.provider) || null });
    return;
  }
  if (url.pathname !== "/api/assistant" || request.method !== "POST") return sendError(response, 404, "Not found");
  const cfg = await assistantConfig();
  if (!cfg.configured) return sendError(response, 503, cfg.provider === "ollama" ? `Ollama is running but the model isn't downloaded: run "ollama pull ${cfg.ollama.model}".` : "The assistant is not set up yet: see the setup steps on the Assistant page.");

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
    suppliers: async () => (await supplierStore.list()).filter((x) => x.status !== "archived").map(supplierView),
    scenarios: async () => (await store.list()).map(summarise),
    scenario: async (id) => store.get(String(id)),
    quotas: () => getMeasureQuotas(),
    price: (inputs) => runScenario(inputs),
    plan: (body) => orderPlan(body),
    quotaHistory: () => steelQuotaHistory(),
    commodities: commodityList,
    categoryFor: (code) => findCategory(code, tradeMeasure.categories)?.id || null,
  };
  const result = await converse({
    messages: clean,
    callModel: cfg.provider === "anthropic" ? callAnthropic : callOpenAICompatible(cfg),
    limits: cfg.provider === "groq" || cfg.provider === "gemini" ? FREE_LIMITS : null,
    data,
    model: cfg.model,
    system: systemPrompt({ today: new Date().toISOString().slice(0, 10), user: user.name }),
  });
  sendJson(response, 200, { ...result, model: cfg.model, provider: cfg.provider, usageLeft: providerUsage.get(cfg.provider) || null });
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

// Smallest load any active supplier of this product will sell (their MOQ)
async function supplierMoqFor(p) {
  const sups = (await supplierStore.list()).filter((x) => x.status !== "archived" && x.standing !== "hold" && (x.supplies || []).includes(p.category) && Number(x.moqMinT) > 0);
  return sups.length ? Math.min(...sups.map((x) => Number(x.moqMinT))) : 0;
}

async function productView(p) {
  const tradeMeasure = await loadTradeMeasure();
  const category = findCategory(p.commodityCode, tradeMeasure.categories);
  const supplierMoqT = await supplierMoqFor(p);
  return {
    ...p,
    stockAsOf: p.stockAsOf || (p.createdAt || "").slice(0, 10) || null,
    steelCategory: category ? { id: category.id, name: category.name } : null,
    metrics: stockMetrics({ ...p, supplierMoqT, stockAsOf: p.stockAsOf || (p.createdAt || "").slice(0, 10) || undefined }),
    activity: p.activity || [],
  };
}


// ------------------------------------------------------------ stockpiling ranking
let catalogueCache = null;
async function steelCatalogue() {
  if (catalogueCache) return catalogueCache;
  const context = { window: {} };
  vm.createContext(context);
  for (const f of ["steel-commodities.js", "steel-trade-measure.js", "steel-catalogue.js"]) vm.runInContext(await readFile(join(root, f), "utf8"), context);
  catalogueCache = context.window.STEEL_CATALOGUE;
  return catalogueCache;
}
async function stockpileView() {
  const CAT = await steelCatalogue().catch(() => null);
  const list = (await productStore.list()).filter((p) => p.status !== "archived");
  const products = list.map((p) => {
    const m = stockMetrics({ ...p, stockAsOf: p.stockAsOf || (p.createdAt || "").slice(0, 10) || undefined });
    let family = p.catalog && p.catalog.family;
    if (!family && CAT && CAT.match) { const hit = CAT.match(p.name, p.commodityCode); family = hit && hit.family; }
    return { id: p.id, name: p.name, category: p.category, commodityCode: p.commodityCode, monthlyUsageT: p.monthlyUsageT, stockT: m.stockNowT, versatility: Number.isFinite(p.versatility) ? p.versatility : null, family };
  });
  const data = await getCompData();
  const months = COMP.monthsList(Object.keys(data.importerMonths), 12);
  const ons = (await liveSeries()).find((x) => x.feedKey === "ons:GHAV");
  const onsVol = ons ? FC.stdev(FC.logReturns(FC.monthly(ons.points || []).slice(-25))) * 100 : null;
  const rows = STOCK.scoreProducts(products, { trade: data.trade, companies: months.length ? data.companies : null, months, summary: data.summary, marketVolPct: onsVol });
  return { rows, weights: STOCK.WEIGHTS, families: Object.fromEntries(Object.entries(STOCK.FAMILY_VERSATILITY).map(([k, v]) => [k, v[1]])),
    sources: { tradeMonths: Object.keys(data.trade || {}).length, importerMonths: months.length, summaryCompanies: (data.summary || []).length, onsVolPct: onsVol } };
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
  if (url.pathname === "/api/products/stockpile" && method === "GET") return sendJson(response, 200, await stockpileView());
  const vers = url.pathname.match(/^\/api\/products\/([0-9a-f-]{36})\/versatility$/);
  if (vers && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot edit products.");
    const body = await readJsonBody(request);
    const v = body.score === null || body.score === "" ? null : Number(body.score);
    if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 5)) return sendJson(response, 422, { ok: false, error: "Use 1 to 5." });
    const saved = await productStore.update(vers[1], (p) => { if (v === null) delete p.versatility; else p.versatility = v; }, user.name, "versatility set", v === null ? "reset to catalogue" : `${v}/5`);
    return sendJson(response, 200, { ok: true, versatility: saved.versatility ?? null });
  }
  if (url.pathname === "/api/products/market" && method === "POST") {
    // best landed price now for every product (for the products list)
    const body = await readJsonBody(request);
    const list = (await productStore.list()).filter((p) => p.status !== "archived");
    const out = {};
    await Promise.all(list.map(async (p) => {
      const rows = (await compareSuppliers({ ...body, productId: p.id, arrival: "lead" })).filter((r) => Number.isFinite(r.effectivePerT));
      out[p.id] = rows.length ? { bestPerT: rows[0].effectivePerT, supplier: rows[0].name, supplierId: rows[0].id, suppliers: rows.length, costPerT: p.costPerT } : { bestPerT: null, suppliers: 0, costPerT: p.costPerT };
    }));
    return sendJson(response, 200, { products: out });
  }
  const mkt = url.pathname.match(/^\/api\/products\/([0-9a-f-]{36})\/market$/);
  if (mkt && method === "POST") {
    const p = await productStore.get(mkt[1]);
    if (!p || p.status === "archived") return sendError(response, 404, "Product not found");
    return sendJson(response, 200, await productMarket(p, await readJsonBody(request)));
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

// ------------------------------------------------------------ supplier API

const SUPPLIER_LABELS = {
  name: "Name", type: "Type", standing: "Standing", origin: "Origin", supplies: "Supplies", pricingSources: "Pricing sources",
  priceCovers: "Price covers", deliveryTerms: "Delivery terms", onTimePct: "On-time %", moqMinT: "MOQ min (t)", moqMaxT: "MOQ max (t)",
  moqNote: "MOQ note", ddp: "DDP available", paymentDays: "Payment terms (days)", paymentNote: "Payment note", currency: "Currency",
  leadTimeMin: "Lead time min", leadTimeMax: "Lead time max", leadTimeUnit: "Lead time unit", transport: "Transport",
  dutyCosts: "Duty costs", otherDuty: "Other duty", dutyRiskNote: "Duty risk note", productionRoute: "Production route", emissionsPerT: "Verified emissions (t CO₂e/t)", carbonPricePaidPerT: "Carbon price paid abroad", website: "Website", notes: "Notes",
};

// Bring suppliers seeded before the latest supplier sheet up to date
// (fills empty / untouched fields only; each change is in the audit trail).
async function applySupplierSheet() {
  for (const sup of await supplierStore.list()) {
    if (sup.status === "archived") continue;
    const changes = SUP.sheetUpdates(sup);
    if (!changes.length) continue;
    await supplierStore.update(sup.id, (x) => {
      for (const c of changes) x[c.field] = c.to;
      x.sheetVersion = SUP.SHEET_VERSION;
    }, "setup", "updated from supplier sheet", changes.map((c) => SUPPLIER_LABELS[c.field] || c.field).join(", "),
    { changes: changes.map((c) => ({ ...c, label: SUPPLIER_LABELS[c.field] || c.field })) });
  }
}

function supplierChanges(before, after) {
  const norm = (v) => (v === undefined || v === null || v === "" || (Array.isArray(v) && !v.length) ? null : v);
  return Object.keys(SUPPLIER_LABELS).filter((k) => k in after)
    .filter((k) => JSON.stringify(norm(after[k])) !== JSON.stringify(norm(before[k])))
    .map((k) => ({ field: k, label: SUPPLIER_LABELS[k], from: before[k] ?? null, to: after[k] ?? null }));
}

const supplierView = (s) => ({ ...s, contacts: s.contacts || [], quotes: s.quotes || [], rfqs: s.rfqs || [], activity: s.activity || [], metrics: SUP.supplierMetrics(s) });

const SUPPLIER_CHOICES = {
  types: SUP.SUPPLIER_TYPES, standing: SUP.SUPPLIER_STANDING, pricingSources: SUP.PRICING_SOURCES, priceCovers: SUP.PRICE_COVERS,
  deliveryTerms: SUP.DELIVERY_TERMS, ddp: SUP.DDP_OPTIONS, currencies: SUP.CURRENCIES, quoteChannels: SUP.QUOTE_CHANNELS,
  origins: SUP.ORIGINS, euMembers: [...SUP.EU_MEMBERS], groups: CATALOGUE_GROUPS,
};


// Landed cost of buying one product from one supplier: the order engine
// (price, freight, duty, steel-measure quota risk, CBAM …) plus the
// supplier-specific variables — payment terms, MOQ and reliability.
const engineOrigin = (o) => (o === "UK" ? "United Kingdom" : SUP.EU_MEMBERS.has(o) ? "European Union" : ORIGINS.includes(o) ? o : "Other non-UK");
const engineIncoterm = (s) => ({ "Delivered to depot": "DAP", DDP: "DDP", DAP: "DAP", CPT: "CPT", CFR: "CFR", CIF: "CIF", FCA: "FCA", FOB: "FOB", EXW: "EXW" })[s.deliveryTerms]
  || (s.priceCovers === "everything" ? "DDP" : s.priceCovers === "ex-works" ? "EXW" : "DAP");
const addDaysIso = (iso, d) => new Date(Date.parse(`${iso}T00:00:00Z`) + Math.round(d) * 86_400_000).toISOString().slice(0, 10);

async function supplierBreakdown(s, opts = {}) {
  const m = SUP.supplierMetrics(s);
  if (!s.origin) return { ok: false, error: "Set the supplier's origin first — it decides duty and quota." };
  if (!Number.isFinite(m.pricePerT)) return { ok: false, error: "No quote logged for this supplier yet." };
  const products = (await productStore.list()).filter((p) => p.status !== "archived");
  const supplied = products.filter((p) => (s.supplies || []).includes(p.category));
  const needsOrder = supplied.find((p) => ["critical", "reorder", "low"].includes(stockMetrics({ ...p, stockAsOf: p.stockAsOf || (p.createdAt || "").slice(0, 10) || undefined }).status));
  const product = products.find((p) => p.id === opts.productId) || needsOrder || supplied[0];
  if (!product) return { ok: false, error: "Add a product they supply to price it." };
  const metrics = stockMetrics({ ...product, stockAsOf: product.stockAsOf || (product.createdAt || "").slice(0, 10) || undefined });
  // Workspace settings, with any what-if values from the order planner on top
  const ws = { ...(await settingsStore.get()), ...(opts.assume || {}) };
  const ratePct = opts.ratePct !== undefined && opts.ratePct !== "" && Number.isFinite(Number(opts.ratePct)) ? Number(opts.ratePct) : ws.costOfCapitalPct;
  const leadDays = s.leadTimeMax !== null && s.leadTimeMax !== undefined ? s.leadTimeMax * (s.leadTimeUnit === "days" ? 1 : 7) : s.leadTimeMin !== null && s.leadTimeMin !== undefined ? s.leadTimeMin * (s.leadTimeUnit === "days" ? 1 : 7) : null;
  const today = new Date().toISOString().slice(0, 10);
  const importDate = /^\d{4}-\d{2}-\d{2}$/.test(opts.importDate || "") ? opts.importDate : addDaysIso(today, leadDays ?? 21);
  // What you need, and what you actually have to buy: never less than the supplier's minimum order
  const needT = Number(opts.tonnage) > 0 ? Number(opts.tonnage) : (metrics.needT || metrics.suggestedOrderT || s.moqMinT || 25);
  const moqMin = s.moqMinT || 0;
  // part of a packaged load that already meets the minimum: buy just this line
  const packaged = Number(opts.packageT) >= moqMin && Number(opts.packageT) > 0;
  const tonnage = moqMin && needT < moqMin && !packaged ? moqMin : needT;
  const loads = s.moqMaxT > 0 ? Math.ceil((packaged ? Number(opts.packageT) : tonnage) / s.moqMaxT) : 1;
  const transportPerT = s.transport === "extra" ? Math.max(Number(opts.transportPerT ?? ws.deliveryPerT) || 0, 0) : 0;
  // Prefer a quote for this exact product; fall back to their general price.
  const byNewest = (a, b) => (b.date + (b.at || "")).localeCompare(a.date + (a.at || ""));
  const productQuote = [...(s.quotes || [])].filter((q) => q.productId === product.id).sort(byNewest)[0];
  const latest = productQuote || [...(s.quotes || [])].filter((q) => !q.productId).sort(byNewest)[0] || [...(s.quotes || [])].sort(byNewest)[0];
  const quoteScope = productQuote ? "product" : latest.productId ? "other-product" : "general";
  const scenarioInputs = {
    title: `${product.name} from ${s.name}`, commodityCode: product.commodityCode, origin: engineOrigin(s.origin), tonnage, importDate,
    incoterm: engineIncoterm(s), importerOfRecord: s.ddp === "no" ? "us" : m.covers === "everything" ? "supplier" : "us",
    priceAmount: latest.pricePerT, priceCurrency: latest.currency || "GBP", supplier: s.name, inlandFreightPerT: transportPerT,
    leadTimeWeeks: leadDays ? Math.max(1, Math.round(leadDays / 7)) : null,
    paymentTerms: s.paymentDays !== null && s.paymentDays !== undefined ? `${s.paymentDays} days` : "",
    quoteValidUntil: latest.validUntil || "",
    notes: `From the supplier cost breakdown (${latest.channel === "list" ? "supplier list price" : `quote of ${latest.date}`}).`,
  };
  // UK CBAM toggle: when on, price the carbon charge as if it already
  // applies (it starts 1 January 2027), using the mill's emissions.
  const cbamOn = opts.cbam === true || opts.cbam === "on";
  const route = s.productionRoute || "";
  const emissionsDefault = route === "eaf" ? ws.cbamEafTPerT : route === "bf-bof" ? ws.cbamBofTPerT : ws.cbamUnknownTPerT;
  const cbamInfo = {
    on: cbamOn, rate: ws.cbamRatePerT, route,
    emissions: Number.isFinite(s.emissionsPerT) ? s.emissionsPerT : emissionsDefault,
    emissionsSource: Number.isFinite(s.emissionsPerT) ? "verified" : route ? "route" : "unknown",
    relief: Number.isFinite(s.carbonPricePaidPerT) ? s.carbonPricePaidPerT : 0,
  };
  if (cbamOn) Object.assign(scenarioInputs, { emissionsPerT: cbamInfo.emissions, ukCarbonPrice: cbamInfo.rate, overseasCarbonPrice: cbamInfo.relief });
  const engine = await runScenario(scenarioInputs, cbamOn ? { cbamStartDate: "0000-01-01" } : { cbamEnabled: false });
  if (!engine.ok) return { ok: false, error: Object.values(engine.errors || {})[0] || "Could not price this order.", errors: engine.errors };

  const pricePerT = engine.lines.find((l) => l.key === "price").perTonne;
  const rate = ratePct / 100;
  const usage = product.monthlyUsageT || 0;
  const adjustments = [];
  // Equation building blocks: every number carries where it came from, so the
  // page can show each data point (quote, supplier profile, product, your
  // choices, live HMRC data, fixed constants, or an earlier step).
  const v = (label, value, kind, source, raw) => ({ t: "v", label, value, kind, source, raw });
  const op = (o) => ({ t: "op", o });
  const quoteSrc = latest.channel === "list" ? "Supplier list price" : `Quote of ${latest.date}`;
  const priceV = v("Price", `£${round2(pricePerT)}/t`, "quote", quoteSrc, pricePerT);
  const rateV = v("Cost of capital", `${ratePct}%`, "you", "Set above (default in Settings)", rate);
  // Credit terms are worth money: paying in N days instead of on delivery.
  if (s.paymentDays !== null && s.paymentDays !== undefined) {
    adjustments.push({ key: "terms", label: `Payment terms credit (${s.paymentDays} days)`, perTonne: -round2(pricePerT * rate * (s.paymentDays / 365)),
      formula: `price × ${ratePct}% cost of capital × ${s.paymentDays}/365`,
      working: `£${round2(pricePerT)} × ${ratePct}% × ${s.paymentDays} ÷ 365 = £${round2(pricePerT * rate * (s.paymentDays / 365))} saved per tonne`,
      why: "Paying later keeps cash in the business; this is what that credit is worth at your cost of capital.",
      equations: [{ parts: [priceV, op("×"), rateV, op("×"), v("Credit period", `${s.paymentDays} days`, "supplier", "Supplier payment terms", s.paymentDays), op("÷"), v("Days in a year", "365", "fixed", "Constant", 365)],
        result: { label: "Saved per tonne", value: round2(pricePerT * rate * (s.paymentDays / 365)), unit: "£/t", sign: -1 } }] });
  }
  // Buying above what you need ties up cash until it's used.
  if (tonnage > needT) {
    // you buy their minimum; the tonnes you don't need yet sit in stock until used
    const extra = tonnage - needT;
    const months = usage > 0 ? extra / usage : 6;
    const perT = (extra * pricePerT * rate * (months / 12)) / tonnage;
    adjustments.push({ key: "moq", label: `Minimum order: buying ${round2(tonnage)} t, ${round2(extra)} t more than you need`, perTonne: round2(perT),
      formula: `${round2(extra)} t extra × price × ${ratePct}% × ${round2(months)} months to use it ÷ ${tonnage} t bought`,
      working: `${round2(extra)} t × £${round2(pricePerT)} × ${ratePct}% × ${round2(months)}/12 months ÷ ${tonnage} t = £${round2(perT)} per tonne`,
      why: "Their minimum is more than you need, so the order is raised to it and the extra sits in stock until you use it.",
      equations: [
        { parts: [v("Their minimum", `${moqMin} t`, "supplier", "Supplier MOQ", moqMin), op("−"), v("You need", `${needT} t`, "you", "Your choice", needT)], result: { label: "Extra stock", value: round2(extra), unit: "t" } },
        { parts: [v("Extra stock", `${round2(extra)} t`, "calc", "Step 1", extra), op("÷"), v("Monthly usage", usage ? `${round2(usage)} t/month` : "not set", "product", usage ? "Product usage" : "Assumed 6 months", usage)], result: { label: "Months to use it", value: round2(months), unit: "months" } },
        { parts: [v("Extra stock", `${round2(extra)} t`, "calc", "Step 1", extra), op("×"), priceV, op("×"), rateV, op("×"), v("Time held", `${round2(months)} ÷ 12 yr`, "calc", "Step 2", months / 12), op("÷"), v("Tonnes bought", `${tonnage} t`, "calc", "Their minimum", tonnage)],
          result: { label: "Cost per tonne", value: round2(perT), unit: "£/t" } },
      ] });
  }
  // Late deliveries mean holding extra safety stock.
  if (s.onTimePct !== null && s.onTimePct !== undefined && s.onTimePct < 100 && usage > 0 && leadDays) {
    const late = 1 - s.onTimePct / 100;
    const bufferT = late * usage * ((leadDays / 2) / 30.44);
    adjustments.push({ key: "reliability", label: `Reliability buffer (${s.onTimePct}% on time)`, perTonne: round2((bufferT * pricePerT * rate) / (usage * 12)),
      formula: `${Math.round(late * 100)}% late × cover for half the lead time (${round2(bufferT)} t) × price × ${ratePct}% ÷ ${round2(usage * 12)} t a year`,
      working: `${Math.round(late * 100)}% × ${round2(usage)} t/month × ${round2(leadDays / 2)} days ÷ 30.4 = ${round2(bufferT)} t extra safety stock; ${round2(bufferT)} t × £${round2(pricePerT)} × ${ratePct}% ÷ ${round2(usage * 12)} t a year = £${round2((bufferT * pricePerT * rate) / (usage * 12))} per tonne`,
      why: "Late loads mean holding more safety stock; this is the cost of carrying it, spread over a year's purchases.",
      equations: [
        { parts: [v("Late loads", `${Math.round(late * 100)}%`, "supplier", `100% − ${s.onTimePct}% on time`, late), op("×"), v("Monthly usage", `${round2(usage)} t`, "product", "Product usage", usage), op("×"), v("Half the lead time", `${round2(leadDays / 2)} days ÷ 30.4`, "supplier", `Lead time ${s.leadTimeMax ?? s.leadTimeMin} ${s.leadTimeUnit}`, leadDays / 2 / 30.44)],
          result: { label: "Extra safety stock", value: round2(bufferT), unit: "t" } },
        { parts: [v("Extra safety stock", `${round2(bufferT)} t`, "calc", "Step 1", bufferT), op("×"), priceV, op("×"), rateV, op("÷"), v("Bought per year", `${round2(usage * 12)} t`, "product", "Usage × 12", usage * 12)],
          result: { label: "Cost per tonne", value: round2((bufferT * pricePerT * rate) / (usage * 12)), unit: "£/t" } },
      ] });
  }
  const quotaLine = engine.lines.find((l) => l.key === "quota");
  const quotaApplies = engine.buyerImports && engine.quota;
  const worstPerT = quotaApplies ? round2(engine.totals.expectedPerT - (quotaLine.perTonne || 0) + engine.customsValuePerT * 0.5) : engine.totals.expectedPerT;
  const adj = adjustments.reduce((t, a) => t + a.perTonne, 0);
  // Word-of-mouth market intel that applies to this supplier, product or group at this arrival date
  const intel = NEWS.notesFor(await liveNotes(), { supplierId: s.id, productId: product.id, group: product.category, date: importDate });
  const model = buildCostModel({ s, engine, adjustments, tonnage, latest, quoteSrc, pricePerT, ratePct, product, usage, moqMin, v, op, priceV, cbamInfo, intel, importDate });
  return {
    ok: true,
    model,
    cbam: cbamInfo,
    supplier: { id: s.id, name: s.name, origin: s.origin },
    product: { id: product.id, name: product.name, commodityCode: product.commodityCode, monthlyUsageT: usage, suggestedOrderT: metrics.suggestedOrderT },
    inputs: { tonnage, needT, moqApplied: tonnage > needT, moqMinT: moqMin || null, loads, importDate, ratePct, transportPerT, incoterm: engineIncoterm(s), leadDays, quotedPerT: latest.pricePerT, currency: latest.currency || "GBP", quoteDate: latest.date, quoteChannel: latest.channel, quoteScope },
    engine: { lines: engine.lines, totals: engine.totals, quota: engine.quota ? { probability: engine.quota.probability, basis: engine.quota.basis, orderNumber: quotaLine?.source } : null, category: engine.category, buyerImports: engine.buyerImports, checks: engine.checks, warnings: engine.warnings, customsValuePerT: engine.customsValuePerT, fx: engine.fx },
    adjustments,
    scenarioInputs: engine.inputs,
    // one set of numbers everywhere: the cost model's totals
    effectivePerT: model ? model.totals.expected : round2(engine.totals.expectedPerT + adj),
    worstPerT: model ? model.totals.worst : round2(worstPerT + adj),
    bestPerT: model ? model.totals.best : round2(engine.totals.expectedPerT - (quotaLine?.perTonne || 0) + adj),
  };
}
const round2 = (v) => (v === null || v === undefined || !Number.isFinite(v) ? v : Math.round(v * 100) / 100);
// Every cost variable for an order, always listed — even when it's zero, in
// the supplier's price, carried by the supplier or not applicable — each with
// its equation and the data points behind it.
function buildCostModel({ s, engine, adjustments, tonnage, latest, quoteSrc, pricePerT, ratePct, product, usage, moqMin, v, op, priceV, cbamInfo = { on: false }, intel = [], importDate = "" }) {
  const L = (k) => engine.lines.find((l) => l.key === k) || { perTonne: 0, status: "n/a", source: "" };
  const cv = engine.customsValuePerT;
  const cur = latest.currency || "GBP";
  const uk = s.origin === "UK";
  const buyerImports = engine.buyerImports;
  const inQuota = Boolean(engine.category);
  const quota = engine.quota;
  const incoterm = engine.inputs ? engine.inputs.incoterm : "";
  const gbpTxt = (x) => `£${round2(x)}`;
  const res = (label, value, unit = "£/t", extra = {}) => ({ label, value: round2(value), unit, ...extra });
  const eqs = (...list) => list;
  const cvV = v("Customs value", `${gbpTxt(cv)}/t`, "calc", "Price + freight + insurance", cv);
  const rows = [];
  const add = (group, key, label, perTonne, status, equations, note = "") => rows.push({ group, key, label, perTonne: round2(perTonne || 0), status, equations, note });
  const notImporting = uk
    ? { status: "n/a", eq: [v("Origin", "UK", "supplier", "Supplier profile")], note: "UK steel — no import, no customs." }
    : { status: "supplier", eq: [v("Importer of record", "Supplier", "supplier", `Delivered duty paid (${incoterm})`)], note: "The supplier clears customs and pays this." };

  // ---- Purchase
  const fxRate = engine.fx ? engine.fx.rate : 1;
  add("Purchase", "price", "Supplier price", pricePerT, "included",
    eqs({ parts: [v("Quoted price", `${cur === "GBP" ? "£" : ""}${latest.pricePerT}${cur !== "GBP" ? ` ${cur}` : ""}/t`, "quote", quoteSrc), op("×"), v("Exchange rate", cur === "GBP" ? "1.00" : String(fxRate), cur === "GBP" ? "fixed" : "live", cur === "GBP" ? "Quoted in sterling" : (engine.fx.source || "ECB rate"))], result: res("Price per tonne", pricePerT) }));

  // ---- Delivery
  for (const [key, label] of [["freight", "Freight to UK"], ["insurance", "Cargo insurance"], ["inland", "UK haulage to you"]]) {
    const l = L(key);
    if (l.status === "in-price") add("Delivery", key, label, 0, "in-price", eqs({ parts: [v(label, "In their price", "supplier", `Incoterm ${incoterm}`)], result: res(label, 0) }));
    else add("Delivery", key, label, l.perTonne, l.perTonne ? "included" : "missing", eqs({ parts: [v(label, `${gbpTxt(l.perTonne)}/t`, "you", l.perTonne ? "Entered" : "Not entered — add an estimate")], result: res(label, l.perTonne) }), l.perTonne ? "" : "Not in their price — add a haulage estimate on the breakdown.");
  }
  {
    const b = L("brokerage");
    if (!buyerImports) add("Delivery", "brokerage", "Customs brokerage", 0, notImporting.status, eqs({ parts: notImporting.eq, result: res("Brokerage", 0) }), notImporting.note);
    else add("Delivery", "brokerage", "Customs brokerage", b.perTonne, b.perTonne ? "included" : "missing", eqs({ parts: [v("Broker fee", b.source.replace(/ per shipment.*/, ""), "you", "Per shipment"), op("÷"), v("Your order", `${tonnage} t`, "you", "Your choice")], result: res("Per tonne", b.perTonne) }), b.perTonne ? "" : "Add your broker's fee per shipment to include it.");
  }

  // ---- Duty & tax
  add("Duty & tax", "customsValue", "Customs value", cv, "memo",
    eqs({ parts: [priceV, op("+"), v("Freight", `${gbpTxt(L("freight").perTonne)}`, L("freight").status === "in-price" ? "supplier" : "you", L("freight").status === "in-price" ? "In their price" : "Entered"), op("+"), v("Insurance", `${gbpTxt(L("insurance").perTonne)}`, L("insurance").status === "in-price" ? "supplier" : "you", L("insurance").status === "in-price" ? "In their price" : "Entered")], result: res("Customs value", cv) }),
    "What duty is charged on (not an extra cost).");
  for (const [key, label] of [["duty", "Import duty"], ["remedies", "Anti-dumping / countervailing"]]) {
    const l = L(key);
    if (!buyerImports) { add("Duty & tax", key, label, 0, notImporting.status, eqs({ parts: notImporting.eq, result: res(label, 0) }), notImporting.note); continue; }
    const rate = cv ? (l.perTonne / cv) * 100 : 0;
    add("Duty & tax", key, label, l.perTonne, "included", eqs({ parts: [cvV, op("×"), v(key === "duty" ? "Duty rate" : "Trade remedy rate", `${rate.toFixed(1)}%`, "live", l.source || "GOV.UK Trade Tariff")], result: res(label, l.perTonne) }),
      key === "duty" && choicesEu(s.origin) ? "0% for EU-origin steel with a statement on origin (UK–EU TCA)." : "");
  }
  {
    const c = L("cbam");
    const ci = cbamInfo;
    const routeName = { eaf: "electric-arc", "bf-bof": "blast furnace" }[ci.route];
    const emV = v("Embodied emissions", `${ci.emissions} t CO₂e/t`, ci.emissionsSource === "verified" ? "supplier" : "you",
      ci.emissionsSource === "verified" ? "Mill's verified figure (supplier profile)" : ci.emissionsSource === "route" ? `Settings · ${routeName} default` : "Settings · route unknown, higher figure", ci.emissions);
    const rateV = v("UK CBAM rate", `£${ci.rate}/t CO₂e`, "you", "Settings · estimate until HMRC publishes", ci.rate);
    const reliefV = v("Carbon price paid abroad", `£${ci.relief}/t CO₂e`, ci.relief ? "supplier" : "fixed", ci.relief ? "Supplier profile (needs CarbonVP1 evidence)" : "None claimed", ci.relief);
    if (!ci.on) {
      add("Duty & tax", "cbam", "UK CBAM (carbon)", 0, "off", eqs({ parts: [v("UK CBAM", "Switched off", "you", "Turn on the CBAM toggle to include it")], result: res("CBAM", 0) }),
        "UK CBAM starts on 1 January 2027 for imported iron and steel. Turn the toggle on to see what it adds.");
    } else if (!buyerImports) {
      add("Duty & tax", "cbam", "UK CBAM (carbon)", 0, notImporting.status, eqs({ parts: notImporting.eq, result: res("CBAM", 0) }), "The importer of record pays UK CBAM. Here that's the supplier, so expect it in their price from 2027.");
    } else if (!c.perTonne) {
      add("Duty & tax", "cbam", "UK CBAM (carbon)", 0, "n/a", eqs({ parts: [v("UK CBAM", c.source || "Not applicable", "fixed", "Finance Act 2026, Schedule 16")], result: res("CBAM", 0) }), c.source);
    } else {
      add("Duty & tax", "cbam", "UK CBAM (carbon)", c.perTonne, "included",
        eqs({ parts: [rateV, op("−"), reliefV], result: res("Net carbon price", Math.max(ci.rate - ci.relief, 0), "£/tCO2") },
          { parts: [emV, op("×"), v("Net carbon price", `£${round2(Math.max(ci.rate - ci.relief, 0))}/t CO₂e`, "calc", "Step 1", Math.max(ci.rate - ci.relief, 0))], result: res("CBAM per tonne", c.perTonne) },
          { parts: [v("CBAM per tonne", gbpTxt(c.perTonne), "calc", "Step 2"), op("×"), v("Your order", `${tonnage} t`, "you", "Your choice")], result: res("CBAM on this order", c.perTonne * tonnage, "£") }),
        "Paid by you as importer to HMRC, with returns from 2028 for 2027 imports. The rate and default emission values are estimates until HMRC publishes them; update them in Settings.");
    }
  }
  {
    const vat = engine.totals.vatPerT || 0;
    const dutiesPerT = ["duty", "quota", "remedies", "cbam"].reduce((t, k) => t + (L(k).perTonne || 0), 0);
    if (buyerImports) add("Duty & tax", "vat", "Import VAT (reclaimable)", vat, "memo", eqs({ parts: [cvV, op("+"), v("Duties", `${gbpTxt(dutiesPerT)}/t`, "calc", "Duty + expected steel duty + remedies + CBAM"), op("×"), v("VAT", "20%", "fixed", "UK import VAT")], result: res("VAT paid then reclaimed", vat) }), "A cash-flow cost, not a final cost — reclaimed on your VAT return.");
    else add("Duty & tax", "vat", "Import VAT", 0, notImporting.status, eqs({ parts: notImporting.eq, result: res("VAT", 0) }), uk ? "Normal UK VAT on the invoice — reclaimable." : notImporting.note);
  }

  // ---- Quota risk (expected value and the cost of a miss)
  let missPerT = 0;
  const steelDutyRate = 0.5;
  if (buyerImports && quota) {
    const ev = L("quota").perTonne || 0;
    missPerT = cv * steelDutyRate;
    add("Quota risk", "steelExpected", "Steel-measure duty — expected value", ev, "included",
      eqs({ parts: [v("Chance quota runs out", `${Math.round(quota.probability * 100)}%`, "live", `HMRC live quota · ${String(L("quota").source || "").replace(/^.*order /, "line ")}`), op("×"), v("Steel-measure duty", "50%", "fixed", "UK steel measure, out of quota"), op("×"), cvV], result: res("Expected duty", ev) }),
      quota.basis || "");
    add("Quota risk", "quotaMiss", "If the quota is missed", missPerT, "scenario",
      eqs(
        { parts: [v("Steel-measure duty", "50%", "fixed", "UK steel measure, out of quota"), op("×"), cvV], result: res("Extra per tonne", missPerT) },
        { parts: [v("Extra per tonne", `${gbpTxt(missPerT)}`, "calc", "Step 1"), op("×"), v("Your order", `${tonnage} t`, "you", "Your choice")], result: res("Extra on this order", missPerT * tonnage, "£") },
      ), "Not in the expected cost — this is what you'd pay on top if the line is used up before your load clears.");
  } else if (!uk && inQuota && !buyerImports) {
    add("Quota risk", "steelExpected", "Steel-measure duty — expected value", 0, "supplier", eqs({ parts: [v("Importer of record", "Supplier", "supplier", `Delivered duty paid (${incoterm})`)], result: res("Expected duty to you", 0) }), "The supplier pays any 50% duty.");
    add("Quota risk", "quotaMiss", "If the quota is missed", 0, "scenario", eqs({ parts: [v("Duty risk", "Supplier's", "supplier", "DDP contract"), op("+"), v("Delivery risk", "May delay or cancel", "supplier", "When quota is exhausted")], result: res("Extra to you", 0) }), "No duty to you, but a real risk the load is delayed or cancelled — agree what happens in the contract.");
  } else {
    const why = uk ? [v("Origin", "UK", "supplier", "Supplier profile")] : [v("Product", product.name, "product", `Code ${product.commodityCode} — not in a steel-measure category`)];
    add("Quota risk", "steelExpected", "Steel-measure duty — expected value", 0, "n/a", eqs({ parts: why, result: res("Expected duty", 0) }), uk ? "UK steel isn't covered by import quotas." : "This product isn't in a quota category.");
    add("Quota risk", "quotaMiss", "If the quota is missed", 0, "n/a", eqs({ parts: why, result: res("Extra", 0) }), "Nothing to miss.");
  }

  // ---- Market intel from word of mouth. A locked quote isn't changed by market-wide news.
  {
    const locked = latest.validUntil && importDate && latest.validUntil >= importDate;
    const scopeTxt = (n) => (n.scope === "supplier" ? `${s.name}` : n.scope === "product" ? product.name : n.scope === "group" ? `${n.targetId} prices` : "Market prices");
    for (const n of intel) {
      const marketWide = n.scope === "market" || n.scope === "group";
      const perT = n.effectUnit === "pct" ? (pricePerT * n.effectValue) / 100 : n.effectValue;
      const valTxt = n.effectUnit === "pct" ? `${n.effectValue > 0 ? "+" : ""}${n.effectValue}%` : `${n.effectValue > 0 ? "+" : "−"}£${Math.abs(n.effectValue)}/t`;
      const noteV = v(scopeTxt(n), valTxt, "intel", `${n.by || "Team"} · ${n.source || "word of mouth"} · from ${n.effectiveFrom || n.date}`, n.effectValue);
      const parts = n.effectUnit === "pct" ? [priceV, op("×"), noteV] : [noteV];
      const label = `Intel: ${n.title}`;
      if (marketWide && locked) add("Market intel", `intel-${n.id}`, label, 0, "n/a", eqs({ parts, result: res("Not applied", 0) }), `Their quote is fixed until ${latest.validUntil}, so this market move doesn't change it.`);
      else add("Market intel", `intel-${n.id}`, label, perT, "included", eqs({ parts, result: res(perT >= 0 ? "Added per tonne" : "Taken off per tonne", perT, "£/t", { sign: perT < 0 ? -1 : 1 }) }),
        `${n.scope === "supplier" ? "Applies to this supplier" : n.scope === "product" ? "Applies to this product" : n.scope === "group" ? `Applies to ${n.targetId}` : "Applies to the whole market"} for arrivals from ${n.effectiveFrom || n.date}, for ${n.horizonMonths} month${n.horizonMonths === 1 ? "" : "s"}.${n.body ? ` ${n.body}` : ""}`);
    }
  }

  // ---- Finance & terms
  {
    const fxb = L("fxBuffer");
    add("Finance & terms", "fxBuffer", "Currency buffer", fxb.perTonne || 0, cur === "GBP" ? "n/a" : "included", eqs({ parts: cur === "GBP" ? [v("Currency", "GBP", "quote", "No exchange-rate risk")] : [priceV, op("×"), v("Buffer", fxb.source, "you", "Your setting")], result: res("Buffer", fxb.perTonne || 0) }));
    const t = adjustments.find((a) => a.key === "terms");
    if (t) add("Finance & terms", "terms", t.label, t.perTonne, "included", t.equations, t.why);
    else add("Finance & terms", "terms", "Payment terms credit", 0, "missing", eqs({ parts: [v("Credit period", "Not recorded", "supplier", "Add to supplier profile")], result: res("Value", 0) }), "Add their payment terms to value the credit.");
  }

  // ---- Supply
  {
    const mq = adjustments.find((a) => a.key === "moq");
    if (mq) add("Supply", "moq", mq.label, mq.perTonne, "included", mq.equations, mq.why);
    else add("Supply", "moq", "Minimum order", 0, moqMin ? "n/a" : "missing", eqs({ parts: moqMin ? [v("Your order", `${tonnage} t`, "you", "Your choice"), op("≥"), v("Their minimum", `${moqMin} t`, "supplier", "Supplier MOQ")] : [v("Their minimum", "Not recorded", "supplier", "Add to supplier profile")], result: res("Extra stock cost", 0) }), moqMin ? "Your order meets their minimum." : "");
    const rl = adjustments.find((a) => a.key === "reliability");
    if (rl) add("Supply", "reliability", rl.label, rl.perTonne, "included", rl.equations, rl.why);
    else add("Supply", "reliability", "Reliability buffer", 0, s.onTimePct === 100 ? "n/a" : "missing",
      eqs({ parts: [v("On time", s.onTimePct === null ? "Not recorded" : `${s.onTimePct}%`, "supplier", "Supplier profile"), op("·"), v("Lead time", s.leadTimeMin === null ? "Not recorded" : `${s.leadTimeMin}–${s.leadTimeMax ?? s.leadTimeMin} ${s.leadTimeUnit}`, "supplier", "Supplier profile"), op("·"), v("Monthly usage", usage ? `${usage} t` : "Not set", "product", "Product")], result: res("Buffer cost", 0) }),
      s.onTimePct === 100 ? "Always on time." : "Needs on-time %, lead time and product usage.");
  }

  const expected = rows.filter((r) => r.status === "included").reduce((t, r) => t + r.perTonne, 0);
  const steelEv = (rows.find((r) => r.key === "steelExpected") || {}).perTonne || 0;
  const best = expected - steelEv;
  const worst = best + missPerT;
  return {
    groups: ["Purchase", "Delivery", "Duty & tax", "Quota risk", "Market intel", "Finance & terms", "Supply"],
    rows,
    totals: {
      expected: round2(expected), best: round2(best), worst: round2(worst),
      missPerT: round2(missPerT), missOrder: round2(missPerT * tonnage), probability: quota && buyerImports ? quota.probability : null,
      expectedOrder: round2(expected * tonnage), vatPerT: round2(engine.totals.vatPerT || 0),
      missing: rows.filter((r) => r.status === "missing").map((r) => r.label),
    },
  };
}
const choicesEu = (o) => SUP.EU_MEMBERS.has(o);


// Price one order from every supplier that could fill it (full cost model).
async function compareSuppliers(body = {}) {
  const all = (await supplierStore.list()).filter((x) => x.status !== "archived" && x.standing !== "hold");
  const products = await productStore.list();
  const product = products.find((p) => p.id === body.productId);
  const pool = product ? all.filter((x) => (x.supplies || []).includes(product.category)) : all;
  const rows = await Promise.all(pool.map(async (x) => {
    const b = await supplierBreakdown(x, { ...body, importDate: body.arrival === "fixed" ? body.importDate : undefined }).catch((e) => ({ ok: false, error: e.message }));
    return b.ok ? { id: x.id, name: x.name, origin: x.origin, quotedPerT: b.engine.lines.find((l) => l.key === "price").perTonne, expectedPerT: b.engine.totals.expectedPerT,
      effectivePerT: b.effectivePerT, worstPerT: b.worstPerT, bestPerT: b.bestPerT, missPerT: b.model ? b.model.totals.missPerT : round2(b.worstPerT - b.bestPerT), cbamPerT: round2((b.engine.lines.find((l) => l.key === "cbam") || {}).perTonne || 0), cbam: b.cbam,
      missing: b.model ? b.model.totals.missing : [], tonnage: b.inputs.tonnage, needT: b.inputs.needT, moqApplied: b.inputs.moqApplied, moqMinT: b.inputs.moqMinT, loads: b.inputs.loads, productName: b.product.name, probability: b.engine.quota ? b.engine.quota.probability : null,
      importDate: b.inputs.importDate, adjustments: b.adjustments, covers: SUP.supplierMetrics(x).covers, quoteDate: b.inputs.quoteDate, quoteCurrency: b.inputs.currency, quotedRaw: b.inputs.quotedPerT, quoteScope: b.inputs.quoteScope, quoteChannel: b.inputs.quoteChannel }
      : { id: x.id, name: x.name, origin: x.origin, error: b.error };
  }));
  return rows.sort((a, b) => (a.effectivePerT ?? 1e9) - (b.effectivePerT ?? 1e9));
}

// Everything the product's Market prices tab needs, for one product.
async function productMarket(product, body = {}) {
  const view = await productView(product);
  const rows = await compareSuppliers({ ...body, productId: product.id, arrival: "lead" });
  const mv = await marketView();
  const gbp = (price, cur) => (mv.fx[cur || "GBP"] ? price * mv.fx[cur || "GBP"] : null);
  const pick = (x) => ({ id: x.id, name: x.name, source: x.source, group: x.group, basis: x.basis || "", region: x.region || "", currency: x.currency, computed: Boolean(x.computed), productId: x.productId || null,
    latest: x.latest ? { ...x.latest, gbp: gbp(x.latest.price, x.currency) } : null,
    points: (x.points || []).map((pt) => ({ date: pt.date, price: pt.price, gbp: gbp(pt.price, x.currency) })) });
  const forProduct = mv.series.filter((x) => x.productId === product.id).map(pick);
  const forGroup = mv.series.filter((x) => !x.productId && x.group === product.category && x.kind !== "index" && x.kind !== "input").map(pick);
  const competition = mv.competition.filter((x) => x.group === product.category).map(pick);
  // quotes logged against this exact product
  const suppliers = (await supplierStore.list()).filter((x) => x.status !== "archived");
  const quotes = suppliers.flatMap((x) => (x.quotes || []).filter((q) => q.productId === product.id).map((q) => ({ supplierId: x.id, supplier: x.name, origin: x.origin, date: q.date, pricePerT: q.pricePerT, currency: q.currency || "GBP", gbp: gbp(q.pricePerT, q.currency), covers: q.covers || "", tonnage: q.tonnage })))
    .sort((a, b) => b.date.localeCompare(a.date));
  // what you've paid over time, from the product's own edit history
  const costHistory = [{ date: (product.createdAt || "").slice(0, 10), cost: null }, ...(product.activity || []).flatMap((a) => (a.changes || []).filter((c) => c.field === "costPerT").map((c) => ({ date: a.at.slice(0, 10), from: c.from, cost: c.to })))]
    .filter((x) => x.date);
  const ons = mv.series.filter((x) => x.feedKey === "ons:GHAV" || x.feedKey === "ons:GHCZ").map((x) => ({ key: x.feedKey, name: x.name, latest: x.latest, changes: x.changes, points: (x.points || []).slice(-24) }));
  return {
    ok: true,
    product: { id: view.id, name: view.name, category: view.category, spec: view.spec, commodityCode: view.commodityCode, costPerT: view.costPerT, targetBuyPrice: view.targetBuyPrice ?? null, monthlyUsageT: view.monthlyUsageT, suggestedOrderT: view.metrics.suggestedOrderT, createdAt: product.createdAt },
    rows, benchmarks: { product: forProduct, group: forGroup, competition }, quotes, costHistory, ons, fx: mv.fx,
    intel: (await liveNotes()).filter((n) => n.effectUnit && n.effectUnit !== "none" && Number.isFinite(n.effectValue) && NEWS.noteActive(n, rows.find((r) => r.importDate) ? rows.find((r) => r.importDate).importDate : new Date().toISOString().slice(0, 10)) && (n.scope === "market" || (n.scope === "group" && n.targetId === product.category) || (n.scope === "product" && n.targetId === product.id) || (n.scope === "supplier" && rows.some((r) => r.id === n.targetId)))),
  };
}

async function handleSupplierApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  const method = request.method;
  const live = async () => (await supplierStore.list()).filter((x) => x.status !== "archived");
  if (url.pathname === "/api/suppliers" && method === "GET") {
    return sendJson(response, 200, { suppliers: (await live()).map(supplierView), choices: SUPPLIER_CHOICES });
  }
  if (url.pathname === "/api/suppliers/compare" && method === "POST") {
    return sendJson(response, 200, { rows: await compareSuppliers(await readJsonBody(request)) });
  }
  if (method !== "GET" && !can(user, "edit") && !/\/breakdown$/.test(url.pathname)) return sendError(response, 403, "Your account cannot change suppliers.");
  const clashes = async (name, id) => (await live()).find((x) => x.id !== id && x.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (url.pathname === "/api/suppliers" && method === "POST") {
    const { supplier, errors, valid } = SUP.validateSupplier(await readJsonBody(request));
    if (await clashes(supplier.name)) errors.name = "A supplier with this name already exists.";
    if (!valid || errors.name) return sendJson(response, 422, { ok: false, errors });
    const saved = await supplierStore.create({ ...supplier, status: "active", contacts: [], quotes: [], rfqs: [] }, user.name);
    return sendJson(response, 201, supplierView(saved));
  }
  const m = url.pathname.match(/^\/api\/suppliers\/([0-9a-f-]{36})(?:\/(archive|quotes|contacts|rfqs|breakdown)(?:\/([0-9a-f-]{36}))?)?$/);
  if (!m) return sendError(response, 404, "Not found");
  const [, id, sub, subId] = m;
  const existing = await supplierStore.get(id);
  if (!existing || existing.status === "archived") return sendError(response, 404, "Supplier not found");
  const done = async (saved, code = 200) => sendJson(response, code, supplierView(saved));

  if (!sub && method === "GET") return done(existing);
  if (sub === "breakdown" && method === "POST") return sendJson(response, 200, await supplierBreakdown(existing, await readJsonBody(request)));
  if (!sub && method === "PUT") {
    const { supplier, errors, valid } = SUP.validateSupplier(await readJsonBody(request));
    if (await clashes(supplier.name, id)) errors.name = "Another supplier already has this name.";
    if (!valid || errors.name) return sendJson(response, 422, { ok: false, errors });
    const changes = supplierChanges(existing, supplier);
    if (!changes.length) return done(existing);
    return done(await supplierStore.update(id, (x) => Object.assign(x, supplier), user.name, "edited", changes.map((c) => c.label).join(", "), { changes }));
  }
  if (sub === "archive" && method === "POST") {
    await supplierStore.update(id, (x) => { x.status = "archived"; }, user.name, "archived");
    return sendJson(response, 200, { ok: true });
  }
  if (sub === "quotes" && method === "POST" && !subId) {
    const { quote, errors, valid } = SUP.validateQuote(await readJsonBody(request));
    if (!valid) return sendJson(response, 422, { ok: false, errors });
    const product = quote.productId ? await productStore.get(quote.productId) : null;
    const entry = { id: SUP.newId(), at: new Date().toISOString(), by: user.name, ...quote, productName: product ? product.name : null, covers: quote.covers || existing.priceCovers };
    const answered = (existing.rfqs || []).filter((r) => r.status === "open").length;
    const sym = { GBP: "£", EUR: "€", USD: "$" }[quote.currency];
    return done(await supplierStore.update(id, (x) => {
      x.quotes = [...(x.quotes || []), entry];
      for (const r of x.rfqs || []) if (r.status === "open") { r.status = "answered"; r.answeredAt = entry.at; r.quoteId = entry.id; }
      setTimeout(() => broadcast("quotes", { supplierId: id }), 0);
    }, user.name, "quote logged", `${sym}${quote.pricePerT}/t${product ? ` · ${product.name}` : ""}${quote.tonnage ? ` · ${quote.tonnage} t` : ""} · ${SUP.QUOTE_CHANNELS[quote.channel]}${answered ? " · answers quote request" : ""}`, { quoteId: entry.id }), 201);
  }
  if (sub === "quotes" && subId && method === "DELETE") {
    const q = (existing.quotes || []).find((x) => x.id === subId);
    if (!q) return sendError(response, 404, "Quote not found");
    return done(await supplierStore.update(id, (x) => { x.quotes = x.quotes.filter((y) => y.id !== subId); }, user.name, "quote removed", `${q.pricePerT}/t from ${q.date}`));
  }
  if (sub === "contacts" && (method === "POST" || (method === "PUT" && subId))) {
    const { contact, errors, valid } = SUP.validateContact(await readJsonBody(request));
    if (!valid) return sendJson(response, 422, { ok: false, errors });
    if (subId && !(existing.contacts || []).some((c) => c.id === subId)) return sendError(response, 404, "Contact not found");
    const cid = subId || SUP.newId();
    return done(await supplierStore.update(id, (x) => {
      x.contacts = x.contacts || [];
      const first = !x.contacts.length;
      if (contact.primary || first) x.contacts.forEach((c) => { c.primary = false; });
      const rec = { id: cid, ...contact, primary: contact.primary || (first && !subId) };
      const i = x.contacts.findIndex((c) => c.id === cid);
      if (i >= 0) x.contacts[i] = rec; else x.contacts.push(rec);
      if (!x.contacts.some((c) => c.primary) && x.contacts[0]) x.contacts[0].primary = true;
    }, user.name, subId ? "contact updated" : "contact added", `${contact.name}${contact.role ? ` (${contact.role})` : ""}`), subId ? 200 : 201);
  }
  if (sub === "contacts" && subId && method === "DELETE") {
    const c = (existing.contacts || []).find((x) => x.id === subId);
    if (!c) return sendError(response, 404, "Contact not found");
    return done(await supplierStore.update(id, (x) => {
      x.contacts = x.contacts.filter((y) => y.id !== subId);
      if (!x.contacts.some((y) => y.primary) && x.contacts[0]) x.contacts[0].primary = true;
    }, user.name, "contact removed", c.name));
  }
  if (sub === "rfqs" && method === "POST" && !subId) {
    const { rfq, errors, valid } = SUP.validateRfq(await readJsonBody(request));
    if (!valid) return sendJson(response, 422, { ok: false, errors });
    const contact = (existing.contacts || []).find((c) => c.id === rfq.contactId);
    const entry = { id: SUP.newId(), at: new Date().toISOString(), by: user.name, status: "open", ...rfq, contactName: contact ? contact.name : null };
    const total = rfq.lines.reduce((t, l) => t + (l.tonnage || 0), 0);
    return done(await supplierStore.update(id, (x) => { x.rfqs = [...(x.rfqs || []), entry]; }, user.name, "quote requested",
      `${rfq.lines.length} product${rfq.lines.length === 1 ? "" : "s"}${total ? ` · ${total} t` : ""}${contact ? ` · to ${contact.name}` : ""} · ${rfq.channel === "copy" ? "copied" : "email"}`, { rfqId: entry.id }), 201);
  }
  sendError(response, 405, "Method not allowed");
}


// ------------------------------------------------------------ live market feeds

// Browsers listening for changes (Server-Sent Events) — Market prices and
// supplier pages refresh themselves when new prices or quotes arrive.
const listeners = new Set();
function broadcast(event, data = {}) {
  const msg = `event: ${event}\ndata: ${JSON.stringify({ at: new Date().toISOString(), ...data })}\n\n`;
  for (const res of listeners) { try { res.write(msg); } catch { listeners.delete(res); } }
}
setInterval(() => { for (const res of listeners) { try { res.write(": ping\n\n"); } catch { listeners.delete(res); } } }, 25_000).unref?.();

// Last run per live source, kept on disk so a restart doesn't re-fetch.
const feedStateFile = join(process.env.DATA_DIR || join(root, "var"), "feeds.json");
let feedState = null;
async function getFeedState() {
  if (feedState) return feedState;
  try { feedState = JSON.parse(await readFile(feedStateFile, "utf8")); } catch { feedState = { runs: {} }; }
  return feedState;
}
async function saveFeedState() {
  await mkdir(dirname(feedStateFile), { recursive: true });
  await writeFile(feedStateFile, JSON.stringify(feedState, null, 2));
}

const LIVE_INTERVAL_H = { ONS: 24, LME: 12 };
const metalsKey = async () => process.env.METALS_API_KEY || (await settingsStore.get()).metalsApiKey || "";
const metalsSymbols = () => (process.env.METALS_API_SYMBOLS || LIVE.METALS_DEFAULT_SYMBOLS.join(",")).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);

// Create the series the first time, then merge new points into it.
async function upsertFeedSeries(feedKey, def, points, by) {
  let series = (await benchmarkStore.list()).find((x) => x.feedKey === feedKey && x.status !== "archived");
  if (!series) {
    series = await benchmarkStore.create({ ...def, feedKey, keys: [BM.normKey(def.name)], status: "active", points: [] }, by);
  }
  const before = new Set((series.points || []).map((p) => `${p.date}:${p.price}`));
  const fresh = points.filter((p) => !before.has(`${p.date}:${p.price}`));
  if (!fresh.length) return 0;
  const at = new Date().toISOString();
  await benchmarkStore.update(series.id, (x) => { x.points = BM.mergePoints(x.points || [], fresh.map((p) => ({ date: p.date, price: p.price, via: "feed", by, at }))); },
    by, "feed update", `${fresh.length} new value${fresh.length === 1 ? "" : "s"} · latest ${fresh[fresh.length - 1].date}`);
  return fresh.length;
}

async function runLive(source, { force = false } = {}) {
  const state = await getFeedState();
  const last = state.runs[source];
  if (!force && last && last.ok && Date.now() - Date.parse(last.at) < LIVE_INTERVAL_H[source] * 3_600_000) return last;
  const at = new Date().toISOString();
  let result;
  try {
    if (source === "ONS") {
      let added = 0;
      const errors = [];
      for (const def of LIVE.ONS_SERIES) {
        try {
          const pts = await LIVE.fetchOns(def.id);
          added += await upsertFeedSeries(`ons:${def.id}`, { name: def.name, source: "ONS", group: "All steel", region: def.region, basis: "Index (2015 = 100)", currency: "GBP", kind: "index", unit: "index", notes: def.note, sourceUrl: `https://www.ons.gov.uk/economy/inflationandpriceindices/timeseries/${def.id.toLowerCase()}/ppi` }, pts, "feed:ONS");
        } catch (error) { errors.push(error.message); }
      }
      if (errors.length === LIVE.ONS_SERIES.length) throw new Error(errors[0]);
      result = { ok: true, at, added, errors };
    } else if (source === "LME") {
      const key = await metalsKey();
      if (!key) return (state.runs.LME = { ok: false, at, error: "No Metals-API key yet — add it in Settings.", needsKey: true });
      const symbols = metalsSymbols();
      const since = last && last.ok ? last.at : null;
      const pts = await LIVE.fetchMetals(key, symbols, { since });
      let added = 0;
      for (const sym of symbols) {
        const meta = LIVE.METALS_SYMBOLS[sym] || { name: `LME ${sym}`, group: "All steel" };
        added += await upsertFeedSeries(`metals:${sym}`, { name: meta.name, source: "LME", group: meta.group, region: meta.region || "", basis: meta.basis || "", currency: "USD", kind: meta.kind || "price", notes: `${meta.note ? `${meta.note}. ` : ""}Metals-API symbol ${sym}, USD per tonne.` },
          pts.filter((p) => p.symbol === sym), "feed:LME");
      }
      result = { ok: true, at, added };
    } else throw new Error("Unknown live source");
  } catch (error) {
    result = { ok: false, at, error: error.message };
  }
  state.runs[source] = result;
  await saveFeedState().catch(() => {});
  if (result.ok && result.added) broadcast("prices", { source, added: result.added });
  return result;
}

// Once a day, pick up any new HMRC month (only if history has been loaded once).
async function autoSyncCompetition() {
  const d = await getCompData();
  if (!Object.keys(d.importerMonths).length || compSync.running) return;
  if (compSync.lastRun && Date.now() - Date.parse(compSync.lastRun) < 24 * 3_600_000) return;
  await syncCompetition({ months: 3 });
}
function scheduleLive() {
  const tick = () => { runLive("ONS").catch(() => {}); runLive("LME").catch(() => {}); refreshNews().catch(() => {}); autoSyncCompetition().catch(() => {}); };
  setTimeout(tick, 8_000).unref?.();
  setInterval(tick, 60 * 60 * 1000).unref?.(); // check hourly; each source runs when it's due
}

// ------------------------------------------------------------ market prices API

const feedRuns = {}; // source → last run result (in memory)

async function fxMap(currencies) {
  const map = { GBP: 1 };
  await Promise.all([...new Set(currencies)].filter((c) => c && c !== "GBP").map(async (c) => {
    const fx = await getFx(c).catch(() => null);
    if (fx && fx.rate) map[c] = fx.rate;
  }));
  return map;
}

async function liveSeries() {
  return (await benchmarkStore.list()).filter((x) => x.status !== "archived");
}

// Import parsed rows into saved series. `mapping` maps a series key to an
// existing series id, or to {create: {...series fields}}; unmapped keys are
// matched by alias and otherwise skipped.
async function importBenchmarkRows(rows, mapping, user, via) {
  const plan = BM.planImport(rows, await liveSeries());
  const result = { added: 0, series: [], skipped: [] };
  for (const g of plan) {
    let target = mapping && mapping[g.key];
    let id = typeof target === "string" ? target : g.seriesId;
    if (target && typeof target === "object" && target.create) {
      const { series, valid, errors } = BM.validateSeries({ ...target.create, keys: [g.name, ...(target.create.keys || [])] });
      if (!valid) { result.skipped.push({ name: g.name, reason: Object.values(errors)[0] }); continue; }
      const created = await benchmarkStore.create({ ...series, status: "active", points: [] }, user);
      id = created.id;
    }
    if (target === "skip" || !id) { result.skipped.push({ name: g.name, reason: target === "skip" ? "skipped" : "not mapped to a series", count: g.count }); continue; }
    const existing = await benchmarkStore.get(id);
    if (!existing) { result.skipped.push({ name: g.name, reason: "series not found" }); continue; }
    const incoming = rows.filter((r) => BM.normKey(r.series) === g.key).map((r) => ({ date: r.date, price: r.price, via, by: user, at: new Date().toISOString() }));
    const before = (existing.points || []).length;
    await benchmarkStore.update(id, (x) => {
      x.points = BM.mergePoints(x.points || [], incoming);
      const k = BM.normKey(g.name);
      if (!(x.keys || []).includes(k)) x.keys = [...(x.keys || []), k];
    }, user, via === "feed" ? "feed update" : "prices imported", `${incoming.length} price${incoming.length === 1 ? "" : "s"} · ${g.from}${g.to !== g.from ? ` to ${g.to}` : ""}`);
    const after = (await benchmarkStore.get(id)).points.length;
    result.added += after - before;
    result.series.push({ id, name: existing.name, prices: incoming.length, newDates: after - before });
  }
  return result;
}

async function runFeed(source) {
  const cfg = feedConfig()[source];
  const started = new Date().toISOString();
  try {
    const parsed = await fetchFeed(source, cfg);
    // New series in the feed are created automatically under the default
    // product group (Settings) — re-assign them on Market prices if needed.
    const settings = await settingsStore.get();
    const plan = BM.planImport(parsed.rows, await liveSeries());
    const mapping = Object.fromEntries(plan.filter((g) => !g.seriesId).map((g) => [g.key, { create: { name: g.name, source, group: settings.defaultCategory || "Merchant Bar", currency: g.currency || "GBP" } }]));
    const res = await importBenchmarkRows(parsed.rows, mapping, `feed:${source}`, "feed");
    feedRuns[source] = { ok: true, at: started, rows: parsed.rows.length, ...res, errors: parsed.errors.slice(0, 5) };
    if (res.added) broadcast("prices", { source });
  } catch (error) {
    feedRuns[source] = { ok: false, at: started, error: error.message };
  }
  return feedRuns[source];
}

function scheduleFeeds() {
  const configured = Object.entries(feedConfig()).filter(([, c]) => c.configured).map(([s]) => s);
  if (!configured.length) return;
  const runAll = () => configured.forEach((s) => runFeed(s).catch(() => {}));
  setTimeout(runAll, 15_000).unref?.();
  setInterval(runAll, 6 * 60 * 60 * 1000).unref?.();
}

async function marketView() {
  const series = await liveSeries();
  const suppliers = (await supplierStore.list()).filter((x) => x.status !== "archived");
  const fx = await fxMap([...series.map((x) => x.currency), ...suppliers.flatMap((x) => (x.quotes || []).map((q) => q.currency))]);
  const groups = [...new Set([...series.filter((x) => x.kind !== "index" && x.group !== "All steel").map((x) => x.group), ...suppliers.flatMap((x) => x.supplies || [])])].filter(Boolean).sort();
  const competition = groups.flatMap((g) => BM.competitionSeries(suppliers, g, fx));
  const cfg = feedConfig();
  const feeds = Object.keys(BM.SOURCES).map((source) => {
    const mine = series.filter((x) => x.source === source);
    const lastDate = mine.flatMap((x) => (x.points || []).map((p) => p.date)).sort().pop() || null;
    return {
      source, ...BM.SOURCES[source], series: mine.length, points: mine.reduce((n, x) => n + (x.points || []).length, 0), lastDate,
      feed: FEED_SOURCES.includes(source) ? { configured: cfg[source].configured, env: cfg[source].envUrl, lastRun: feedRuns[source] || null } : null,
    };
  });
  const state = await getFeedState();
  const live = {
    ONS: { ...(state.runs.ONS || {}), auto: true, series: LIVE.ONS_SERIES.map((d) => d.id) },
    LME: { ...(state.runs.LME || {}), hasKey: Boolean(await metalsKey()), symbols: metalsSymbols() },
    listeners: listeners.size,
  };
  return {
    live,
    series: series.map((x) => ({ ...x, latest: BM.latest(x.points), changes: LIVE.periodChanges(x.points) })),
    competition: competition.map((x) => ({ ...x, latest: BM.latest(x.points) })),
    suppliers: suppliers.map((x) => ({ id: x.id, name: x.name, origin: x.origin, supplies: x.supplies || [], metrics: SUP.supplierMetrics(x), quotes: (x.quotes || []).map(({ date, pricePerT, currency, covers, channel }) => ({ date, pricePerT, currency, covers, channel })) })),
    fx, groups, feeds,
    choices: { sources: Object.keys(BM.SOURCES), regions: BM.REGIONS, bases: BM.BASES, currencies: BM.CURRENCIES, groups: CATALOGUE_GROUPS },
  };
}


// ------------------------------------------------------------ market news & regulation
const NEWS_INTERVAL_H = 6;
let newsCache = null; // { items, fetchedAt, errors }
const newsFile = join(process.env.DATA_DIR || join(root, "var"), "news-feed.json");
async function getNews() {
  if (newsCache) return newsCache;
  try { newsCache = JSON.parse(await readFile(newsFile, "utf8")); } catch { newsCache = { items: [], fetchedAt: null, errors: [] }; }
  return newsCache;
}
async function refreshNews({ force } = {}) {
  const cur = await getNews();
  if (!force && cur.fetchedAt && Date.now() - Date.parse(cur.fetchedAt) < NEWS_INTERVAL_H * 3_600_000) return cur;
  const errors = [];
  const lists = await Promise.all(NEWS.NEWS_FEEDS.map(async (f) => {
    try {
      const res = await fetch(f.url, { headers: { accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.5" }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return NEWS.parseAtom(await res.text(), f);
    } catch (error) { errors.push(`${f.id}: ${error.message}`); return []; }
  }));
  const fresh = NEWS.mergeNews(lists);
  const before = new Set(cur.items.map((x) => x.url));
  const added = fresh.filter((x) => !before.has(x.url)).length;
  newsCache = { items: NEWS.mergeNews([fresh, cur.items]), fetchedAt: new Date().toISOString(), errors, added };
  await mkdir(dirname(newsFile), { recursive: true });
  await writeFile(newsFile, JSON.stringify(newsCache, null, 2));
  if (added) broadcast("news", { added });
  return newsCache;
}
async function liveNotes() {
  return (await newsStore.list()).filter((x) => x.status !== "archived").sort((a, b) => b.date.localeCompare(a.date) || String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function handleNewsApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  const method = request.method;
  if (url.pathname === "/api/news" && method === "GET") {
    const n = await getNews();
    const today = new Date().toISOString().slice(0, 10);
    const regulation = NEWS.REGULATION.map((r) => ({ ...r, daysUntil: NEWS.daysUntil(r.date, today), keyDates: r.keyDates.map((k) => ({ ...k, daysUntil: NEWS.daysUntil(k.date, today) })) }));
    return sendJson(response, 200, { regulation, feed: n.items, fetchedAt: n.fetchedAt, errors: n.errors || [], notes: await liveNotes(),
      choices: { topics: NEWS.NEWS_TOPICS, impacts: NEWS.IMPACTS, strengths: NEWS.STRENGTHS }, canEdit: can(user, "edit") });
  }
  if (url.pathname === "/api/news/refresh" && method === "POST") {
    const n = await refreshNews({ force: true });
    return sendJson(response, 200, { ok: !n.errors.length || n.items.length > 0, added: n.added || 0, errors: n.errors });
  }
  if (!can(user, "edit")) return sendError(response, 403, "Your account cannot add market insight.");
  if (url.pathname === "/api/news/notes" && method === "POST") {
    const { note, errors, valid } = NEWS.validateNote(await readJsonBody(request));
    if (!valid) return sendJson(response, 422, { ok: false, errors });
    const saved = await newsStore.create({ ...note, status: "active", by: user.name }, user.name);
    broadcast("news", { note: saved.id });
    return sendJson(response, 201, saved);
  }
  const m = url.pathname.match(/^\/api\/news\/notes\/([0-9a-f-]{36})(?:\/(archive))?$/);
  if (m) {
    const existing = await newsStore.get(m[1]);
    if (!existing || existing.status === "archived") return sendError(response, 404, "Note not found");
    if (m[2] === "archive" && method === "POST") { await newsStore.update(m[1], (x) => { x.status = "archived"; }, user.name, "archived"); broadcast("news", {}); return sendJson(response, 200, { ok: true }); }
    if (!m[2] && method === "PUT") {
      const { note, errors, valid } = NEWS.validateNote(await readJsonBody(request));
      if (!valid) return sendJson(response, 422, { ok: false, errors });
      return sendJson(response, 200, await newsStore.update(m[1], (x) => Object.assign(x, note), user.name, "edited"));
    }
  }
  return sendError(response, 404, "Not found");
}

// ------------------------------------------------------------ steel forecast
async function steelForecast(body = {}) {
  const ws = { ...(await settingsStore.get()), ...(body.assume || {}) };
  const cfg = { ...FC.FORECAST_DEFAULTS, cbamPassThroughPct: ws.forecastCbamPassThroughPct, storagePerTMonth: ws.forecastStoragePerTMonth };
  const series = await liveSeries();
  const idx = series.find((x) => x.feedKey === "ons:GHAV");
  const imp = series.find((x) => x.feedKey === "ons:GHCZ");
  const monthlyIdx = idx ? FC.monthly(idx.points || []) : [];
  if (monthlyIdx.length < cfg.trendMonths + 1) {
    return { ok: false, error: idx ? "Not enough ONS history yet: the model needs at least 13 months." : "Waiting for the ONS steel price index, which the live feed pulls in automatically." };
  }
  const today = new Date().toISOString().slice(0, 10);
  const products = (await productStore.list()).filter((p) => p.status !== "archived");
  // reference £/t for the CBAM driver: average of your product costs
  const refPrice = products.length ? products.reduce((t, p) => t + (p.costPerT || 0), 0) / products.length : 750;
  const notes = await liveNotes();
  const lastDate = monthlyIdx[monthlyIdx.length - 1].date;
  const drivers = [
    FC.cbamDriver({ ratePerT: ws.cbamRatePerT, emissionsPerT: ws.cbamUnknownTPerT, referencePrice: refPrice, passThroughPct: cfg.cbamPassThroughPct }),
    // market-wide and product-group intel move the index; supplier/product intel goes into their own prices
    ...FC.noteDrivers(notes.filter((n) => !n.scope || n.scope === "market" || n.scope === "group")
      .map((n) => ({ ...n, date: n.effectiveFrom || n.date, pct: n.effectUnit === "pct" ? n.effectValue : n.effectUnit === "perT" ? (n.effectValue / refPrice) * 100 : undefined })), today, NEWS.STRENGTH_PCT),
  ].filter(Boolean);
  const horizon = Math.max(12, FC.monthsBetween(lastDate, today) + 12);
  const proj = FC.project(monthlyIdx, { horizon, drivers, settings: cfg });
  if (body.coreOnly) {
    const offset = Math.max(0, FC.monthsBetween(lastDate, today));
    const fromToday = proj.path.slice(offset);
    const indexNow = offset > 0 ? proj.path[offset - 1].mid : proj.last;
    return { ok: true, core: true, fromToday, indexNow, drivers, settings: cfg, costOfCapitalPct: ws.costOfCapitalPct, model: { trendPerMonthPct: proj.trendPerMonthPct, momentumPerMonthPct: proj.momentumPerMonthPct, volatilityPct: proj.volatilityPct } };
  }
  const base = FC.project(monthlyIdx, { horizon, drivers: [], settings: cfg });
  const bt3 = FC.backtest(monthlyIdx, { h: 3, origins: 12, settings: cfg });
  const bt6 = FC.backtest(monthlyIdx, { h: 6, origins: 12, settings: cfg });
  // months from today: ONS data lags, so skip the months already behind us
  const offset = Math.max(0, FC.monthsBetween(lastDate, today));
  const fromToday = proj.path.slice(offset);
  const indexNow = offset > 0 ? proj.path[offset - 1].mid : proj.last;
  const at = (h) => fromToday[h - 1] || null;
  const pct = (x) => (x ? ((x.mid / indexNow) - 1) * 100 : null);
  // per product: today's best landed price → forecast and buy-ahead value
  const months = [1, 2, 3, 6].includes(Number(body.months)) ? Number(body.months) : 3;
  const rows = await Promise.all(products.map(async (p) => {
    const cmp = (await compareSuppliers({ productId: p.id, arrival: "lead", cbam: body.cbam })).filter((r) => Number.isFinite(r.effectivePerT));
    const best = cmp[0];
    const priceNow = best ? best.effectivePerT : p.costPerT;
    const m = stockMetrics({ ...p, stockAsOf: p.stockAsOf || (p.createdAt || "").slice(0, 10) || undefined });
    const ba = FC.buyAhead({ priceNow, indexNow, path: fromToday, monthlyUsageT: p.monthlyUsageT, months, costOfCapitalPct: ws.costOfCapitalPct, storagePerTMonth: cfg.storagePerTMonth });
    const f3 = at(3), f6 = at(6);
    return { id: p.id, name: p.name, category: p.category, costPerT: p.costPerT, priceNow, priceSource: best ? `${best.name}, landed` : "your cost", supplierId: best ? best.id : null,
      monthlyUsageT: p.monthlyUsageT, stockT: m.stockNowT, coverMonths: m.coverMonths, status: m.status, suggestedOrderT: m.suggestedOrderT,
      in3: f3 ? { mid: priceNow * f3.mid / indexNow, low: priceNow * f3.low / indexNow, high: priceNow * f3.high / indexNow } : null,
      in6: f6 ? { mid: priceNow * f6.mid / indexNow, low: priceNow * f6.low / indexNow, high: priceNow * f6.high / indexNow } : null,
      buyAhead: ba };
  }));
  return {
    ok: true, modelVersion: FC.MODEL_VERSION, today, settings: cfg, costOfCapitalPct: ws.costOfCapitalPct, months,
    index: { name: idx.name, source: "ONS", key: "ons:GHAV", points: monthlyIdx, last: monthlyIdx[monthlyIdx.length - 1] },
    imported: imp ? { name: imp.name, points: FC.monthly(imp.points || []).slice(-36) } : null,
    model: { ...proj, path: proj.path, base: base.path, offset, indexNow },
    outlook: { in1: pct(at(1)), in3: pct(at(3)), in6: pct(at(6)), in12: pct(at(12)), band3: at(3) ? [((at(3).low / indexNow) - 1) * 100, ((at(3).high / indexNow) - 1) * 100] : null },
    drivers: drivers.map((d) => ({ ...d, nowPct: FC.driverPctAt([d], addMonthsIso(today, 3)) })),
    backtest: { h3: bt3, h6: bt6 },
    notesUsed: notes.filter((n) => n.impact !== "neutral").length,
    products: rows,
  };
}
const addMonthsIso = (iso, n) => FC.addMonths(iso, n);

async function handleForecastApi(request, response, url) {
  if (url.pathname === "/api/forecast" && (request.method === "POST" || request.method === "GET")) {
    const body = request.method === "POST" ? await readJsonBody(request) : Object.fromEntries(url.searchParams);
    if (body.cbam === "true") body.cbam = true;
    return sendJson(response, 200, await steelForecast(body));
  }
  return sendError(response, 404, "Not found");
}


// ------------------------------------------------------------ competition analysis
const compFile = join(process.env.DATA_DIR || join(root, "var"), "competition-data.json");
let compData = null; // { companies: {id: {name, postcode, town, m: {YYYYMM: [codes]}}}, importerMonths: {}, trade: {YYYYMM: {code: {t, v, o}}}, links, summary }
const compSync = { running: false, step: "", done: 0, total: 0, errors: [], lastRun: null, lastAdded: 0 };
async function getCompData() {
  if (compData) return compData;
  try { compData = JSON.parse(await readFile(compFile, "utf8")); } catch { compData = { companies: {}, importerMonths: {}, trade: {}, summary: null, tradeVersion: COMP.TRADE_VERSION }; }
  if (!compData.summary) {
    // starter data: the Python pipeline's summary of 2024–2026 importers
    try { compData.summary = COMP.parseActivityCsv(await readFile(join(root, "output", "company_activity.csv"), "utf8")); } catch { compData.summary = []; }
  }
  return compData;
}
async function saveCompData() {
  await mkdir(dirname(compFile), { recursive: true });
  await writeFile(compFile, JSON.stringify(compData));
}
async function fetchBuffer(url, accept = "*/*") {
  const res = await fetch(url, { headers: { accept, "user-agent": "DatafabAGX/1.0 (steel procurement tool)" }, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split("/").pop()}`);
  return Buffer.from(await res.arrayBuffer());
}
// Pull the last `months` of HMRC importer and trade files that aren't loaded yet.
async function syncCompetition({ months = 24 } = {}) {
  if (compSync.running) return compSync;
  Object.assign(compSync, { running: true, step: "Finding HMRC files", done: 0, total: 0, errors: [], lastAdded: 0 });
  broadcast("competition", { step: compSync.step });
  try {
    const data = await getCompData();
    const links = { importers: {}, imports: {} };
    for (const page of COMP.HMRC_PAGES) {
      try {
        const found = COMP.findBulkLinks((await fetchBuffer(page, "text/html")).toString("utf8"));
        Object.assign(links.importers, found.importers); Object.assign(links.imports, found.imports);
      } catch (error) { compSync.errors.push(`${page}: ${error.message}`); }
    }
    // volumes saved before ports and routes were recorded are fetched again
    if ((data.tradeVersion || 1) < COMP.TRADE_VERSION) { data.trade = {}; data.tradeVersion = COMP.TRADE_VERSION; }
    const want = (kind, have) => Object.keys(links[kind]).sort().slice(-months).filter((p) => !have[p]);
    const jobs = [...want("importers", data.importerMonths).map((p) => ["importers", p]), ...want("imports", data.trade).map((p) => ["imports", p])];
    compSync.total = jobs.length;
    for (const [kind, period] of jobs) {
      compSync.step = `${kind === "importers" ? "Importer list" : "Import volumes"} for ${period.slice(4)}/${period.slice(0, 4)}`;
      broadcast("competition", { step: compSync.step, done: compSync.done, total: compSync.total });
      try {
        const zip = COMP.readZip(await fetchBuffer(links[kind][period], "application/zip"));
        const entry = zip.find((e) => /\.txt$/i.test(e.name) && e.data) || zip.find((e) => e.data);
        if (!entry) throw new Error("empty zip");
        const text = entry.data.toString("latin1");
        if (kind === "importers") {
          const rows = COMP.parseImporters(text);
          for (const r of rows) {
            const co = (data.companies[r.id] ||= { name: r.name, postcode: r.postcode, town: r.town, m: {} });
            co.name = r.name; co.town = r.town || co.town;
            co.m[r.period] = r.codes;
          }
          data.importerMonths[period] = rows.length;
        } else {
          const agg = COMP.parseImports(text);
          for (const [p, codes] of Object.entries(agg)) data.trade[p] = codes;
          if (!data.trade[period]) data.trade[period] = {};
        }
        compSync.lastAdded++;
        await saveCompData();
      } catch (error) { compSync.errors.push(`${kind} ${period}: ${error.message}`); }
      compSync.done++;
    }
  } finally {
    compSync.running = false; compSync.step = ""; compSync.lastRun = new Date().toISOString();
    broadcast("competition", { finished: true, added: compSync.lastAdded });
  }
  return compSync;
}

// Companies House (free API key: developer.company-information.service.gov.uk)
const chKey = async () => process.env.COMPANIES_HOUSE_API_KEY || (await settingsStore.get()).companiesHouseApiKey || "";
async function chGet(url, accept = "application/json") {
  const key = await chKey();
  if (!key) throw new Error("Add a Companies House API key in Settings → Connections.");
  const res = await fetch(url.startsWith("http") ? url : `${COMP.CH_API}${url}`, { headers: { authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}`, accept }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (res.status === 401) throw new Error("Companies House rejected the API key.");
  if (!res.ok) throw new Error(`Companies House returned HTTP ${res.status}`);
  return accept.includes("json") ? res.json() : res.text();
}
async function chAccounts(number) {
  const hist = await chGet(`/company/${encodeURIComponent(number)}/filing-history?category=accounts&items_per_page=6`);
  const filings = (hist.items || []).map((f) => ({ date: f.date, description: (f.description || "").replace(/-/g, " "), type: f.type, meta: f.links && f.links.document_metadata })).slice(0, 6);
  const merged = { stock: new Map(), turnover: new Map(), cash: new Map() };
  let parsed = 0;
  for (const f of filings.slice(0, 3)) {
    if (!f.meta) continue;
    try {
      const meta = await chGet(f.meta);
      if (!meta.resources || !meta.resources["application/xhtml+xml"]) { f.format = "PDF only"; continue; }
      const doc = await chGet(meta.links.document, "application/xhtml+xml");
      const a = COMP.parseAccountsIxbrl(doc);
      for (const k of Object.keys(merged)) for (const x of a[k]) if (!merged[k].has(x.date)) merged[k].set(x.date, x.value);
      f.format = "digital"; parsed++;
    } catch (error) { f.error = error.message; }
  }
  const list = (m) => [...m.entries()].map(([date, value]) => ({ date, value })).sort((a, b) => b.date.localeCompare(a.date));
  return { fetchedAt: new Date().toISOString(), filings: filings.map(({ meta, ...rest }) => rest), parsed, stock: list(merged.stock), turnover: list(merged.turnover), cash: list(merged.cash) };
}

const yourCodes = async () => [...new Set((await productStore.list()).filter((p) => p.status !== "archived").map((p) => String(p.commodityCode || "").slice(0, 8)).filter((c) => /^\d{8}$/.test(c)))];
function summaryAnalysis(sum, codes) {
  const overlap = sum.codes.filter((c) => codes.some((y) => c.startsWith(y.slice(0, 6))));
  return { summaryOnly: true, firstSeen: sum.firstSeen, lastSeen: sum.lastSeen, monthsActive: sum.activeMonths, byYear: sum.byYear, codes: sum.codes, overlapCodes: overlap, newCodes: [], signal: sum.status === "Persistent" ? "steady" : "occasional", note: `Imported in ${sum.activeMonths} months between ${sum.firstSeen.slice(4)}/${sum.firstSeen.slice(0, 4)} and ${sum.lastSeen.slice(4)}/${sum.lastSeen.slice(0, 4)} (${sum.status.toLowerCase() || "pattern unknown"}). Load the monthly history for the month-by-month view.` };
}

async function competitionView() {
  const data = await getCompData();
  const codes = await yourCodes();
  const months = COMP.monthsList(Object.keys(data.importerMonths), 24);
  const comps = (await competitorStore.list()).filter((x) => x.status !== "archived");
  const sumById = new Map((data.summary || []).map((s) => [s.id, s]));
  const byName = new Map();
  for (const [id, co] of Object.entries(data.companies)) { const k = COMP.normalizeName(co.name); if (!byName.has(k)) byName.set(k, []); byName.get(k).push(id); }
  const competitors = comps.map((c) => {
    // a record picked from the 2024–26 summary also picks up monthly records filed under the same company name
    const ids = [...new Set((c.importerIds || []).flatMap((id) => {
      const s = sumById.get(id) || data.companies[id];
      return [id, ...((s && byName.get(COMP.normalizeName(s.name))) || [])];
    }))];
    // merge every matched importer record (some firms import under several names/sites)
    const merged = { name: c.name, m: {} };
    for (const id of ids) { const co = data.companies[id]; if (co) for (const [p, list] of Object.entries(co.m)) merged.m[p] = [...new Set([...(merged.m[p] || []), ...list])]; }
    const hasMonthly = ids.some((id) => data.companies[id]);
    let analysis = null;
    if (hasMonthly && months.length) analysis = COMP.analyseCompany(merged, { months, yourCodes: codes });
    else { const s = ids.map((id) => sumById.get(id)).filter(Boolean)[0]; if (s) analysis = summaryAnalysis(s, codes); }
    const matched = ids.map((id) => { const co = data.companies[id] || sumById.get(id); return co ? { id, name: co.name, postcode: co.postcode, town: co.town || "" } : { id, name: "(not in data)" }; });
    return { ...c, matched, analysis };
  });
  const tracked = new Set(competitors.flatMap((c) => c.matched.map((m) => m.id)));
  const suggestions = months.length ? COMP.similarImporters(data.companies, { months: months.slice(-12), yourCodes: codes, exclude: tracked })
    : (data.summary || []).filter((s) => !tracked.has(s.id)).map((s) => ({ ...s, overlap: s.codes.filter((c) => codes.some((y) => c.startsWith(y.slice(0, 6)))).length }))
      .filter((s) => s.overlap).sort((a, b) => b.overlap * 2 + b.activeMonths / 3 - (a.overlap * 2 + a.activeMonths / 3)).slice(0, 12)
      .map((s) => ({ id: s.id, name: s.name, postcode: s.postcode, town: "", overlap: s.overlap, monthsActive: s.activeMonths, summaryOnly: true }));
  const market = COMP.marketVolume(data.trade, codes).slice(-24);
  const im = Object.keys(data.importerMonths).sort();
  const products = (await productStore.list()).filter((p) => p.status !== "archived").map((p) => ({ name: p.name, code: String(p.commodityCode).slice(0, 8) }));
  return {
    yourCodes: codes, products, months, competitors, suggestions, market,
    status: { importerFrom: im[0] || null, importerTo: im[im.length - 1] || null, importerMonths: im.length, tradeMonths: Object.keys(data.trade).length, summaryCompanies: (data.summary || []).length,
      sync: { running: compSync.running, step: compSync.step, done: compSync.done, total: compSync.total, errors: compSync.errors.slice(-5), lastRun: compSync.lastRun }, hasChKey: Boolean(await chKey()) },
  };
}

async function handleCompetitionApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  const method = request.method;
  if (url.pathname === "/api/competition" && method === "GET") return sendJson(response, 200, { ...(await competitionView()), canEdit: can(user, "edit") });
  if (url.pathname === "/api/competition/search" && method === "GET") {
    const q = COMP.matchKey(url.searchParams.get("q") || "");
    if (q.length < 2) return sendJson(response, 200, { results: [] });
    const data = await getCompData();
    const codes = await yourCodes();
    const pool = new Map();
    for (const [id, co] of Object.entries(data.companies)) pool.set(id, { id, name: co.name, postcode: co.postcode, town: co.town || "", months: Object.keys(co.m).length, codes: [...new Set(Object.values(co.m).flat())] });
    for (const s of data.summary || []) if (!pool.has(s.id)) pool.set(s.id, { id: s.id, name: s.name, postcode: s.postcode, town: "", months: s.activeMonths, codes: s.codes });
    const words = q.split(" ").filter(Boolean);
    const results = [...pool.values()].map((x) => {
      const k = COMP.matchKey(x.name);
      const hit = words.every((w) => k.includes(w));
      return hit ? { ...x, overlap: x.codes.filter((c) => codes.some((y) => c.startsWith(y.slice(0, 6)))).length, codes: undefined, exact: k === q } : null;
    }).filter(Boolean).sort((a, b) => Number(b.exact) - Number(a.exact) || b.months - a.months).slice(0, 15);
    return sendJson(response, 200, { results });
  }
  if (url.pathname === "/api/competition/ch-search" && method === "GET") {
    try { const r = await chGet(`/search/companies?q=${encodeURIComponent(url.searchParams.get("q") || "")}&items_per_page=8`);
      return sendJson(response, 200, { results: (r.items || []).map((i) => ({ number: i.company_number, name: i.title, address: i.address_snippet, status: i.company_status, created: i.date_of_creation })) }); }
    catch (error) { return sendJson(response, 200, { results: [], error: error.message }); }
  }
  if (url.pathname === "/api/competition/sync" && method === "GET") return sendJson(response, 200, compSync);
  if (!can(user, "edit")) return sendError(response, 403, "Your account cannot change competitors.");
  if (url.pathname === "/api/competition/sync" && method === "POST") {
    const body = await readJsonBody(request);
    const months = [6, 12, 24, 30].includes(Number(body.months)) ? Number(body.months) : 24;
    syncCompetition({ months }).catch((error) => { compSync.errors.push(error.message); compSync.running = false; });
    return sendJson(response, 202, { ok: true, started: true });
  }
  const clean = (b) => ({
    name: String(b.name || "").trim().slice(0, 120),
    importerIds: [...new Set((Array.isArray(b.importerIds) ? b.importerIds : []).map((x) => String(x).slice(0, 20)).filter((x) => /^[0-9a-f]{12}$/.test(x)))].slice(0, 10),
    companyNumber: String(b.companyNumber || "").trim().toUpperCase().slice(0, 10),
    website: String(b.website || "").trim().slice(0, 200),
    notes: String(b.notes || "").trim().slice(0, 1000),
  });
  if (url.pathname === "/api/competition/competitors" && method === "POST") {
    const c = clean(await readJsonBody(request));
    if (!c.name) return sendJson(response, 422, { ok: false, errors: { name: "Enter the competitor's name." } });
    if (c.companyNumber && !/^[A-Z0-9]{6,10}$/.test(c.companyNumber)) return sendJson(response, 422, { ok: false, errors: { companyNumber: "Company numbers are 8 characters, like 01234567." } });
    const saved = await competitorStore.create({ ...c, status: "active" }, user.name);
    if (c.companyNumber && (await chKey())) chAccounts(c.companyNumber).then((a) => competitorStore.update(saved.id, (x) => { x.accounts = a; }, "system", "accounts fetched")).then(() => broadcast("competition", {})).catch(() => {});
    return sendJson(response, 201, saved);
  }
  const m = url.pathname.match(/^\/api\/competition\/competitors\/([0-9a-f-]{36})(?:\/(archive|accounts))?$/);
  if (m) {
    const existing = await competitorStore.get(m[1]);
    if (!existing || existing.status === "archived") return sendError(response, 404, "Competitor not found");
    if (!m[2] && method === "PUT") {
      const c = clean(await readJsonBody(request));
      if (!c.name) return sendJson(response, 422, { ok: false, errors: { name: "Enter the competitor's name." } });
      return sendJson(response, 200, await competitorStore.update(m[1], (x) => Object.assign(x, c), user.name, "edited"));
    }
    if (m[2] === "archive" && method === "POST") { await competitorStore.update(m[1], (x) => { x.status = "archived"; }, user.name, "removed"); return sendJson(response, 200, { ok: true }); }
    if (m[2] === "accounts" && method === "POST") {
      if (!existing.companyNumber) return sendJson(response, 422, { ok: false, error: "Add the Companies House number first." });
      try { const a = await chAccounts(existing.companyNumber); await competitorStore.update(m[1], (x) => { x.accounts = a; }, user.name, "accounts fetched"); return sendJson(response, 200, { ok: true, accounts: a }); }
      catch (error) { return sendJson(response, 200, { ok: false, error: error.message }); }
    }
  }
  return sendError(response, 404, "Not found");
}


// ------------------------------------------------------------ arrivals (live AIS + HMRC ports)
const arrFile = join(process.env.DATA_DIR || join(root, "var"), "arrivals.json");
const ais = { vessels: {}, connected: false, tracked: false, lastMessage: null, messages: 0, error: null, startedAt: null, loaded: false };
let aisSockets = [], aisRetry = null, aisDirty = false, aisBackoff = 30_000;
const aisKey = async () => process.env.AISSTREAM_API_KEY || (await settingsStore.get()).aisstreamApiKey || "";
async function loadArrivals() {
  if (ais.loaded) return;
  ais.loaded = true;
  try { ais.vessels = JSON.parse(await readFile(arrFile, "utf8")).vessels || {}; } catch { ais.vessels = {}; }
  ARR.pruneVessels(ais.vessels);
}
async function saveArrivals() {
  if (!aisDirty) return;
  aisDirty = false;
  ARR.pruneVessels(ais.vessels);
  await mkdir(dirname(arrFile), { recursive: true });
  await writeFile(arrFile, JSON.stringify({ vessels: ais.vessels }));
  broadcast("arrivals", { vessels: Object.keys(ais.vessels).length });
}
function stopAis() {
  clearTimeout(aisRetry);
  for (const ws of aisSockets) { try { ws.onclose = null; ws.close(); } catch { /* already closed */ } }
  aisSockets = []; ais.connected = false; ais.tracked = false;
}
function openAisSocket(sub, label) {
  const ws = new WebSocket(ARR.AIS_URL);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { ws.send(JSON.stringify(sub)); if (label === "area") { ais.connected = true; ais.error = null; aisBackoff = 30_000; feeds.report("ais", { connected: true }); } else ais.tracked = true; };
  ws.onmessage = (ev) => {
    try {
      const text = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data);
      const msg = JSON.parse(text);
      if (msg.error) { ais.error = String(msg.error); return; }
      if (ARR.applyMessage(ais.vessels, msg)) { ais.messages++; ais.lastMessage = new Date().toISOString(); aisDirty = true; }
    } catch { /* ignore a bad frame */ }
  };
  ws.onerror = () => { ais.error = ais.error || "Couldn't reach aisstream.io"; };
  ws.onclose = (ev) => {
    if (label === "area") ais.connected = false; else ais.tracked = false;
    if (ev && ev.code === 1008) ais.error = "aisstream.io refused the key";
    if (label === "area") feeds.report("ais", { connected: false, lastError: ais.error || "Connection closed, reconnecting", lastErrorAt: new Date().toISOString() });
    clearTimeout(aisRetry);
    aisRetry = setTimeout(() => startAis().catch(() => {}), aisBackoff);
    aisBackoff = Math.min(aisBackoff * 2, 10 * 60_000);
  };
  aisSockets.push(ws);
}
async function startAis() {
  await loadArrivals();
  stopAis();
  const key = await aisKey();
  if (!key) { ais.error = null; return; }
  if (typeof WebSocket !== "function") { ais.error = "Live ship tracking needs Node.js 22 or newer (run node --version)."; return; }
  ais.startedAt = new Date().toISOString();
  openAisSocket(ARR.subscription(key), "area");
  const mmsis = (await shipmentStore.list()).filter((x) => x.status === "active" && /^\d{9}$/.test(x.mmsi || "")).map((x) => x.mmsi);
  if (mmsis.length) setTimeout(() => openAisSocket(ARR.trackedSubscription(key, mmsis), "tracked"), 1500);
}
setInterval(() => saveArrivals().catch(() => {}), 60_000).unref?.();

// ------------------------------------------------------------ data sources on a constant feed
const H = 3_600_000, M = 60_000;
const feedOk = (detail) => ({ ok: true, detail });
const feedList = [
  { key: "hmrc-quotas", name: "HMRC quota balances", source: "HMRC Trade Tariff API", url: "https://www.trade-tariff.service.gov.uk/quota_search", what: "Live balance of all 72 steel quota lines", intervalMs: 30 * M, firstDelayMs: 4_000,
    run: async () => { const q = await getMeasureQuotas({ force: true }); broadcast("quotas", {}); return feedOk(`${q.lines.filter((l) => l.found).length} lines`); } },
  { key: "dbt-quotas", name: "Quota history", source: "DBT UK trade quotas dataset", url: quotaCsvUrl, what: "Every quota quarter since 2021; fallback balances", intervalMs: 6 * H, firstDelayMs: 6_000,
    run: async () => { const d = await getSteelQuotaRows({ force: true }); return feedOk(`${d.rows.length} steel quota periods`); } },
  { key: "ons", name: "ONS steel price indices", source: "Office for National Statistics", url: "https://www.ons.gov.uk/economy/inflationandpriceindices", what: "UK domestic and imported steel price indices (forecast base)", intervalMs: 12 * H, firstDelayMs: 8_000,
    run: async () => { const r = await runLive("ONS", { force: true }); return r.ok ? feedOk(`${r.added || 0} new values`) : r; } },
  { key: "lme", name: "LME steel prices", source: "Metals-API", url: "https://metals-api.com", what: "Daily LME rebar and scrap prices", intervalMs: 24 * H, firstDelayMs: 10_000, needs: "Metals-API key",
    run: async () => { if (!(await metalsKey())) return { off: true, detail: "Add a Metals-API key" }; const r = await runLive("LME", { force: true }); return r.ok ? feedOk(`${r.added || 0} new values`) : r; } },
  { key: "fx", name: "Exchange rates", source: "Frankfurter (ECB rates)", url: "https://frankfurter.dev", what: "EUR and USD to GBP for quotes", intervalMs: 6 * H, firstDelayMs: 12_000,
    run: async () => { fxCache.clear(); const [eur, usd] = await Promise.all([getFx("EUR"), getFx("USD")]); if (!eur || !usd) throw new Error("No rate returned"); return feedOk(`EUR ${eur.rate.toFixed(4)} · USD ${usd.rate.toFixed(4)}`); } },
  { key: "news", name: "GOV.UK steel news", source: "GOV.UK Atom feeds", url: "https://www.gov.uk/search/news-and-communications", what: "Trade, tariff and carbon announcements", intervalMs: 6 * H, firstDelayMs: 14_000,
    run: async () => { const r = await refreshNews({ force: true }); if (r.errors && r.errors.length >= NEWS.NEWS_FEEDS.length) throw new Error(r.errors[0]); return feedOk(`${r.items.length} items${r.added ? ` · ${r.added} new` : ""}`); } },
  { key: "hmrc-trade", name: "HMRC importers & trade", source: "HMRC uktradeinfo", url: "https://www.uktradeinfo.com", what: "Monthly importer lists and import volumes (competition, arrivals)", intervalMs: 24 * H, firstDelayMs: 20_000,
    run: async () => { const d = await getCompData(); if (!Object.keys(d.importerMonths).length) return { off: true, detail: "Load HMRC history once on Competition" }; if (!compSync.running) await syncCompetition({ months: 3 }); return feedOk(`${Object.keys(d.importerMonths).length} months`); } },
  { key: "companies-house", name: "Competitor accounts", source: "Companies House API", url: "https://developer.company-information.service.gov.uk", what: "Stock and turnover from filed accounts", intervalMs: 24 * H, firstDelayMs: 30_000, needs: "Companies House key",
    run: async () => {
      if (!(await chKey())) return { off: true, detail: "Add a Companies House key" };
      const list = (await competitorStore.list()).filter((c) => c.companyNumber);
      let n = 0;
      for (const c of list) { try { const a = await chAccounts(c.companyNumber); await competitorStore.update(c.id, (x) => { x.accounts = a; }, "feed", "accounts refreshed"); n++; } catch { /* next */ } } // eslint-disable-line no-await-in-loop
      if (list.length && !n) throw new Error("No accounts could be fetched");
      if (n) broadcast("competition", {});
      return feedOk(`${n} of ${list.length} competitors`);
    } },
  { key: "ais", name: "Ship tracking", source: "aisstream.io (AIS)", url: "https://aisstream.io", what: "Live ship positions to UK steel ports", intervalMs: 2 * M, firstDelayMs: 25_000, stream: true, needs: "aisstream.io key",
    run: async () => {
      if (!(await aisKey())) return { off: true, detail: "Add an aisstream.io key" };
      const silent = ais.connected && ais.lastMessage && Date.now() - Date.parse(ais.lastMessage) > 15 * M;
      if (!ais.connected || silent) await startAis(); // reconnect if dropped or gone quiet
      if (ais.error && !ais.connected) throw new Error(ais.error);
      return { ok: true, connected: ais.connected, detail: `${Object.keys(ais.vessels).length} ships · ${ais.messages || 0} messages` };
    } },
  { key: "tariff-codes", name: "Commodity codes", source: "HMRC Trade Tariff API", url: "https://www.trade-tariff.service.gov.uk", what: "Steel commodity codes (chapters 72–73)", intervalMs: 24 * H, firstDelayMs: 40_000,
    run: async () => { const c = await getSteelCommodities({ force: true }); return feedOk(`${(c.commodities || []).length} codes`); } },
  ...FEED_SOURCES.map((src) => ({ key: `prices-${src.toLowerCase()}`, name: `${src} prices`, source: src, what: `${src} price feed (your subscription)`, intervalMs: 6 * H, firstDelayMs: 45_000, needs: `${src} feed URL in .env`,
    run: async () => { const cfg = feedConfig()[src]; if (!cfg || !cfg.configured) return { off: true, detail: "Not connected (or import files on Market prices)" }; const r = await runFeed(src); return r.ok ? feedOk(`${r.added || 0} new prices`) : r; } })),
];
const feeds = createFeedManager({ feeds: feedList, onChange: (v) => broadcast("feeds", v), log: (m) => console.log(`[feed] ${m}`) });

function matchVessel(sh) {
  const vs = Object.values(ais.vessels);
  if (sh.mmsi && ais.vessels[sh.mmsi]) return ais.vessels[sh.mmsi];
  if (sh.imo) { const v = vs.find((x) => x.imo === sh.imo); if (v) return v; }
  if (sh.vessel) { const n = sh.vessel.toUpperCase().replace(/[^A-Z0-9]/g, ""); const v = vs.find((x) => (x.name || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === n); if (v) return v; }
  return null;
}
const vesselView = (v) => v && ({ mmsi: v.mmsi, imo: v.imo || null, name: v.name || null, type: v.type ?? null, length: v.length || null, draught: v.draught || null, draughtUp: v.draughtUp || null,
  destination: v.destination || null, destPort: v.destPort, destPortName: v.destPort ? ARR.portName(v.destPort) : null, eta: v.eta || null, lat: v.lat, lon: v.lon, sog: v.sog ?? null, at: v.at || null,
  area: v.area || null, nearPort: v.nearPort ? ARR.portName(v.nearPort) : null, steelPort: v.steelPort || null, inUk: v.inUk || null,
  nmToPort: v.destPort && Number.isFinite(v.lat) ? Math.round(ARR.distanceNm(v.lat, v.lon, ARR.UK_PORTS.find((p) => p.id === v.destPort).lat, ARR.UK_PORTS.find((p) => p.id === v.destPort).lon)) : null });

async function arrivalsView() {
  await loadArrivals();
  const shipments = (await shipmentStore.list()).filter((x) => x.status !== "archived").map((sh) => ({ ...sh, live: vesselView(matchVessel(sh)) }));
  const tracked = new Set(shipments.map((x) => x.live && x.live.mmsi).filter(Boolean));
  const rank = { high: 0, medium: 1, watch: 2, low: 3, none: 9 };
  const likely = Object.values(ais.vessels)
    .map((v) => ({ v, l: ARR.steelLikelihood(v) }))
    .filter((x) => x.l.level !== "none" && x.l.level !== "low" && (x.v.type === undefined || ARR.isCargo(x.v.type)))
    .sort((a, b) => rank[a.l.level] - rank[b.l.level] || String(b.v.at).localeCompare(String(a.v.at)))
    .slice(0, 80).map((x) => ({ ...vesselView(x.v), likelihood: x.l.level, why: x.l.why, yours: tracked.has(x.v.mmsi) }));
  const counts = { total: Object.keys(ais.vessels).length, inUk: Object.values(ais.vessels).filter((v) => v.inUk && Date.now() - Date.parse(v.inUk.at) < 3 * 86_400_000).length,
    atSteelPorts: Object.values(ais.vessels).filter((v) => v.steelPort && Date.now() - Date.parse(v.steelPort.at) < 3 * 86_400_000).length };
  const data = await getCompData();
  const codes = await yourCodes();
  return {
    ais: { hasKey: Boolean(await aisKey()), connected: ais.connected, tracked: ais.tracked, lastMessage: ais.lastMessage, messages: ais.messages, error: ais.error, nodeOk: typeof WebSocket === "function", counts },
    shipments, likely,
    ports: ARR.UK_PORTS.map(({ id, name }) => ({ id, name })), steelPorts: ARR.STEEL_PORTS.map(({ id, name }) => ({ id, name })),
    hmrc: { ...ARR.portsAndRoutes(data.trade || {}, codes, { months: 12 }), tradeMonths: Object.keys(data.trade || {}).length, oldFormat: (data.tradeVersion || 1) < COMP.TRADE_VERSION && Object.keys(data.trade || {}).length > 0 },
    suppliers: (await supplierStore.list()).filter((x) => x.status !== "archived").map((x) => ({ id: x.id, name: x.name })),
    products: (await productStore.list()).filter((x) => x.status !== "archived").map((x) => ({ id: x.id, name: x.name })),
  };
}

async function handleArrivalsApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  const method = request.method;
  if (url.pathname === "/api/arrivals" && method === "GET") return sendJson(response, 200, { ...(await arrivalsView()), canEdit: can(user, "edit") });
  if (!can(user, "edit")) return sendError(response, 403, "Your account cannot change shipments.");
  const clean = (b) => {
    const c = {
      vessel: String(b.vessel || "").trim().slice(0, 80), mmsi: String(b.mmsi || "").replace(/\D/g, "").slice(0, 9), imo: String(b.imo || "").replace(/\D/g, "").slice(0, 7),
      supplierId: String(b.supplierId || "").slice(0, 40), product: String(b.product || "").trim().slice(0, 120), tonnes: Number(b.tonnes) > 0 ? Math.round(Number(b.tonnes) * 10) / 10 : null,
      loadPort: String(b.loadPort || "").trim().slice(0, 80), ukPort: ARR.UK_PORTS.some((p) => p.id === b.ukPort) ? b.ukPort : "",
      expectedEta: /^\d{4}-\d{2}-\d{2}$/.test(b.expectedEta || "") ? b.expectedEta : "", notes: String(b.notes || "").trim().slice(0, 600),
    };
    const errors = {};
    if (!c.vessel && !c.mmsi && !c.imo) errors.vessel = "Enter the ship's name, MMSI or IMO number.";
    if (c.mmsi && c.mmsi.length !== 9) errors.mmsi = "MMSI numbers are 9 digits.";
    if (c.imo && c.imo.length !== 7) errors.imo = "IMO numbers are 7 digits.";
    return { c, errors };
  };
  if (url.pathname === "/api/arrivals/shipments" && method === "POST") {
    const { c, errors } = clean(await readJsonBody(request));
    if (Object.keys(errors).length) return sendJson(response, 422, { ok: false, errors });
    const saved = await shipmentStore.create({ ...c, status: "active" }, user.name);
    if (c.mmsi) startAis().catch(() => {});
    return sendJson(response, 201, saved);
  }
  const m = url.pathname.match(/^\/api\/arrivals\/shipments\/([0-9a-f-]{36})(?:\/(archive|arrived))?$/);
  if (m) {
    const existing = await shipmentStore.get(m[1]);
    if (!existing || existing.status === "archived") return sendError(response, 404, "Shipment not found");
    if (!m[2] && method === "PUT") {
      const { c, errors } = clean(await readJsonBody(request));
      if (Object.keys(errors).length) return sendJson(response, 422, { ok: false, errors });
      const saved = await shipmentStore.update(m[1], (x) => Object.assign(x, c), user.name, "edited");
      if (c.mmsi !== existing.mmsi) startAis().catch(() => {});
      return sendJson(response, 200, saved);
    }
    if (m[2] === "arrived" && method === "POST") return sendJson(response, 200, await shipmentStore.update(m[1], (x) => { x.status = "arrived"; x.arrivedAt = new Date().toISOString(); }, user.name, "arrived"));
    if (m[2] === "archive" && method === "POST") { await shipmentStore.update(m[1], (x) => { x.status = "archived"; }, user.name, "removed"); return sendJson(response, 200, { ok: true }); }
  }
  return sendError(response, 404, "Not found");
}


// ------------------------------------------------------------ order planner
// What the planner runs on: your saved defaults, with any what-if changes for
// this one plan on top. Bad values are reported and the default is kept.
async function planAssumptions(raw = {}) {
  const ws = await settingsStore.get();
  const defaults = Object.fromEntries(PLAN_ASSUMPTION_KEYS.map((k) => [k, ws[k]]));
  const asked = Object.fromEntries(Object.entries(raw && typeof raw === "object" ? raw : {}).filter(([k]) => PLAN_ASSUMPTION_KEYS.includes(k)));
  const { settings, errors } = validateSettings(asked, ws);
  const values = Object.fromEntries(PLAN_ASSUMPTION_KEYS.map((k) => [k, errors[k] ? defaults[k] : settings[k]]));
  const changed = PLAN_ASSUMPTION_KEYS.filter((k) => values[k] !== defaults[k]);
  return { values, defaults, changed, errors, limits: ASSUMPTION_LIMITS, savedAt: ws.updatedAt || null,
    approaches: ws.approaches, approachLabels: PLAN.APPROACHES,
    cbam: { status: UK_CBAM.status, rows: [
      { label: "Carbon price", value: `£${UK_CBAM.cbamRatePerT}/t CO₂` },
      { label: "Electric-arc steel", value: `${UK_CBAM.cbamEafTPerT} t CO₂/t` },
      { label: "Blast-furnace steel", value: `${UK_CBAM.cbamBofTPerT.toFixed(1)} t CO₂/t` },
      { label: "Route not known", value: `${UK_CBAM.cbamUnknownTPerT.toFixed(1)} t CO₂/t` },
      { label: "Starts", value: "1 Jan 2027" },
    ] },
    fixed: [
      { label: "CBAM passed into UK prices", value: `${UK_CBAM.forecastCbamPassThroughPct}%`, note: "Forecast model" },
      { label: "Duty if the quota runs out", value: "50% of customs value", note: "UK steel safeguard rate outside quota (Trade Remedies notice)" },
      { label: "Chance the quota runs out", value: "Projected from live HMRC usage", note: "Burn rate so far this quarter, to your arrival date" },
      { label: "Forecast damping", value: `${Math.round(FC.FORECAST_DEFAULTS.damping * 100)}% a month`, note: "Each month ahead keeps this share of the previous month's drift" },
      { label: "Forecast range", value: "80% band", note: "From the index's own month-to-month swings" },
      { label: "Forecast trend window", value: `${FC.FORECAST_DEFAULTS.trendMonths} months`, note: "ONS steel price index history used for the trend" },
      { label: "Reliability buffer", value: "Late share × half the lead time", note: "Extra safety stock for suppliers who deliver late" },
      { label: "Month length", value: "30.4 days", note: "Converts lead times and cover" },
    ] };
}

async function orderPlan(body = {}) {
  const product = await productStore.get(body.productId);
  if (!product || product.status === "archived") return { ok: false, error: "Pick a product." };
  const view = await productView(product);
  const m = view.metrics;
  const tonnage = Number(body.tonnage) > 0 ? Math.round(Number(body.tonnage) * 10) / 10 : (m.needT || m.suggestedOrderT || product.moqT || product.monthlyUsageT || 25);
  const today = new Date().toISOString().slice(0, 10);
  const needBy = /^\d{4}-\d{2}-\d{2}$/.test(body.needBy || "") ? body.needBy : (m.stockOutDate && m.stockOutDate > today ? m.stockOutDate : addDaysIso(today, 30));
  const appetite = PLAN.approachOf(body.appetite);
  const cbam = body.cbam === true;
  const code8 = String(product.commodityCode).slice(0, 8);
  const assumptions = await planAssumptions(body.assume);
  const assume = assumptions.values;
  const profile = PLAN.thresholdsFor(appetite, { ...assume, approaches: assumptions.approaches });

  // suppliers, priced for this exact product, tonnage and their own lead time
  const rows = await compareSuppliers({ productId: product.id, tonnage, arrival: "lead", cbam, assume });
  const sups = new Map((await supplierStore.list()).map((x) => [x.id, x]));
  const toOption = (r) => {
    const s = sups.get(r.id) || {};
    const leadDays = s.leadTimeMax != null ? s.leadTimeMax * (s.leadTimeUnit === "days" ? 1 : 7) : s.leadTimeMin != null ? s.leadTimeMin * (s.leadTimeUnit === "days" ? 1 : 7) : null;
    const latest = [...(s.quotes || [])].sort((a, b) => (b.date + (b.at || "")).localeCompare(a.date + (a.at || "")))[0];
    return { ...r, arrival: r.importDate || null, leadDays, onTimePct: s.onTimePct ?? null, quoteAgeDays: r.quoteDate ? Math.max(0, Math.round((Date.parse(today) - Date.parse(r.quoteDate)) / 86_400_000)) : null, validUntil: latest ? latest.validUntil || null : null, moqNote: s.moqNote || "", paymentDays: s.paymentDays ?? null, ddp: s.ddp || (s.origin === "UK" ? "na" : ""), isImport: Boolean(s.origin) && s.origin !== "UK" };
  };
  const options = rows.map(toOption);
  const priced = options.filter((o) => Number.isFinite(o.effectivePerT)).sort((a, b) => a.effectivePerT - b.effectivePerT);

  // forecast for this product, from today's best landed price
  const fc = await steelForecast({ coreOnly: true, assume }).catch(() => ({ ok: false }));
  let forecast = null, aheadOptions = [];
  if (fc.ok) {
    const pctAt = (h) => (fc.fromToday[h - 1] ? ((fc.fromToday[h - 1].mid / fc.indexNow) - 1) * 100 : null);
    const priceNow = priced[0] ? priced[0].effectivePerT : product.costPerT;
    forecast = { in1: pctAt(1), in3: pctAt(3), in6: pctAt(6), priceNow, in3Price: fc.fromToday[2] ? priceNow * fc.fromToday[2].mid / fc.indexNow : null,
      band3: fc.fromToday[2] ? [priceNow * fc.fromToday[2].low / fc.indexNow, priceNow * fc.fromToday[2].high / fc.indexNow] : null, drivers: fc.drivers.map((d) => ({ label: d.label, pct: d.pct, kind: d.kind })) };
    aheadOptions = [1, 2, 3].map((n) => { const b = FC.buyAhead({ priceNow, indexNow: fc.indexNow, path: fc.fromToday, monthlyUsageT: product.monthlyUsageT, months: n, costOfCapitalPct: Math.max(fc.costOfCapitalPct, profile.cashRatePct), storagePerTMonth: fc.settings.storagePerTMonth }); return b ? { months: n, netMid: b.netMid, netLow: b.netLow, netHigh: b.netHigh, signal: b.signal, tonnes: b.tonnes } : null; }).filter(Boolean);
  }

  // how safe it is to hold
  const sp = (await stockpileView()).rows.find((r) => r.id === product.id);
  const stockpile = sp ? { score: sp.score, rank: sp.rank, of: (await stockpileView()).rows.length, level: sp.verdict.level, text: sp.verdict.text, volatilityPct: sp.volatilityPct, buyers: sp.parts.buyers.value } : null;

  // market price for this product (its own benchmark first, then the group's)
  const mv = await marketView();
  const gbp = (price, cur) => (mv.fx[cur || "GBP"] ? price * mv.fx[cur || "GBP"] : null);
  const own = mv.series.filter((x) => x.productId === product.id && x.latest).sort((a, b) => b.latest.date.localeCompare(a.latest.date))[0];
  const grp = mv.series.filter((x) => !x.productId && x.group === product.category && x.latest && x.kind !== "index" && x.kind !== "input")[0];
  const comp = mv.competition.find((x) => x.group === product.category && /UK/.test(x.source) && x.latest);
  const bm = own || grp || comp;
  const market = { benchmark: bm ? gbp(bm.latest.price, bm.currency) : null, benchmarkLabel: bm ? (own ? `${bm.source} price for this product` : bm.computed ? "UK average of your quotes" : `${bm.source} ${product.category} price`) : null, benchmarkDate: bm ? bm.latest.date : null, yourCost: product.costPerT, target: product.targetBuyPrice ?? null };

  // competition on this code
  const data = await getCompData();
  const vol = COMP.marketVolume(data.trade || {}, [code8]).slice(-12);
  const last = vol[vol.length - 1] || null;
  const months12 = COMP.monthsList(Object.keys(data.importerMonths), 12);
  const buyers = STOCK.buyerCount(code8, { companies: months12.length ? data.companies : null, months: months12, summary: data.summary });
  const cv = await competitionView();
  const rivals = cv.competitors.filter((c) => c.analysis && (c.analysis.codes || []).some((x) => x.slice(0, 6) === code8.slice(0, 6))).map((c) => ({ name: c.name, signal: c.analysis.signal, note: c.analysis.note, stock: c.accounts && c.accounts.stock[0] ? c.accounts.stock[0] : null, stockPrev: c.accounts && c.accounts.stock[1] ? c.accounts.stock[1] : null }));
  const competition = { volume: vol.map((r) => ({ p: r.p, tonnes: r.tonnes, avg12: r.avg12, perT: r.perT })), month: last ? last.p : null, vsAvgPct: last ? last.vsAvgPct : null, buyers, rivals, steppingUp: rivals.filter((r) => r.signal === "stepping-up").map((r) => r.name), hasData: vol.length > 0 };

  // quota for this product's category
  let quota = null, quotaLines = [];
  if (view.steelCategory) {
    try {
      const q = await getMeasureQuotas();
      quotaLines = q.lines.filter((l) => l.categoryId === view.steelCategory.id).map(({ orderNumber, origin, residual, balanceT, usedShare, runOutDate, risk, endDate, nextStartDate }) => ({ orderNumber, origin, residual, balanceT, usedShare, runOutDate, risk, endDate, nextStartDate }));
      const origins = new Set(priced.map((o) => o.origin));
      quota = quotaLines.find((l) => origins.has("France") || origins.has("Italy") || origins.has("Spain") ? l.origin === "European Union" : false) || quotaLines.find((l) => l.residual) || quotaLines[0] || null;
      if (quota) {
        const qh = await steelQuotaHistory().catch(() => null);
        const hl = qh && qh.lines.find((x) => x.orderNumber === quota.orderNumber);
        if (hl) quota = { ...quota, history: { quarters: hl.quarters, avgFillPct: hl.avgFillPct, exhaustedCount: hl.exhaustedCount, recentQuarters: hl.recentQuarters, dayFullMedian: hl.dayFullMedian, fullOn: hl.outlook && hl.outlook.fullOn, safeUntil: hl.outlook && hl.outlook.safeUntil, verdict: hl.outlook && hl.outlook.verdict } };
      }
    } catch { /* quota feed down: carry on without it */ }
  }

  const intel = NEWS.notesFor(await liveNotes(), { productId: product.id, group: product.category, supplierId: "__none__", date: needBy })
    .concat((await liveNotes()).filter((n) => n.scope === "supplier" && priced.some((o) => o.id === n.targetId) && NEWS.noteActive(n, needBy) && n.effectUnit !== "none"));
  const productFacts = { id: product.id, name: product.name, category: product.category, commodityCode: product.commodityCode, steelCategory: view.steelCategory, costPerT: product.costPerT, targetBuyPrice: product.targetBuyPrice ?? null,
    monthlyUsageT: product.monthlyUsageT, stockT: m.stockNowT, coverMonths: m.coverMonths, stockOutDate: m.stockOutDate, latestOrderDate: m.latestOrderDate, suggestedOrderT: m.suggestedOrderT, needT: m.needT, minOrderT: m.minOrderT, moqT: product.moqT ?? null, status: m.status, reason: m.reason };
  // Would two suppliers beat one? Price each candidate at the split tonnages.
  let split = null;
  try {
    const singles = PLAN.scoreOptions(options, { needBy, appetite, thresholds: { ...assume, approaches: assumptions.approaches } });
    const tonnages = PLAN.splitTonnages(tonnage, singles, product.monthlyUsageT || 0);
    const table = new Map();
    const priceRuns = await Promise.all(tonnages.map((t) => compareSuppliers({ productId: product.id, tonnage: t, arrival: "lead", cbam, assume }).then((rs) => [t, rs])));
    for (const [t, rs] of priceRuns) for (const r of rs) if (Number.isFinite(r.effectivePerT)) table.set(`${r.id}|${t}`, toOption(r));
    split = PLAN.bestSplits({ total: tonnage, needBy, usagePerMonth: product.monthlyUsageT || 0, appetite, thresholds: { ...assume, approaches: assumptions.approaches }, singles,
      table: (id, t) => table.get(`${id}|${t}`) || null, extraOrderCost: assume.splitOrderCost ?? 150 });
  } catch (error) { split = { error: error.message, splits: [] }; }

  const rec = PLAN.recommend({ product: productFacts, tonnage, needBy, appetite, options, forecast, aheadOptions, stockpile, quota, market, competition, intel, thresholds: { ...assume, approaches: assumptions.approaches } });
  return { ok: true, today, product: productFacts, inputs: { tonnage, needBy, appetite, cbam }, appetites: PLAN.APPETITE, assumptions, split, options: rec.scored || [], unpriced: options.filter((o) => !Number.isFinite(o.effectivePerT)).map((o) => ({ id: o.id, name: o.name, error: o.error })),
    forecast, aheadOptions, stockpile, market, competition, quota, quotaLines, intel: intel.map((n) => ({ id: n.id, title: n.title, scope: n.scope, targetName: n.targetName || n.targetId, effectUnit: n.effectUnit, effectValue: n.effectValue, effectiveFrom: n.effectiveFrom, by: n.by })), recommendation: rec };
}


// One draft order from a product + supplier, priced through the full cost model.
async function createPlannedOrder({ productId, supplierId, tonnage, cbam, timing, reasons, note, assume, by = "system", starter = false, role = "chosen", packageT, packageId }) {
  const s = await supplierStore.get(supplierId);
  if (!s) return { ok: false, error: "Pick a supplier." };
  const asm = await planAssumptions(assume);
  const b = await supplierBreakdown(s, { productId, tonnage: Number(tonnage) || undefined, cbam: cbam === true, assume: asm.values, packageT });
  if (!b.ok) return { ok: false, error: b.error };
  const inputs = { ...b.scenarioInputs, notes: `${note ? `${note}\n` : ""}From the order planner: ${s.name}, ${b.inputs.tonnage} t, landed £${Math.round(b.effectivePerT)}/t with every cost counted.` };
  const result = await runScenario(inputs, cbam === true ? { cbamStartDate: "0000-01-01" } : { cbamEnabled: false });
  if (!result.ok) return { ok: false, error: Object.values(result.errors || {})[0] || "Could not price this order." };
  const saved = await store.create({ inputs: result.inputs, result, starter: Boolean(starter), plan: { role: role === "alternative" ? "alternative" : "chosen", assumptionsChanged: Object.fromEntries(asm.changed.map((k) => [k, { value: asm.values[k], default: asm.defaults[k] }])), supplierId: s.id, productId, effectivePerT: b.effectivePerT, worstPerT: b.worstPerT, timing: timing || null, packageId: packageId || null, packageT: Number(packageT) || null, reasons: Array.isArray(reasons) ? reasons.slice(0, 8).map((x) => String(x).slice(0, 300)) : [] } }, by);
  return { ok: true, id: saved.id };
}

// One load per supplier with everything that needs ordering from them, so
// their minimum order is met by combining products rather than overbuying one.
async function orderPackage({ cbam = false } = {}) {
  const products = (await productStore.list()).filter((p) => p.status !== "archived");
  const views = await Promise.all(products.map(async (p) => ({ p, m: (await productView(p)).metrics })));
  const row = ({ p, m }) => ({ productId: p.id, name: p.name, category: p.category, needT: m.needT ?? m.suggestedOrderT, usage: p.monthlyUsageT || 0, coverMonths: m.coverMonths, status: m.status });
  const lines = views.filter((x) => ["critical", "reorder", "low"].includes(x.m.status) && (x.m.needT ?? x.m.suggestedOrderT) > 0).map(row);
  if (!lines.length) return { ok: true, best: null, options: [], lines: [] };
  const fillers = views.filter((x) => !lines.some((l) => l.productId === x.p.id) && (x.p.monthlyUsageT || 0) > 0).map(row);
  const suppliers = (await supplierStore.list()).filter((x) => x.status !== "archived" && x.standing !== "hold");
  // landed £/t for every product from every supplier, priced as part of a full load
  const prices = new Map();
  await Promise.all([...lines, ...fillers].map(async (l) => {
    const rows = await compareSuppliers({ productId: l.productId, tonnage: Math.max(l.needT || 0, l.usage || 0, 1), packageT: 1000, arrival: "lead", cbam }).catch(() => []);
    for (const r of rows) if (Number.isFinite(r.effectivePerT)) prices.set(`${r.id}|${l.productId}`, r.effectivePerT);
  }));
  const ws = await settingsStore.get();
  const plan = planPackages({ lines, fillers, suppliers, price: (sid, pid) => prices.get(`${sid}|${pid}`), ratePct: ws.costOfCapitalPct, storagePerTMonth: ws.forecastStoragePerTMonth ?? 2 });
  return { ok: true, lines, ...plan };
}

// Plan an order for several products: pick the products, size each line from
// demand, meet every supplier's minimum load, and rank single-supplier and
// two-supplier scenarios with the full supplier cost model.
async function basketPlan(body = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const all = (await productStore.list()).filter((p) => p.status !== "archived");
  const views = await Promise.all(all.map(async (p) => ({ p, m: (await productView(p)).metrics })));
  const appetite = PLAN.approachOf(body.appetite);
  const cbam = body.cbam === true;
  const assumptions = await planAssumptions(body.assume);
  const assume = assumptions.values;
  const thresholds = { ...assume, approaches: assumptions.approaches };
  const qty = body.quantities && typeof body.quantities === "object" ? body.quantities : {};
  const ids = Array.isArray(body.productIds) && body.productIds.length ? body.productIds : views.filter((x) => ["critical", "reorder", "low"].includes(x.m.status)).map((x) => x.p.id);
  const productRows = views.map(({ p, m }) => ({ id: p.id, name: p.name, category: p.category, status: m.status, stockT: m.stockNowT, coverMonths: m.coverMonths, stockOutDate: m.stockOutDate, usage: p.monthlyUsageT || 0, needT: m.needT ?? m.suggestedOrderT ?? 0 }));
  const items = productRows.filter((r) => ids.includes(r.id)).map((r) => {
    const q = Number(qty[r.id]);
    const needT = q > 0 ? Math.round(q * 10) / 10 : r.needT > 0 ? r.needT : Math.max(1, Math.ceil(r.usage || 1));
    return { productId: r.id, name: r.name, category: r.category, needT, usage: r.usage, needBy: r.stockOutDate && r.stockOutDate > today ? r.stockOutDate : addDaysIso(today, 30) };
  });
  const sups = await supplierStore.list();
  const supMap = new Map(sups.map((x) => [x.id, x]));
  const suppliers = sups.filter((x) => x.status !== "archived" && x.standing !== "hold");
  // each product priced by every supplier with their own quote, terms and lead time, as part of a full load
  const lines = new Map();
  await Promise.all(items.map(async (it) => {
    const rows = await compareSuppliers({ productId: it.productId, tonnage: it.needT, packageT: 1000, arrival: "lead", cbam, assume }).catch(() => []);
    const opts = rows.map((r) => {
      const x = supMap.get(r.id) || {};
      const leadDays = x.leadTimeMax != null ? x.leadTimeMax * (x.leadTimeUnit === "days" ? 1 : 7) : x.leadTimeMin != null ? x.leadTimeMin * (x.leadTimeUnit === "days" ? 1 : 7) : null;
      return { ...r, arrival: r.importDate || null, leadDays, onTimePct: x.onTimePct ?? null, paymentDays: x.paymentDays ?? null, quoteAgeDays: r.quoteDate ? Math.max(0, Math.round((Date.parse(today) - Date.parse(r.quoteDate)) / 86_400_000)) : null };
    });
    for (const o of PLAN.scoreOptions(opts, { needBy: it.needBy, appetite, thresholds })) lines.set(`${o.id}|${it.productId}`, o);
  }));
  const plan = planBasket({ items, suppliers, line: (sid, pid) => lines.get(`${sid}|${pid}`) || null,
    money: { ratePct: assume.costOfCapitalPct, storagePerTMonth: assume.forecastStoragePerTMonth ?? 2, splitOrderCost: assume.splitOrderCost ?? 0, fill: body.fill === "min" ? "min" : "full" } });
  return { ok: true, appetite, cbam, fill: body.fill === "min" ? "min" : "full", products: productRows, selected: items, assumptions, ...plan };
}

// Draft orders for what needs ordering: the planner's pick and the runner-up
// for each product, from your real suppliers' quotes.
async function createStarterOrders(by = "system") {
  const products = (await productStore.list()).filter((p) => p.status !== "archived");
  const views = await Promise.all(products.map(async (p) => ({ p, m: (await productView(p)).metrics })));
  let pick = views.filter((x) => ["critical", "reorder", "low"].includes(x.m.status));
  if (!pick.length) pick = views.slice(0, 3);
  const existing = (await store.list()).filter((x) => x.plan);
  let created = 0;
  const skipped = [];
  for (const { p } of pick) {
    // eslint-disable-next-line no-await-in-loop
    const plan = await orderPlan({ productId: p.id });
    if (!plan.ok || !plan.recommendation.ok) { skipped.push(p.name); continue; }
    const rec = plan.recommendation;
    const chosen = [rec.best, rec.scored.find((o) => o.id !== rec.best.id && !o.lateDays)].filter(Boolean);
    // runner-up first, so the recommendation sits on top of the newest-first list
    for (const [i, o] of [...chosen.entries()].reverse()) {
      if (existing.some((x) => x.plan.productId === p.id && x.plan.supplierId === o.id)) continue;
      // eslint-disable-next-line no-await-in-loop
      const r = await createPlannedOrder({ productId: p.id, supplierId: o.id, tonnage: rec.recTonnes, timing: rec.timing.action, by, starter: true, role: i === 0 ? "chosen" : "alternative",
        reasons: i === 0 ? rec.reasons : [`Runner-up for ${p.name}: £${Math.round(o.effectivePerT)}/t landed.`, ...o.warnings],
        note: i === 0 ? `Recommended for ${p.name} (${p.reason || "needs ordering"}).` : `Alternative for ${p.name}, to compare with the recommendation.` });
      if (r.ok) created++;
    }
  }
  return { ok: true, created, skipped };
}

// The old demo scenarios (HR coil, galvanised sheet …) have nothing to do with
// this business: retire them once and put real draft orders in their place.
async function retireDemoScenarios() {
  const demos = (await store.list()).filter((x) => x.demo);
  if (!demos.length) return;
  for (const d of demos) {
    // eslint-disable-next-line no-await-in-loop
    await store.update(d.id, (x) => { x.status = "archived"; }, "system", "archived", "Demo scenario replaced by orders built from your products and suppliers");
  }
  const r = await createStarterOrders("system");
  console.log(`Retired ${demos.length} demo scenarios; created ${r.created} draft orders from your products and suppliers.`);
}

async function handleOrdersApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  if (url.pathname === "/api/orders/plan" && request.method === "POST") return sendJson(response, 200, await orderPlan(await readJsonBody(request)));
  if (url.pathname === "/api/orders/needs" && request.method === "GET") {
    const list = (await productStore.list()).filter((p) => p.status !== "archived");
    const out = await Promise.all(list.map(async (p) => {
      const v = await productView(p);
      const row = { id: p.id, name: p.name, category: p.category, status: v.metrics.status, reason: v.metrics.reason, needT: v.metrics.needT, suggestedOrderT: v.metrics.suggestedOrderT, coverMonths: v.metrics.coverMonths, stockOutDate: v.metrics.stockOutDate, latestOrderDate: v.metrics.latestOrderDate, monthlyUsageT: p.monthlyUsageT, stockT: v.metrics.stockNowT };
      return row;
    }));
    const rank = { critical: 0, reorder: 1, low: 2, ok: 3, "no-usage": 4 };
    return sendJson(response, 200, { products: out.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || (a.coverMonths ?? 99) - (b.coverMonths ?? 99)) });
  }
  if (url.pathname === "/api/orders/basket" && request.method === "POST") return sendJson(response, 200, await basketPlan(await readJsonBody(request)));
  if (url.pathname === "/api/orders/basket/save" && request.method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create orders.");
    const body = await readJsonBody(request);
    const parts = (Array.isArray(body.parts) ? body.parts : []).slice(0, 4);
    if (!parts.length) return sendJson(response, 422, { ok: false, error: "Nothing to order." });
    const ids = [];
    for (const part of parts) {
      const lines = (Array.isArray(part.lines) ? part.lines : []).filter((l) => l && l.productId && Number(l.tonnes) > 0).slice(0, 12);
      const packageT = Math.round(lines.reduce((n, l) => n + Number(l.tonnes), 0) * 10) / 10;
      const packageId = randomUUID();
      for (const [i, l] of lines.entries()) {
        // eslint-disable-next-line no-await-in-loop
        const r = await createPlannedOrder({ productId: l.productId, supplierId: part.supplierId, tonnage: Number(l.tonnes), cbam: body.cbam === true, packageT, packageId, assume: body.assume,
          note: `One load, line ${i + 1} of ${lines.length}: ${packageT} t from this supplier${parts.length > 1 ? `, part of a ${parts.length}-supplier order` : ""}.`, by: user.name });
        if (!r.ok) return sendJson(response, 422, { ...r, saved: ids });
        ids.push(r.id);
      }
    }
    return sendJson(response, 201, { ok: true, ids });
  }
  if (url.pathname === "/api/orders/package" && request.method === "GET") return sendJson(response, 200, await orderPackage({ cbam: url.searchParams.get("cbam") === "on" }));
  if (url.pathname === "/api/orders/package/save" && request.method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create orders.");
    const body = await readJsonBody(request);
    const items = (Array.isArray(body.items) ? body.items : []).filter((x) => x && x.productId && Number(x.tonnes) > 0).slice(0, 12);
    if (!body.supplierId || !items.length) return sendJson(response, 422, { ok: false, error: "Nothing to order." });
    const packageT = Math.round(items.reduce((n, x) => n + Number(x.tonnes), 0) * 10) / 10;
    const packageId = randomUUID();
    const ids = [];
    for (const [i, it] of items.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const r = await createPlannedOrder({ productId: it.productId, supplierId: body.supplierId, tonnage: Number(it.tonnes), cbam: body.cbam === true, packageT, packageId,
        note: `Packaged load ${i + 1} of ${items.length}: ${packageT} t in one order to meet the minimum load.`, by: user.name });
      if (!r.ok) return sendJson(response, 422, { ...r, saved: ids });
      ids.push(r.id);
    }
    return sendJson(response, 201, { ok: true, ids, packageId, packageT });
  }
  if (url.pathname === "/api/orders/plan/save-split" && request.method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create orders.");
    const body = await readJsonBody(request);
    const parts = Array.isArray(body.parts) ? body.parts.slice(0, 4) : [];
    if (parts.length < 2) return sendJson(response, 422, { ok: false, error: "A split needs at least two suppliers." });
    const ids = [];
    for (const [i, part] of parts.entries()) {
      // eslint-disable-next-line no-await-in-loop
      const r = await createPlannedOrder({ productId: body.productId, supplierId: part.supplierId, tonnage: part.tonnage, cbam: body.cbam === true, timing: body.timing, reasons: body.reasons,
        note: `Split order, part ${i + 1} of ${parts.length}: ${parts.map((p) => `${p.tonnage} t ${p.name || ""}`.trim()).join(" + ")}.`, by: user.name });
      if (!r.ok) return sendJson(response, 422, { ...r, saved: ids });
      ids.push(r.id);
    }
    return sendJson(response, 201, { ok: true, ids });
  }
  if (url.pathname === "/api/orders/plan/save" && request.method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create orders.");
    const body = await readJsonBody(request);
    const r = await createPlannedOrder({ ...body, by: user.name });
    return r.ok ? sendJson(response, 201, r) : sendJson(response, 422, r);
  }
  if (url.pathname === "/api/orders/assumptions" && request.method === "GET") {
    const a = await planAssumptions({});
    return sendJson(response, 200, { ...a, standard: Object.fromEntries(PLAN_ASSUMPTION_KEYS.map((k) => [k, SETTINGS_DEFAULTS[k]])), standardApproaches: PLAN.APPROACH_DEFAULTS, updatedBy: (await settingsStore.get()).updatedBy || null, canEdit: can(user, "edit") });
  }
  if (url.pathname === "/api/orders/starter" && request.method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create orders.");
    return sendJson(response, 201, await createStarterOrders(user.name));
  }
  return sendError(response, 404, "Not found");
}

async function handleBenchmarkApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  const method = request.method;
  if (url.pathname === "/api/benchmarks" && method === "GET") return sendJson(response, 200, await marketView());
  if (url.pathname === "/api/benchmarks/events" && method === "GET") {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    response.write(`event: hello\ndata: {"listeners":${listeners.size + 1}}\n\n`);
    listeners.add(response);
    request.on("close", () => listeners.delete(response));
    return;
  }
  const liveMatch = url.pathname.match(/^\/api\/benchmarks\/live\/(ONS|LME)\/run$/);
  if (liveMatch && method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot run feeds.");
    return sendJson(response, 200, await runLive(liveMatch[1], { force: true }));
  }
  if (method !== "GET" && !can(user, "edit")) return sendError(response, 403, "Your account cannot change market prices.");
  if (url.pathname === "/api/benchmarks" && method === "POST") {
    const body = await readJsonBody(request);
    const { series, errors, valid } = BM.validateSeries(body);
    if ((await liveSeries()).some((x) => x.name.toLowerCase() === series.name.toLowerCase())) errors.name = "A series with this name already exists.";
    if (!valid || errors.name) return sendJson(response, 422, { ok: false, errors });
    const created = await benchmarkStore.create({ ...series, status: "active", points: [] }, user.name);
    return sendJson(response, 201, created);
  }
  if (url.pathname === "/api/benchmarks/import" && method === "POST") {
    const body = await readJsonBody(request, 2_000_000);
    const parsed = Array.isArray(body.rows) ? BM.parseBenchmarkTable(body.rows, { defaultSeries: body.defaultSeries }) : BM.parseBenchmarkTable(body.text || "", { defaultSeries: body.defaultSeries });
    if (!body.commit) return sendJson(response, 200, { format: parsed.format, count: parsed.rows.length, errors: parsed.errors.slice(0, 20), plan: BM.planImport(parsed.rows, await liveSeries()) });
    const res = await importBenchmarkRows(parsed.rows, body.mapping || {}, user.name, "import");
    broadcast("prices", { source: "import" });
    return sendJson(response, 200, res);
  }
  const feedMatch = url.pathname.match(/^\/api\/benchmarks\/feeds\/([A-Za-z]+)\/run$/);
  if (feedMatch && method === "POST") {
    const source = FEED_SOURCES.find((s) => s.toLowerCase() === feedMatch[1].toLowerCase());
    if (!source) return sendError(response, 404, "Unknown feed");
    return sendJson(response, 200, await runFeed(source));
  }
  const m = url.pathname.match(/^\/api\/benchmarks\/([0-9a-f-]{36})(?:\/(archive|points)(?:\/(\d{4}-\d{2}-\d{2}))?)?$/);
  if (!m) return sendError(response, 404, "Not found");
  const [, id, sub, date] = m;
  const existing = await benchmarkStore.get(id);
  if (!existing || existing.status === "archived") return sendError(response, 404, "Series not found");
  if (!sub && method === "PUT") {
    const { series, errors, valid } = BM.validateSeries({ ...existing, ...(await readJsonBody(request)) });
    if (!valid) return sendJson(response, 422, { ok: false, errors });
    return sendJson(response, 200, await benchmarkStore.update(id, (x) => Object.assign(x, series), user.name, "edited"));
  }
  if (sub === "archive" && method === "POST") {
    await benchmarkStore.update(id, (x) => { x.status = "archived"; }, user.name, "archived");
    return sendJson(response, 200, { ok: true });
  }
  if (sub === "points" && method === "POST" && !date) {
    const { point, errors, valid } = BM.validatePoint(await readJsonBody(request));
    if (!valid) return sendJson(response, 422, { ok: false, errors });
    const sym = { GBP: "£", EUR: "€", USD: "$" }[existing.currency];
    setTimeout(() => broadcast("prices", { source: "manual" }), 0);
    return sendJson(response, 201, await benchmarkStore.update(id, (x) => { x.points = BM.mergePoints(x.points || [], [{ ...point, via: "manual", by: user.name, at: new Date().toISOString() }]); },
      user.name, "price added", `${sym}${point.price}/t on ${point.date}${point.note ? ` · ${point.note}` : ""}`));
  }
  if (sub === "points" && date && method === "DELETE") {
    return sendJson(response, 200, await benchmarkStore.update(id, (x) => { x.points = (x.points || []).filter((p) => p.date !== date); }, user.name, "price removed", date));
  }
  sendError(response, 405, "Method not allowed");
}

// ------------------------------------------------------------ settings API

// Latest real value of each data point, read from what's already loaded
// (never triggers a fetch), so the schema page shows live examples.
async function schemaSamples() {
  const out = {};
  const safe = async (key, fn) => { try { const v = await fn(); if (v) out[key] = v; } catch { /* no sample */ } };
  const lastPoint = (series) => { const pts = (series && series.points) || []; return pts.length ? pts[pts.length - 1] : null; };
  const bms = await benchmarkStore.list().catch(() => []);
  await safe("hmrc-quotas", () => { const l = measureCache.payload && measureCache.payload.lines.find((x) => x.found); return l && { ...l, unit: "Kilograms → t" }; });
  await safe("dbt-quotas", () => { const r = caches.quotas.payload && caches.quotas.payload.rows.slice(-1)[0]; return r && { ...r, geographicalAreas: r.geographicalAreas.join(", "), commodityCodes: r.commodityCodes.slice(0, 3).join(", ") + (r.commodityCodes.length > 3 ? " …" : ""), categoryIds: r.categoryIds.join(", ") }; });
  await safe("ons", () => { const s = bms.find((x) => String(x.feedKey || "").startsWith("ons:")); const p = lastPoint(s); return p && { date: p.date, price: p.price, series: s.feedKey.slice(4) }; });
  await safe("lme", () => { const s = bms.find((x) => String(x.feedKey || "").startsWith("metals:")); const p = lastPoint(s); return p && { date: p.date, price: p.price, series: s.feedKey.slice(7) }; });
  await safe("fx", () => { const e = fxCache.get("EUR"), u = fxCache.get("USD"); return (e || u) && { eur: e && e.value.rate, usd: u && u.value.rate, date: (e || u).value.date }; });
  await safe("news", async () => { const n = (await getNews()).items || []; return n[0]; });
  await safe("hmrc-trade", async () => {
    const d = await getCompData();
    const months = Object.keys(d.trade || {}).sort();
    const m = months[months.length - 1];
    const codes = m ? Object.entries(d.trade[m]) : [];
    const [code, c] = codes[0] || [];
    const im = Object.values(d.companies || {})[0] || (d.summary || [])[0];
    const top = c ? (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1])[0]?.[0] : () => null;
    return (c || im) && { period: m, code, t: c && c.t, v: c && c.v, origin: c && top(c.o), port: c && top(c.pt), mode: c && top(c.md), name: im && im.name, postcode: im && im.postcode };
  });
  await safe("companies-house", async () => { const c = (await competitorStore.list()).find((x) => x.accounts); const a = c && c.accounts; return a && { stock: a.stock?.[0]?.value, turnover: a.turnover?.[0]?.value, cash: a.cash?.[0]?.value, date: (a.stock?.[0] || a.turnover?.[0] || {}).date }; });
  await safe("ais", () => { const v = Object.values(ais.vessels).find((x) => x.name && Number.isFinite(x.lat)); return v && { ...v, pos: `${v.lat.toFixed(3)}, ${v.lon.toFixed(3)}` }; });
  await safe("tariff-codes", () => caches.commodities.payload && caches.commodities.payload.commodities[0]);
  for (const src of FEED_SOURCES) await safe(`prices-${src.toLowerCase()}`, () => { const s = bms.find((x) => x.source === src && (x.points || []).length); const p = lastPoint(s); return p && { date: p.date, price: p.price, series: s.name, currency: s.currency }; }); // eslint-disable-line no-await-in-loop
  return out;
}

async function handleSettingsApi(request, response, url) {
  const user = currentUser(request) || { name: "unknown", role: "viewer" };
  if (url.pathname === "/api/feeds" && request.method === "GET") return sendJson(response, 200, { feeds: feeds.list(), now: new Date().toISOString() });
  if (url.pathname === "/api/data-schema" && request.method === "GET") return sendJson(response, 200, { ...buildSchema(feeds.list(), await schemaSamples()), now: new Date().toISOString() });
  const fm = url.pathname.match(/^\/api\/feeds\/([a-z0-9-]+)\/refresh$/);
  if (fm && request.method === "POST") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot refresh data sources.");
    if (!feeds.get(fm[1])) return sendError(response, 404, "No such data source");
    return sendJson(response, 200, await feeds.run(fm[1], { manual: true }));
  }
  if (url.pathname === "/api/settings" && request.method === "GET") {
    return sendJson(response, 200, { settings: publicSettings(await settingsStore.get()), catalogueGroups: CATALOGUE_GROUPS, canEdit: can(user, "edit"), metalsKeyFromEnv: Boolean(process.env.METALS_API_KEY) });
  }
  if (url.pathname === "/api/settings" && request.method === "PUT") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot change settings.");
    const { settings, errors, valid } = validateSettings(await readJsonBody(request), await settingsStore.get());
    if (!valid) return sendJson(response, 422, { ok: false, errors });
    const before = await settingsStore.get();
    const saved = await settingsStore.save(settings, user.name);
    if (saved.metalsApiKey && saved.metalsApiKey !== before.metalsApiKey) runLive("LME", { force: true }).catch(() => {});
    if (saved.aisstreamApiKey !== before.aisstreamApiKey) startAis().catch(() => {});
    return sendJson(response, 200, { settings: publicSettings(saved) });
  }
  if (url.pathname === "/api/backup" && request.method === "GET") {
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot download backups.");
    const body = JSON.stringify({
      exportedAt: new Date().toISOString(), exportedBy: user.name,
      settings: publicSettings(await settingsStore.get()), products: await productStore.list(), suppliers: await supplierStore.list(), benchmarks: await benchmarkStore.list(), scenarios: await store.list(),
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
    planned: Boolean(s.plan),
    planRole: s.plan ? s.plan.role || "chosen" : null,
    packageId: s.plan ? s.plan.packageId || null : null,
    packageT: s.plan ? s.plan.packageT || null : null,
    plannedPerT: s.plan && Number.isFinite(s.plan.effectivePerT) ? s.plan.effectivePerT : null,
    starter: Boolean(s.starter),
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

  const qm = path.match(/^\/api\/steel-quotas\/line\/(\d{6})$/);
  if (qm && method === "GET") {
    try { const r = await quotaLineProfile(qm[1]); return r ? sendJson(response, 200, r) : sendError(response, 404, "No such quota line"); }
    catch (error) { return sendJson(response, 502, { ok: false, error: `Quota data unavailable: ${error.message}` }); }
  }
  if (path === "/api/steel-quotas/history" && method === "GET") {
    try { sendJson(response, 200, await steelQuotaHistory()); }
    catch (error) { sendJson(response, 502, { ok: false, error: `Quota history unavailable: ${error.message}` }); }
    return;
  }
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
    // Kept for old clients: now builds real draft orders instead of demo data.
    if (!can(user, "edit")) return sendError(response, 403, "Your account cannot create scenarios.");
    const r = await createStarterOrders(user.name);
    sendJson(response, 201, { created: r.created, message: r.created ? "" : "Draft orders for these products already exist." });
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

    if (url.pathname.startsWith("/api/benchmarks")) {
      await handleBenchmarkApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/suppliers")) {
      await handleSupplierApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/news")) {
      await handleNewsApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/orders")) {
      await handleOrdersApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/arrivals")) {
      await handleArrivalsApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/competition")) {
      await handleCompetitionApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/forecast")) {
      await handleForecastApi(request, response, url);
      return;
    }

    if (url.pathname === "/api/settings" || url.pathname === "/api/backup" || url.pathname === "/api/data-schema" || url.pathname.startsWith("/api/feeds")) {
      await handleSettingsApi(request, response, url);
      return;
    }

    if (url.pathname.startsWith("/api/scenarios") || url.pathname.startsWith("/api/steel-quotas/line/") || ["/api/calculate", "/api/me", "/api/options", "/api/data-status", "/api/sample-data", "/api/health", "/api/steel-quotas/live", "/api/steel-quotas/history", "/api/tariff-auth-check"].includes(url.pathname)) {
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

feeds.start();
startAis().catch((error) => console.error("Ship tracking failed to start:", error.message));
setTimeout(() => retireDemoScenarios().catch((error) => console.error("Replacing demo scenarios failed:", error.message)), 5_000).unref?.();
applySupplierSheet().catch((error) => console.error("Supplier sheet update failed:", error.message));

server.listen(port, bindHost, () => {
  console.log(`Steel ARB live app running at http://${bindHost}:${port}`);
  console.log(`Home:         http://${bindHost}:${port}/   (assistant; engine v${ENGINE_VERSION}, from ${root})`);
  console.log(`HMRC Trade Tariff access: ${tariffAuthMode === "registered" ? "registered credentials loaded" : "public (no credentials)"}`);
  assistantConfig().then((c) => console.log(`Assistant: ${c.configured ? `ready (${c.label} · ${c.model})` : c.provider === "ollama" ? `Ollama found — run "ollama pull ${c.ollama.model}"` : "not set up — free options on the Assistant page"}`)).catch(() => {});
});
