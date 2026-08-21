const form = document.getElementById("order-form");
const commodityInput = document.getElementById("commodity");
const originInput = document.getElementById("origin");
const tonnageInput = document.getElementById("tonnage");
const basePriceInput = document.getElementById("base-price");
const orderDateInput = document.getElementById("order-date");
const emissionsIntensityInput = document.getElementById("emissions-intensity");
const carbonPriceInput = document.getElementById("carbon-price");
const overseasCarbonPriceInput = document.getElementById("overseas-carbon-price");
const commodityOptions = document.getElementById("commodity-options");
const commoditySource = document.getElementById("commodity-source");
const summaryCommodity = document.getElementById("summary-commodity");
const summaryHeading = document.getElementById("summary-heading");
const summaryCategory = document.getElementById("summary-category");
const summaryOrigin = document.getElementById("summary-origin");
const summaryDate = document.getElementById("summary-date");
const summaryQuarter = document.getElementById("summary-quarter");
const summaryQuotaLine = document.getElementById("summary-quota-line");
const summaryOrderNumber = document.getElementById("summary-order-number");
const summaryBalance = document.getElementById("summary-balance");
const summaryDuty = document.getElementById("summary-duty");
const summaryExposure = document.getElementById("summary-exposure");
const summaryCbamStatus = document.getElementById("summary-cbam-status");
const summaryCbamEmissions = document.getElementById("summary-cbam-emissions");
const summaryCbamCost = document.getElementById("summary-cbam-cost");
const riskList = document.getElementById("risk-list");

let steelData = window.STEEL_COMMODITIES || { commodities: [], count: 0 };
const tradeMeasure = window.STEEL_TRADE_MEASURE || { categories: [] };
const steelQuotas = window.STEEL_QUOTAS || { rows: [], count: 0 };
const commodityLookup = new Map();
let renderRequestId = 0;
const apiBase =
  window.location.protocol === "file:" || window.location.port === "63342"
    ? "http://localhost:3000"
    : "";

const today = new Date();
orderDateInput.value = today.toISOString().slice(0, 10);
emissionsIntensityInput.value = "2.1";
carbonPriceInput.value = "75";
overseasCarbonPriceInput.value = "0";

function optionLabel(commodity) {
  return `${commodity.code} - ${commodity.description}`;
}

function populateCommodityOptions() {
  const fragment = document.createDocumentFragment();
  commodityLookup.clear();

  steelData.commodities.forEach((commodity) => {
    const label = optionLabel(commodity);
    const option = document.createElement("option");
    option.value = label;
    option.label = `${commodity.heading}: ${commodity.headingDescription}`;
    fragment.appendChild(option);
    commodityLookup.set(label, commodity);
    commodityLookup.set(commodity.code, commodity);
  });

  commodityOptions.replaceChildren(fragment);
  const fetchedAt = steelData.liveFetchedAt || steelData.generatedAt;
  commoditySource.textContent = `${steelData.count.toLocaleString("en-GB")} declarable steel commodity records loaded from GOV.UK Trade Tariff chapters 72 and 73${fetchedAt ? ` at ${formatDateTime(fetchedAt)}` : ""}.`;
}

function formatDate(value) {
  if (!value) {
    return "Not selected";
  }

  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(`${value}T00:00:00`));
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatTonnes(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "Not available";
  }

  return `${value.toLocaleString("en-GB", {
    maximumFractionDigits: 3,
  })} tonnes`;
}

