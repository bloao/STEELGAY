// Suppliers page uses the workbook-derived directory. Products still rolls up saved scenarios.
(function () {
  "use strict";
  const { api, fmt, el, toast } = window.OrderTool;
  const section = document.currentScript.dataset.section;
  const rowsEl = document.getElementById("rows");
  const emptyEl = document.getElementById("empty");
  const countEl = document.getElementById("count");

  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const minBy = (xs, f) => xs.reduce((best, x) => (f(x) < f(best) ? x : best), xs[0]);
  const dash = (value) => value || "—";

  const supplierDirectory = [
    {
      name: "Tata Steel UK",
      category: "",
      origin: "UK",
      price: 728,
      priceBasis: "Current price £/t",
      pricingSource: "Competition (UK and Imports) MEPS/Kallanish",
      coverage: "Everything covered",
      moq: "23t load",
      ddp: "n.a.",
      onTime: "70% (confirm)",
      paymentTerms: "30 d",
      currency: "GBP",
      leadTime: "",
      transportCosts: "",
      dutyCosts: "",
      otherDuty: "",
      dutyRisk: "",
    },
    {
      name: "7 Steel",
      category: "Merchant bar",
      origin: "UK",
      price: 755,
      priceBasis: "£/t delivered to depot",
      pricingSource: "Competition (UK and Imports) MEPS/Kallanish, Market Intel",
      coverage: "Everything covered",
      moq: "25-28t load",
      ddp: "n.a.",
      onTime: "80%",
      paymentTerms: "60 days",
      paymentNote: "Maybe going to 30 days",
      currency: "GBP",
      leadTime: "2-3 days",
      transportCosts: "Included",
      dutyCosts: "n.a.",
      otherDuty: "n.a.",
      dutyRisk: "Zero",
    },
    {
      name: "LME",
      category: "Merchant bar",
      origin: "France",
      price: 755,
      priceBasis: "£/t DAP",
      pricingSource: "Competition (UK and Imports) MEPS/Kallanish, Market Intel",
      coverage: "All except duty",
      moq: "25-28t load",
      ddp: "No",
      onTime: "80%",
      paymentTerms: "60 days",
      currency: "GBP",
      leadTime: "2-3 weeks",
      transportCosts: "Included",
      dutyCosts: "Up to 50%",
      otherDuty: "0",
      dutyRisk: "Medium to high depending on quarter position, load by load",
    },
    {
      name: "Megasa",
      category: "Merchant bar",
      origin: "Spain",
      price: 755,
      priceBasis: "£/t DDP",
      pricingSource: "Competition (UK and Imports) MEPS/Kallanish, Market Intel",
      coverage: "Everything covered",
      moq: "25-28t load",
      ddp: "Yes",
      onTime: "80%",
      paymentTerms: "60 days",
      currency: "GBP",
      leadTime: "2-3 weeks",
      transportCosts: "Included",
      dutyCosts: "n.a.",
      otherDuty: "n.a.",
      dutyRisk: "Low, but risk of non-delivery if quota is critical or exceeded",
    },
    {
      name: "Olifer",
      category: "Merchant bar",
      origin: "Italy",
      price: 800,
      priceBasis: "£/t DAP",
      pricingSource: "Competition (UK and Imports) MEPS/Kallanish, Market Intel",
      coverage: "All except duty",
      moq: "25-28t load",
      ddp: "No",
      onTime: "70%",
      paymentTerms: "60 days",
      currency: "GBP",
      leadTime: "2-3 weeks",
      transportCosts: "Included",
      dutyCosts: "Up to 50%",
      otherDuty: "0",
      dutyRisk: "Medium to high depending on quarter position, load by load",
    },
    {
      name: "Venete",
      category: "Merchant bar",
      origin: "",
      price: 770,
      priceBasis: "£/t DAP",
      pricingSource: "",
      coverage: "",
      moq: "25-28t load",
      ddp: "",
      onTime: "",
      paymentTerms: "",
      currency: "GBP",
      leadTime: "5-6 weeks",
      transportCosts: "Included",
      dutyCosts: "Up to 50%",
      otherDuty: "0",
      dutyRisk: "Shipment via vessel, usually planned for start of quarter. Medium risk",
    },
  ];

  function groupBy(rows, key) {
    const map = new Map();
    for (const r of rows) {
      const k = key(r);
      if (!k) continue;
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(r);
    }
    return [...map.entries()];
  }

  function bestCell(group) {
    const priced = group.filter((s) => Number.isFinite(s.expectedPerT));
    if (!priced.length) return el("td", { class: "num", text: "—" });
    const best = minBy(priced, (s) => s.expectedPerT);
    return el("td", { class: "num" },
      el("a", { href: `order-tool.html?id=${best.id}`, style: "font-weight:600", text: fmt.perT(best.expectedPerT) }),
      el("div", { class: "row-sub", text: best.title }));
  }

  function renderSuppliers() {
    countEl.textContent = `${supplierDirectory.length} suppliers`;
    rowsEl.replaceChildren(...supplierDirectory.map((supplier) => el("tr", {},
      el("td", {}, el("strong", { text: supplier.name })),
      el("td", { text: dash(supplier.category) }),
      el("td", { text: dash(supplier.origin) }),
      el("td", { text: dash(supplier.pricingSource) }),
      el("td", { class: "num", text: fmt.perT(supplier.price) }),
      el("td", { text: supplier.currency }),
      el("td", { text: supplier.priceBasis }),
      el("td", { text: dash(supplier.coverage) }),
      el("td", { text: dash(supplier.transportCosts) }),
      el("td", { text: dash(supplier.dutyCosts) }),
      el("td", { text: dash(supplier.otherDuty) }),
      el("td", { text: supplier.moq }),
      el("td", { text: dash(supplier.onTime) }),
      el("td", { text: dash(supplier.ddp) }),
      el("td", { text: dash(supplier.leadTime) }),
      el("td", {},
        el("span", { text: dash(supplier.paymentTerms) }),
        supplier.paymentNote ? el("div", { class: "row-sub", text: supplier.paymentNote }) : ""),
      el("td", { text: dash(supplier.dutyRisk) }))));
    return supplierDirectory.length;
  }

  function renderProducts(all) {
    const groups = groupBy(all, (s) => s.commodityCode).sort((a, b) => a[0].localeCompare(b[0]));
    countEl.textContent = `${groups.length} product${groups.length === 1 ? "" : "s"}`;
    rowsEl.replaceChildren(...groups.map(([code, g]) => {
      const name = uniq(g.map((s) => s.commodityDescription))[0] || g[0].title;
      const cat = g.find((s) => s.categoryId)?.categoryId;
      return el("tr", {},
        el("td", {}, el("strong", { text: name })),
        el("td", { text: code.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4") }),
        el("td", {}, cat ? el("span", { class: "badge badge-info", text: `Category ${cat}` }) : el("span", { class: "badge", text: "Not covered" })),
        el("td", { class: "num", text: g.length }),
        el("td", { class: "num", text: fmt.tonnesRound(g.reduce((t, s) => t + (s.tonnage || 0), 0)) }),
        bestCell(g),
        el("td", { text: uniq(g.map((s) => s.origin)).join(", ") }));
    }));
    return groups.length;
  }

  if (section === "suppliers") {
    emptyEl.hidden = renderSuppliers() > 0;
  } else {
    api("/api/scenarios").then(({ scenarios }) => {
      emptyEl.hidden = renderProducts(scenarios) > 0;
    }).catch((error) => toast(`Could not load scenarios: ${error.message}`, true));
  }
})();
