const quotaEndpoint =
  "https://data.api.trade.gov.uk/v1/datasets/uk-trade-quotas/versions/latest/reports/quotas-including-current-volumes/data?format=csv&download";

const products = [
  {
    name: "40x40x3 Angle",
    code: "7216210000",
    stock: 10,
    monthlyUse: 35,
    domesticPrice: 680,
    importPrice: 618,
    freight: { eu: 70, turkey: 90 },
  },
  {
    name: "50x40x5 Angle",
    code: "7216210000",
    stock: 30,
    monthlyUse: 100,
    domesticPrice: 800,
    importPrice: 618,
    freight: { eu: 70, turkey: 90 },
  },
  {
    name: "40x10 Flat",
    code: "7214911090",
    stock: 14,
    monthlyUse: 46,
    domesticPrice: 670,
    importPrice: 626,
    freight: { eu: 70, turkey: 90 },
  },
  {
    name: "100x50 Flat",
    code: "7214911090",
    stock: 2,
    monthlyUse: 5,
    domesticPrice: 740,
    importPrice: 626,
    freight: { eu: 70, turkey: 90 },
  },
  {
    name: "25 mm Round",
    code: "7214993900",
    stock: 3,
    monthlyUse: 8,
    domesticPrice: 690,
    importPrice: 613,
    freight: { eu: 70, turkey: 90 },
  },
];

const routeRules = {
  eu: { label: "European Union", match: "European Union", terminal: 18, cbam: 20 },
  turkey: { label: "Turkey", match: "Turkey", terminal: 26, cbam: 24 },
};

const els = {
  product: document.getElementById("product-select"),
  tonnes: document.getElementById("order-tonnes"),
  finance: document.getElementById("finance-rate"),
  domesticTerms: document.getElementById("domestic-terms"),
  importTerms: document.getElementById("import-terms"),
  domesticCard: document.getElementById("domestic-card"),
  euCard: document.getElementById("eu-card"),
  turkeyCard: document.getElementById("turkey-card"),
  quotaStatus: document.getElementById("quota-status"),
  quotaRows: document.getElementById("quota-rows"),
};

let quotaRows = [];

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      field += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some(Boolean)) rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  const [headers, ...records] = rows;
  return records.map((record) =>
    Object.fromEntries(headers.map((header, index) => [header, record[index] || ""]))
  );
}