function formatCurrency(value) {
  if (!Number.isFinite(value)) {
    return "Not available";
  }

  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatEmissions(value) {
  if (!Number.isFinite(value)) {
    return "Not available";
  }

  return `${value.toLocaleString("en-GB", {
    maximumFractionDigits: 3,
  })} tCO2e`;
}

function findSelectedCommodity() {
  const value = commodityInput.value.trim();

  if (!value) {
    return null;
  }

  const enteredCode = value.match(/^\d{8,10}/)?.[0] || "";
  const lookupCode = enteredCode.length === 8 ? `${enteredCode}00` : enteredCode;
  const directMatch =
    commodityLookup.get(value) ||
    commodityLookup.get(value.slice(0, 10)) ||
    commodityLookup.get(lookupCode);

  if (directMatch) {
    return directMatch;
  }

  const category = findSteelMeasureCategory(lookupCode);

  if (!category) {
    return null;
  }

  return {
    code: lookupCode,
    suffix: "",
    description: "Manually entered steel trade-measure commodity code",
    chapter: lookupCode.slice(0, 2),
    chapterTitle: lookupCode.startsWith("72") ? "Iron and steel" : "Articles of iron or steel",
    heading: lookupCode.slice(0, 4),
    headingDescription: category.name,
    manuallyEntered: true,
  };
}

function parseNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function findSteelMeasureCategory(commodityCode) {
  if (!commodityCode) {
    return null;
  }

  return (
    tradeMeasure.categories.find((category) =>
      category.commodityPrefixes.some((prefix) => commodityCode.startsWith(prefix))
    ) || null
  );
}

function getQuotaPeriod(value) {
  if (!value) {
    return null;
  }

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

function isDateWithin(value, startDate, endDate) {
  return value >= startDate && value <= endDate;
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

function findQuotaRow(commodity, category, origin, importDate) {
  if (!commodity || !category || !origin || !importDate || origin === "United Kingdom") {
    return null;
  }

  const matches = steelQuotas.rows
    .filter((row) => row.categoryIds.includes(category.id))
    .filter((row) =>
      row.commodityCodes.some(
        (code) => code === commodity.code || code.startsWith(commodity.code.slice(0, 8))
      )
    )
    .filter((row) => isDateWithin(importDate, row.startDate, row.endDate))
    .map((row) => ({ row, score: geographyScore(row.geographicalAreas, origin) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.orderNumber.localeCompare(b.orderNumber));

  return matches[0]?.row || null;
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
    tariffCost: exposedValue * tradeMeasure.outOfQuotaDutyRate,
    applicable: true,
  };
}

function isCbamLikelyInScope(commodity) {
  return Boolean(commodity && (commodity.code.startsWith("72") || commodity.code.startsWith("73")));
}

function calculateCbam(commodity, origin, orderDate, tonnage, emissionsIntensity, carbonPrice, overseasCarbonPrice) {
  const cbamStartDate = "2027-01-01";
  const isImported = origin && origin !== "United Kingdom";
  const inScope = isCbamLikelyInScope(commodity);
  const active = Boolean(isImported && orderDate >= cbamStartDate && inScope);
  const hasInputs =
    Number.isFinite(tonnage) &&
    Number.isFinite(emissionsIntensity) &&
    Number.isFinite(carbonPrice) &&
    Number.isFinite(overseasCarbonPrice);
  const netCarbonPrice = hasInputs ? Math.max(carbonPrice - overseasCarbonPrice, 0) : null;
  const totalEmissions = hasInputs ? tonnage * emissionsIntensity : null;
  const estimatedCost = active && hasInputs ? totalEmissions * netCarbonPrice : 0;

  let status = "Not applicable";

  if (!commodity) {
    status = "Select a commodity";
  } else if (!isImported) {
    status = "Not applicable for UK-origin goods";
  } else if (!inScope) {
    status = "Not in likely Chapter 72/73 steel scope";
  } else if (orderDate < cbamStartDate) {
    status = "Not active before 1 Jan 2027";
  } else if (!hasInputs) {
    status = "Applies - emissions inputs needed";
  } else {
    status = "Applies - estimate based on manual inputs";
  }

  return {
    active,
    inScope,
    hasInputs,
    status,
    netCarbonPrice,
    totalEmissions,
    estimatedCost,
  };
}

async function loadLiveCommodities() {
  try {
    const response = await fetch(`${apiBase}/api/steel-commodities`);

    if (!response.ok) {
      throw new Error("Live commodity API unavailable");
    }

    steelData = await response.json();
    populateCommodityOptions();
    renderScenario();
  } catch (error) {
    commoditySource.textContent = `${steelData.count.toLocaleString("en-GB")} fallback commodity records loaded. Start the live server for current GOV.UK data.`;
  }
}

async function fetchLiveQuotaCheck(commodity, origin, orderDate, tonnage, basePrice) {
  const params = new URLSearchParams({
    commodity: commodity.code,
    origin,
    date: orderDate,
    tonnage: String(tonnage),
    basePrice: String(basePrice),
  });
  const response = await fetch(`${apiBase}/api/quota-check?${params}`);

  if (!response.ok) {
    throw new Error("Live quota API unavailable");
  }

  return response.json();
}

function getRiskNotes(commodity, origin, orderDate, liveCheck, cbam) {
  const notes = [];
  const date = new Date(`${orderDate}T00:00:00`);
  const cbamStart = new Date("2027-01-01T00:00:00");
  const isImported = origin && origin !== "United Kingdom";
  const commodityText = `${commodity.description} ${commodity.headingDescription}`.toLowerCase();
  const isCoil = commodityText.includes("coil");
  const category = liveCheck?.category || findSteelMeasureCategory(commodity.code);
  const quota = liveCheck?.quota;
  const exposure = liveCheck?.exposure;

  if (isImported) {
    notes.push("Imported material should be checked against the relevant UK steel quota category before purchase.");
  } else {
    notes.push("UK-origin material is outside import tariff and CBAM exposure, but supplier terms and availability still matter.");
  }

  if (category) {
    notes.push(`Steel trade measure match: Category ${category.id}, ${category.name}.`);
  } else {
    notes.push("No steel trade-measure category match found for this commodity code.");
  }

  if (quota) {
    notes.push(`Live quota order ${quota.orderNumber} matched for ${quota.geographicalAreas.join(", ")}.`);
  } else if (category && isImported) {
    notes.push("No live quota row matched for this commodity, origin, and import date.");
  }

  if (exposure && exposure.tariffCost > 0) {
    notes.push(`Potential out-of-quota tariff exposure: ${formatCurrency(exposure.tariffCost)}.`);
  }

  if (isImported && date >= cbamStart) {
    notes.push("Order date is on or after 1 Jan 2027, so CBAM data capture should be part of the order workflow.");
  }

  if (cbam?.active) {
    notes.push(`CBAM estimate: ${formatCurrency(cbam.estimatedCost)} based on ${formatEmissions(cbam.totalEmissions)} and net carbon price ${formatCurrency(cbam.netCarbonPrice)} per tCO2e.`);
  } else if (cbam && isImported && cbam.inScope) {
    notes.push(`CBAM status: ${cbam.status}.`);
  }

  if (isCoil) {
    notes.push("Coil orders should also capture width, thickness, coating, yield loss, and processing capacity.");
  }

  notes.push("Next model fields: tonnage, supplier, payment terms, freight, commodity code, emissions data, and target customer margin.");
  return notes;
}

function renderCbam(cbam) {
  summaryCbamStatus.textContent = cbam.status;
  summaryCbamEmissions.textContent = Number.isFinite(cbam.totalEmissions)
    ? formatEmissions(cbam.totalEmissions)
    : "Enter tonnage and emissions intensity";
  summaryCbamCost.textContent = cbam.active && cbam.hasInputs
    ? formatCurrency(cbam.estimatedCost)
    : "Not applicable";
}

function renderLiveResult(liveCheck) {
  const category = liveCheck.category;
  const quota = liveCheck.quota;
  const exposure = liveCheck.exposure;
  const importDuty = liveCheck.importDuty;

  summaryCategory.textContent = category
    ? `Category ${category.id} - ${category.name}`
    : "Not covered by listed steel trade-measure categories";
  summaryQuarter.textContent = liveCheck.quotaPeriod?.label || "Not selected";
  summaryQuotaLine.textContent = quota
    ? quota.geographicalAreas.join(", ")
    : category
      ? "No matching quota line"
      : "Not applicable";
  summaryOrderNumber.textContent = quota ? quota.orderNumber : "Not available";
  summaryBalance.textContent = quota
    ? `${formatTonnes(quota.balanceTonnes)} remaining of ${formatTonnes(quota.initialVolumeTonnes)} (${quota.status})`
    : "Not available";
  summaryDuty.textContent = importDuty
    ? `${importDuty.label}: ${formatCurrency(importDuty.estimatedCost)}`
    : "Not available";
  summaryExposure.textContent = exposure
    ? exposure.applicable
      ? `${formatCurrency(exposure.tariffCost)} on ${formatTonnes(exposure.excessTonnes)} potentially outside quota`
      : "Not applicable"
    : "Enter tonnage and base price";
}

async function renderScenario() {
  const requestId = (renderRequestId += 1);
  const commodity = findSelectedCommodity();
  const category = commodity ? findSteelMeasureCategory(commodity.code) : null;
  const origin = originInput.value;
  const orderDate = orderDateInput.value;
  const tonnage = parseNumber(tonnageInput.value);
  const basePrice = parseNumber(basePriceInput.value);
  const emissionsIntensity = parseNumber(emissionsIntensityInput.value);
  const carbonPrice = parseNumber(carbonPriceInput.value);
  const overseasCarbonPrice = parseNumber(overseasCarbonPriceInput.value);
  const quotaPeriod = getQuotaPeriod(orderDate);
  const quotaRow = findQuotaRow(commodity, category, origin, orderDate);
  const balanceTonnes = getQuotaBalanceTonnes(quotaRow);
  const initialTonnes = getInitialVolumeTonnes(quotaRow);
  const exposure = calculateExposure(tonnage, basePrice, category, origin, balanceTonnes);
  const cbam = calculateCbam(
    commodity,
    origin,
    orderDate,
    tonnage,
    emissionsIntensity,
    carbonPrice,
    overseasCarbonPrice
  );

  summaryCommodity.textContent = commodity
    ? `${commodity.code} - ${commodity.description}`
    : "Not selected";
  summaryHeading.textContent = commodity
    ? `${commodity.heading} - ${commodity.headingDescription}`
    : "Not selected";
  summaryCategory.textContent = category
    ? `Category ${category.id} - ${category.name}`
    : commodity
      ? "Not covered by listed steel trade-measure categories"
      : "Not selected";
  summaryOrigin.textContent = origin || "Not selected";
  summaryDate.textContent = formatDate(orderDate);
  summaryQuarter.textContent = quotaPeriod ? quotaPeriod.label : "Not selected";
  summaryQuotaLine.textContent = quotaRow
    ? quotaRow.geographicalAreas.join(", ")
    : category && origin && origin !== "United Kingdom"
      ? "No matching quota line"
      : "Not applicable";
  summaryOrderNumber.textContent = quotaRow ? quotaRow.orderNumber : "Not available";
  summaryBalance.textContent = quotaRow
    ? `${formatTonnes(balanceTonnes)} remaining of ${formatTonnes(initialTonnes)} (${quotaRow.status})`
    : "Not available";
  summaryDuty.textContent = "Checking live duty...";
  summaryExposure.textContent = exposure
    ? exposure.applicable
      ? `${formatCurrency(exposure.tariffCost)} on ${formatTonnes(exposure.excessTonnes)} potentially outside quota`
      : "Not applicable"
    : "Enter tonnage and base price";
  renderCbam(cbam);

  if (!commodity || !origin || !orderDate || tonnage === null || basePrice === null) {
    riskList.innerHTML = "<li>Complete all fields to see the first set of checks.</li>";
    return;
  }

  summaryQuotaLine.textContent = "Checking live quota...";
  summaryOrderNumber.textContent = "Checking live quota...";
  summaryBalance.textContent = "Checking live quota...";
  summaryDuty.textContent = "Checking live duty...";
  summaryExposure.textContent = "Checking live quota...";

  try {
    const liveCheck = await fetchLiveQuotaCheck(commodity, origin, orderDate, tonnage, basePrice);

    if (requestId !== renderRequestId) {
      return;
    }

    renderLiveResult(liveCheck);
    riskList.replaceChildren(
      ...getRiskNotes(commodity, origin, orderDate, liveCheck, cbam).map((note) => {
        const item = document.createElement("li");
        item.textContent = note;
        return item;
      })
    );
    return;
  } catch (error) {
    if (requestId !== renderRequestId) {
      return;
    }

    riskList.innerHTML = "<li>Live quota check unavailable. Showing fallback snapshot results if present.</li>";
  }

  riskList.replaceChildren(
    ...getRiskNotes(commodity, origin, orderDate, {
      category,
      quota: quotaRow,
      exposure,
    }, cbam).map((note) => {
      const item = document.createElement("li");
      item.textContent = note;
      return item;
    })
  );
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  renderScenario();
});

[commodityInput, originInput, tonnageInput, basePriceInput, orderDateInput, emissionsIntensityInput, carbonPriceInput, overseasCarbonPriceInput].forEach((input) => {
  input.addEventListener("input", renderScenario);
  input.addEventListener("change", renderScenario);
});

populateCommodityOptions();
renderScenario();
loadLiveCommodities();
