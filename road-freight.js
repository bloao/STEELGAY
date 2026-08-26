const roadNumber = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });
const roadCompact = new Intl.NumberFormat("en-GB", { notation: "compact", maximumFractionDigits: 1 });
const roadMoney = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", notation: "compact", maximumFractionDigits: 1 });
const roadPercent = new Intl.NumberFormat("en-GB", { style: "percent", maximumFractionDigits: 1 });

let roadData;
let rankingMetric = "road_freight_tonnes";

function roadSet(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function periodLabel(period) {
  const text = String(period);
  return `${text.slice(0, 4)}-${text.slice(4)}`;
}

function renderMonthly(rows) {
  const grouped = new Map();
  rows.forEach((row) => grouped.set(row.period, (grouped.get(row.period) || 0) + row.tonnes));
  const values = [...grouped.entries()].sort(([a], [b]) => a - b);
  const max = Math.max(...values.map(([, value]) => value), 1);
  const chart = document.getElementById("monthly-chart");
  chart.innerHTML = values.map(([period, value]) => `<div class="trend-column" title="${periodLabel(period)}: ${roadNumber.format(value)} tonnes"><span style="height:${Math.max((value / max) * 100, 2)}%"></span></div>`).join("");
  roadSet("trend-first", periodLabel(values[0][0]));
  roadSet("trend-last", periodLabel(values.at(-1)[0]));
}

function renderProducts(rows) {
  const max = rows[0]?.tonnes || 1;
  document.getElementById("product-bars").innerHTML = rows.slice(0, 7).map((row, index) => `
    <div class="bar-row">
      <div><span>${String(index + 1).padStart(2, "0")}</span><strong>${row.steel_product_group}</strong><em>${roadCompact.format(row.tonnes)} t</em></div>
      <i><b style="width:${(row.tonnes / max) * 100}%"></b></i>
    </div>`).join("");
}

function renderCountries() {
  const countries = [...roadData.countries].sort((a, b) => b[rankingMetric] - a[rankingMetric]).slice(0, 12);
  const max = countries[0]?.[rankingMetric] || 1;
  const metricFields = {
    road_freight_tonnes: {
      value: "road_freight_value_gbp", share: "road_freight_share_of_country_steel",
      months: "active_months", products: "steel_products", origin: "main_origin_country",
    },
    direct_road_tonnes: {
      value: "direct_road_value_gbp", share: "direct_road_share_of_country_steel",
      months: "direct_road_active_months", products: "direct_road_steel_products", origin: "direct_road_main_origin_country",
    },
    roro_tonnes: {
      value: "roro_value_gbp", share: "roro_share_of_country_steel",
      months: "roro_active_months", products: "roro_steel_products", origin: "roro_main_origin_country",
    },
  };
  const fields = metricFields[rankingMetric];
  document.getElementById("country-ranking").innerHTML = countries.map((country, index) => `
    <article class="country-row">
      <span class="country-rank">${String(index + 1).padStart(2, "0")}</span>
      <div class="country-name"><strong>${country.dispatch_country}</strong><small>Main origin: ${country[fields.origin] || "Not supplied"} · ${country[fields.months]} of ${roadData.coverage.monthsCovered} months active</small></div>
      <div class="country-meter"><i><b style="width:${(country[rankingMetric] / max) * 100}%"></b></i><small>${country[fields.products]} ${country[fields.products] === 1 ? "product" : "products"} · ${roadPercent.format(country[fields.share])} of dispatched steel</small></div>
      <strong class="country-tonnes">${roadNumber.format(country[rankingMetric])}<small>tonnes</small></strong>
      <span class="country-value">${roadMoney.format(country[fields.value])}</span>
    </article>`).join("");
}

function renderFlowFilters() {
  const select = document.getElementById("flow-country");
  roadData.countries.forEach((row) => {
    const option = document.createElement("option");
    option.value = row.dispatch_country;
    option.textContent = row.dispatch_country;
    select.appendChild(option);
  });
}

function renderFlows() {
  const mode = document.getElementById("flow-mode").value;
  const country = document.getElementById("flow-country").value;
  const rows = roadData.topFlows.filter((row) => (mode === "all" || row.road_freight_class === mode) && (country === "all" || row.dispatch_country_name === country)).slice(0, 40);
  const body = document.getElementById("flow-table");
  body.innerHTML = rows.map((row) => `
    <tr><td>${periodLabel(row.period)}</td><td><strong>${row.dispatch_country_name}</strong></td><td>${row.origin_country_name}</td><td>${row.steel_product_group}<small>${row.commodity_code}</small></td><td><span class="mode-pill ${row.road_freight_class === "Ro-Ro" ? "roro" : "road"}">${row.road_freight_class === "Ro-Ro" ? "Ro-Ro" : "HMRC road · unverified"}</span></td><td>${row.port_code || "Not supplied"}</td><td>${roadNumber.format(row.tonnes)}</td><td>${roadMoney.format(row.statistical_value_gbp)}</td></tr>`).join("");
  if (!rows.length) body.innerHTML = `<tr><td colspan="8" class="no-results">No top flows match these filters. The complete dataset is available in the CSV download.</td></tr>`;
}

async function loadRoadFreight() {
  try {
    const response = await fetch("output/website/road-freight-summary.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Road freight summary unavailable");
    roadData = await response.json();
    roadSet("road-total-tonnes", roadCompact.format(roadData.kpis.roadFreightTonnes));
    roadSet("road-total-share", `${roadPercent.format(roadData.kpis.shareOfAllSteelTonnes)} of all steel tonnes`);
    roadSet("road-total-value", roadMoney.format(roadData.kpis.roadFreightValueGbp));
    roadSet("road-direct-tonnes", roadNumber.format(roadData.kpis.directRoadTonnes));
    roadSet("road-roro-tonnes", roadCompact.format(roadData.kpis.roroTonnes));
    roadSet("road-country-count", roadNumber.format(roadData.kpis.dispatchCountries));
    roadSet("road-coverage", `${periodLabel(roadData.coverage.firstPeriod)} to ${periodLabel(roadData.coverage.lastPeriod)}`);
    renderMonthly(roadData.monthly);
    renderProducts(roadData.products);
    renderCountries();
    renderFlowFilters();
    renderFlows();
  } catch (error) {
    document.querySelector("main").innerHTML = `<p class="road-error">Road freight data has not been generated yet. Run <code>python main.py</code> and refresh this page.</p>`;
  }
}

document.querySelectorAll("[data-metric]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-metric]").forEach((item) => item.classList.remove("active"));
  button.classList.add("active");
  rankingMetric = button.dataset.metric;
  renderCountries();
}));
document.getElementById("flow-mode").addEventListener("change", renderFlows);
document.getElementById("flow-country").addEventListener("change", renderFlows);
loadRoadFreight();