function money(value) {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function tonnes(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${value.toLocaleString("en-GB", { maximumFractionDigits: 1 })} t`;
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : "n/a";
}

function numberValue(value) {
  if (!value || value === "#NA") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function balanceTonnes(row) {
  const balance = numberValue(row?.quota_definition__balance);
  if (balance === null) return null;
  const unit = String(row?.quota__measurement_unit || "").toLowerCase();
  return unit.includes("kilogram") ? balance / 1000 : balance;
}

function rowCommodityCodes(row) {
  return String(row.quota__commodities || "")
    .split("|")
    .map((code) => code.trim())
    .filter(Boolean);
}

function rowMatchesProduct(row, product) {
  const code10 = product.code;
  const code8 = product.code.slice(0, 8);
  return rowCommodityCodes(row).some((quotaCode) =>
    quotaCode === code10 ||
    quotaCode === code8 ||
    quotaCode.startsWith(code8) ||
    code10.startsWith(quotaCode)
  );
}

function rowFor(label, value, total = false) {
  return `<div class="metric-row${total ? " metric-row--total" : ""}"><span>${label}</span><strong>${value}</strong></div>`;
}

function routeRowsFor(product, routeKey, activeOnly = true) {
  const route = routeRules[routeKey];
  const today = new Date().toISOString().slice(0, 10);
  const matches = quotaRows
    .filter((row) => rowMatchesProduct(row, product))
    .filter((row) => String(row.quota__geographical_areas || "").includes(route.match))
    .sort((a, b) => String(a.quota__order_number).localeCompare(String(b.quota__order_number)));

  if (!activeOnly) return matches;

  return matches
    .filter((row) => row.quota_definition__validity_start_date <= today)
    .filter((row) => today <= row.quota_definition__validity_end_date);
}

function currentRowsFor(product, routeKey) {
  return routeRowsFor(product, routeKey, true);
}

function routeCost(product, routeKey, quotaRow) {
  const route = routeRules[routeKey];
  const orderTonnes = Number(els.tonnes.value) || product.monthlyUse;
  const financeRate = (Number(els.finance.value) || 0) / 100;
  const domesticTerms = Number(els.domesticTerms.value) || 0;
  const importTerms = Number(els.importTerms.value) || 0;
  const balance = balanceTonnes(quotaRow);
  const excess = balance === null ? orderTonnes : Math.max(orderTonnes - balance, 0);
  const quotaExposure = excess * product.importPrice * 0.5;
  const paymentBenefit = product.importPrice * financeRate * Math.max(importTerms - domesticTerms, 0) / 365;
  const total =
    product.importPrice +
    product.freight[routeKey] +
    route.terminal +
    route.cbam +
    quotaExposure / orderTonnes -
    paymentBenefit;

  return { route, orderTonnes, balance, excess, quotaExposure, paymentBenefit, total };
}

function renderCard(el, rows) {
  el.innerHTML = rows.join("");
}

function render() {
  const product = products[Number(els.product.value)] || products[0];
  const orderTonnes = Number(els.tonnes.value) || product.monthlyUse;
  const financeRate = (Number(els.finance.value) || 0) / 100;
  const domesticTerms = Number(els.domesticTerms.value) || 0;
  const domesticFinance = product.domesticPrice * financeRate * domesticTerms / 365;
  const domesticTotal = product.domesticPrice + domesticFinance;
  const euRows = currentRowsFor(product, "eu");
  const turkeyRows = currentRowsFor(product, "turkey");
  const euAnyRows = routeRowsFor(product, "eu", false);
  const turkeyAnyRows = routeRowsFor(product, "turkey", false);
  const eu = routeCost(product, "eu", euRows[0]);
  const turkey = routeCost(product, "turkey", turkeyRows[0]);

  renderCard(els.domesticCard, [
    rowFor("Headline price", `${money(product.domesticPrice)}/t`),
    rowFor("Payment terms", `${domesticTerms} days`),
    rowFor("Financing charge", `${money(domesticFinance)}/t`),
    rowFor("Quota / CBAM / customs", "None"),
    rowFor("Estimated economic cost", `${money(domesticTotal)}/t`, true),
  ]);

  for (const [el, model] of [[els.euCard, eu], [els.turkeyCard, turkey]]) {
    renderCard(el, [
      rowFor("Headline import price", `${money(product.importPrice)}/t`),
      rowFor("Freight", `${money(product.freight[model.route === routeRules.eu ? "eu" : "turkey"])}/t`),
      rowFor("Terminal/customs", `${money(model.route.terminal)}/t`),
      rowFor("CBAM placeholder", `${money(model.route.cbam)}/t`),
      rowFor("Quota balance", tonnes(model.balance)),
      rowFor("50% exposure", `${money(model.quotaExposure)} total`),
      rowFor("Payment-term benefit", `-${money(model.paymentBenefit)}/t`),
      rowFor("Estimated economic cost", `${money(model.total)}/t`, true),
    ]);
  }

  const matched = [
    ...euRows.map((row) => ["European Union", row]),
    ...turkeyRows.map((row) => ["Turkey", row]),
  ];

  els.quotaRows.innerHTML = matched.length
    ? matched
        .map(([route, row]) => `
          <tr>
            <td>${route}</td>
            <td>${row.quota__order_number || "n/a"}</td>
            <td>${row.quota_definition__status || "n/a"}</td>
            <td>${row.quota_definition__validity_start_date || "n/a"} to ${row.quota_definition__validity_end_date || "n/a"}</td>
            <td>${tonnes(balanceTonnes(row))}</td>
            <td>${pct(row.quota_definition__fill_rate)}</td>
            <td>${row.quota_definition__last_allocation_date === "#NA" ? "n/a" : row.quota_definition__last_allocation_date}</td>
          </tr>
        `)
        .join("")
    : `<tr><td colspan="7">No current EU or Turkey quota rows matched ${product.code} / ${product.code.slice(0, 8)}. ${euAnyRows.length + turkeyAnyRows.length ? "Rows exist for this product code, but not for today's active quota period in this feed version." : "No EU/Turkey rows exist for this product code in the loaded feed."}</td></tr>`;

  els.quotaStatus.textContent = `Showing quota matches for ${product.name} (${product.code}, HMRC ${product.code.slice(0, 8)}) and an order size of ${tonnes(orderTonnes)}.`;
}

async function loadQuotaRows() {
  try {
    const response = await fetch(quotaEndpoint);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    quotaRows = parseCsv(await response.text());
    els.quotaStatus.textContent = `Loaded ${quotaRows.length.toLocaleString("en-GB")} rows from the quota endpoint.`;
  } catch (error) {
    const response = await fetch("/api/steel-quotas");
    const payload = await response.json();
    quotaRows = (payload.rows || []).map((row) => ({
      quota__order_number: row.orderNumber,
      quota__geographical_areas: row.geographicalAreas.join("|"),
      quota__commodities: row.commodityCodes.join("|"),
      quota__measurement_unit: row.measurementUnit,
      quota_definition__validity_start_date: row.startDate,
      quota_definition__validity_end_date: row.endDate,
      quota_definition__status: row.status,
      quota_definition__last_allocation_date: row.lastAllocationDate,
      quota_definition__initial_volume: row.initialVolume,
      quota_definition__balance: row.balance,
      quota_definition__fill_rate: row.fillRate,
    }));
    els.quotaStatus.textContent = `Direct quota endpoint was unavailable in the browser, so local /api/steel-quotas loaded ${quotaRows.length.toLocaleString("en-GB")} rows.`;
  }
  render();
}

function init() {
  products.forEach((product, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = `${product.name} (${product.code})`;
    els.product.appendChild(option);
  });
  els.tonnes.value = products[0].monthlyUse;
  els.product.addEventListener("change", () => {
    const product = products[Number(els.product.value)] || products[0];
    els.tonnes.value = product.monthlyUse;
    render();
  });
  [els.tonnes, els.finance, els.domesticTerms, els.importTerms].forEach((el) => {
    el.addEventListener("input", render);
  });
  loadQuotaRows();
}

init();
