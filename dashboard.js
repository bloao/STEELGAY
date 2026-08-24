const numberFormat = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const moneyFormat = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  maximumFractionDigits: 0,
});
const percentFormat = new Intl.NumberFormat("en-GB", {
  style: "percent",
  maximumFractionDigits: 1,
});

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) {
    node.textContent = value;
  }
}

function formatPeriod(period) {
  if (!period || String(period).length !== 6) {
    return "Unavailable";
  }
  return `${period.slice(0, 4)}-${period.slice(4, 6)}`;
}

function renderCountries(rows) {
  const body = document.getElementById("top-countries-body");
  if (!body) {
    return;
  }
  body.innerHTML = "";
  rows.forEach((row) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${row.origin_country}</td>
      <td>${numberFormat.format(row.total_tonnes)}</td>
      <td>${moneyFormat.format(row.total_value)}</td>
      <td>${percentFormat.format(row.share_of_uk_steel_import_tonnes)}</td>
      <td>${row.main_product_group}</td>
    `;
    body.appendChild(tr);
  });
}

function renderStatus(rows) {
  const list = document.getElementById("company-status-list");
  if (!list) {
    return;
  }
  list.innerHTML = "";
  rows.forEach((row) => {
    const item = document.createElement("div");
    item.className = "status-item";
    item.innerHTML = `<strong>${row.company_status}</strong><span>${numberFormat.format(row.companies)} companies</span>`;
    list.appendChild(item);
  });
}

function renderRoutes(rows) {
  const list = document.getElementById("route-list");
  if (!list) {
    return;
  }
  list.innerHTML = "";
  rows.forEach((row) => {
    const item = document.createElement("article");
    item.className = "route-item";
    item.innerHTML = `
      <strong>${row.route}</strong>
      <span>${row.commodity_code} · ${row.steel_product_group}</span>
      <span>${numberFormat.format(row.tonnes)} tonnes · ${moneyFormat.format(row.value)}</span>
    `;
    list.appendChild(item);
  });
}

async function loadSummary() {
  try {
    const response = await fetch("output/website/analysis-summary.json", { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Summary file unavailable");
    }
    const summary = await response.json();

    setText("coverage-first", formatPeriod(summary.coverage.firstPeriod));
    setText("coverage-last", formatPeriod(summary.coverage.lastPeriod));
    setText("coverage-months", `${summary.coverage.monthsCovered} months`);

    setText("kpi-tonnes", numberFormat.format(summary.kpis.totalTonnes));
    setText("kpi-value", moneyFormat.format(summary.kpis.totalValueGbp));
    setText("kpi-countries", numberFormat.format(summary.kpis.originCountries));
    setText("kpi-importers", numberFormat.format(summary.kpis.activeImporters));
    setText("kpi-transport", percentFormat.format(summary.kpis.reliableTransportShare));

    renderCountries(summary.topCountries || []);
    renderStatus(summary.companyStatusMix || []);
    renderRoutes(summary.topRoutes || []);
  } catch (error) {
    const fallback = document.createElement("p");
    fallback.className = "empty-state";
    fallback.textContent = "Analysis summary file not found yet. Run `python main.py` to generate the website data bundle.";
    document.querySelector(".page-shell")?.appendChild(fallback);
  }
}

loadSummary();
