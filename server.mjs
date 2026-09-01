import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import vm from "node:vm";

const port = Number(process.env.PORT || 3000);
const root = process.cwd();
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

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  response.end(JSON.stringify(payload));
}

function sendError(response, statusCode, message) {
  sendJson(response, statusCode, { error: message });
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "steel-arb-prototype/0.1",
    },
  });

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

  const description = geography.attributes.description;

  if (description === "ERGA OMNES") {
    return true;
  }

  if (origin === "European Union") {
    return description === "European Union";
  }

  return description === origin;
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

  return {
    measureTypeId: measureType.id,
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
    .filter((measure) => originMatchesGeography({ attributes: { description: measure.geography } }, origin));

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

async function serveStatic(requestUrl, response) {
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(root, safePath);

  if (!filePath.startsWith(root)) {
    sendError(response, 403, "Forbidden");
    return;
  }

  try {
    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
    });
    response.end(body);
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

function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  // Node's timingSafeEqual requires equal length; use it when available.
  try {
    // eslint-disable-next-line global-require
    return require("node:crypto").timingSafeEqual(ab, bb);
  } catch {
    // Fallback: constant-time-ish comparison
    let mismatch = 0;
    for (let i = 0; i < ab.length; i++) mismatch |= ab[i] ^ bb[i];
    return mismatch === 0;
  }
}

function requireAuth(request, response) {
  if (!AUTH_PASS) return true;
  const header = request.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const idx = decoded.indexOf(":");
    if (idx >= 0) {
      const user = decoded.slice(0, idx);
      const pass = decoded.slice(idx + 1);
      if (timingSafeEqualStr(user, AUTH_USER) && timingSafeEqualStr(pass, AUTH_PASS)) {
        return true;
      }
    }
  }
  response.writeHead(401, {
    "WWW-Authenticate": `Basic realm="${AUTH_REALM.replace(/"/g, "'")}", charset="UTF-8"`,
    "content-type": "text/plain; charset=utf-8",
  });
  response.end("Authentication required");
  return false;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "content-type, authorization",
      });
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

    await serveStatic(url, response);
  } catch (error) {
    console.error(error);
    sendError(response, 500, error.message || "Unexpected server error");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Steel ARB live app running at http://127.0.0.1:${port}`);
});
