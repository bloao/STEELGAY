(function () {
  "use strict";
  const { api, fmt, el, statusBadge, toast, loadMe } = window.OrderTool;

  const form = document.getElementById("scenario-form");
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(window.location.search);
  let scenarioId = params.get("id");
  let scenario = null;
  let me = { canEdit: true, canApprove: false };
  let dirty = false;
  let triedSave = false;
  let calcTimer = null;
  let calcSeq = 0;
  let lastResult = null;
  let fromProduct = null;

  const categories = (window.STEEL_TRADE_MEASURE && window.STEEL_TRADE_MEASURE.categories) || [];
  const commodityByCode = new Map();
  const commodityByLabel = new Map();

  // ------------------------------------------------------------ options

  function fillSelect(select, values, keepFirst) {
    const first = keepFirst ? select.options[0] : null;
    select.replaceChildren(...(first ? [first] : []), ...values.map((v) => el("option", { value: v, text: v })));
  }

  function populateCommodities(data) {
    const list = (data && data.commodities) || [];
    commodityByCode.clear();
    commodityByLabel.clear();
    const frag = document.createDocumentFragment();
    for (const c of list) {
      const label = `${c.code} - ${c.description}`;
      commodityByCode.set(c.code, c);
      commodityByLabel.set(label, c);
      frag.append(el("option", { value: label, label: `${c.heading}: ${c.headingDescription}` }));
    }
    $("commodity-options").replaceChildren(frag);
    updateCommodityHint();
  }

  function selectedCommodity() {
    const value = form.commodityCode.value.trim();
    if (!value) return null;
    const direct = commodityByLabel.get(value);
    if (direct) return direct;
    let code = (value.replace(/\s+/g, "").match(/^\d{8,10}/) || [""])[0];
    if (code.length === 8) code += "00";
    return commodityByCode.get(code) || (code.length === 10 ? { code, description: "", manual: true } : null);
  }

  function categoryFor(code) {
    return categories.find((c) => c.commodityPrefixes.some((p) => code.startsWith(p))) || null;
  }

  function updateCommodityHint() {
    const hint = $("commodity-hint");
    const c = selectedCommodity();
    if (!c) {
      hint.textContent = commodityByCode.size ? `${commodityByCode.size.toLocaleString("en-GB")} steel commodity codes (chapters 72–73)` : "Enter a 10-digit commodity code";
      hint.classList.remove("is-match");
      return;
    }
    const cat = categoryFor(c.code);
    hint.textContent = cat ? `Steel measure Category ${cat.id} · ${cat.name}` : c.manual ? "Code not in the steel list — ordinary duty only" : "Not in a steel-measure category — ordinary duty only";
    hint.classList.toggle("is-match", Boolean(cat));
  }

  function updateDynamicHints() {
    const date = form.importDate.value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const [y, m] = date.split("-").map(Number);
      const label = m >= 7 && m <= 9 ? `Q1 ${y}/${y + 1}` : m >= 10 ? `Q2 ${y}/${y + 1}` : m <= 3 ? `Q3 ${y - 1}/${y}` : `Q4 ${y - 1}/${y}`;
      $("period-hint").textContent = `Quota period ${label}`;
    } else {
      $("period-hint").textContent = "";
    }
    const nonGbp = form.priceCurrency.value !== "GBP";
    $("fx-field").hidden = !nonGbp;
    $("fx-buffer-field").hidden = !nonGbp;
    const inc = form.incoterm.value;
    const included = {
      EXW: "Buyer pays all freight and insurance",
      FCA: "Buyer pays main freight and insurance",
      FOB: "Buyer pays sea freight and insurance",
      CFR: "Freight to UK in price; buyer insures",
      CIF: "Freight and insurance to UK in price",
      CPT: "Carriage to UK in price; buyer insures",
      CIP: "Carriage and insurance to UK in price",
      DAP: "Delivered to site; buyer clears customs",
      DPU: "Delivered and unloaded; buyer clears customs",
      DDP: "Delivered duty paid — supplier imports",
    }[inc] || "";
    $("incoterm-hint").textContent = included;
    const ddp = inc === "DDP";
    form.importerOfRecord.disabled = ddp;
    if (ddp) form.importerOfRecord.value = "supplier";
    for (const name of ["freightToUkPerT", "insurancePerT", "inlandFreightPerT"]) {
      const inPrice = (name === "freightToUkPerT" && ["CFR", "CIF", "CPT", "CIP", "DAP", "DPU", "DDP"].includes(inc))
        || (name === "insurancePerT" && ["CIF", "CIP", "DAP", "DPU", "DDP"].includes(inc))
        || (name === "inlandFreightPerT" && ["DAP", "DPU", "DDP"].includes(inc));
      form[name].disabled = inPrice;
      form[name].placeholder = inPrice ? `In price (${inc})` : "0";
    }
  }

  // ------------------------------------------------------------ form <-> inputs

  const FIELDS = ["title", "commodityCode", "spec", "origin", "tonnage", "importDate", "supplier", "mill", "incoterm",
    "importerOfRecord", "priceAmount", "priceCurrency", "fxRateOverride", "fxBufferPct", "freightToUkPerT", "insurancePerT",
    "inlandFreightPerT", "brokeragePerShipment", "paymentTerms", "financeRatePct", "financeDays", "leadTimeWeeks",
    "quoteValidUntil", "emissionsPerT", "ukCarbonPrice", "overseasCarbonPrice", "notes"];

  function readInputs() {
    const inputs = {};
    for (const name of FIELDS) inputs[name] = form[name].value;
    const c = selectedCommodity();
    inputs.commodityCode = c ? c.code : form.commodityCode.value.replace(/\s+/g, "");
    inputs.commodityDescription = c && c.description ? c.description : "";
    if (form.importerOfRecord.disabled) inputs.importerOfRecord = "supplier";
    return inputs;
  }

  function writeInputs(inputs) {
    for (const name of FIELDS) {
      if (!(name in inputs)) continue;
      const value = inputs[name];
      form[name].value = value === null || value === undefined ? "" : value;
    }
    const c = commodityByCode.get(inputs.commodityCode);
    form.commodityCode.value = c ? `${c.code} - ${c.description}` : inputs.commodityCode || "";
    updateCommodityHint();
    updateDynamicHints();
  }

  function showErrors(errors = {}) {
    form.querySelectorAll("[data-field]").forEach((field) => {
      const key = field.dataset.field;
      const input = form[key];
      const message = errors[key];
      const show = message && (triedSave || (input && input.value !== ""));
      field.classList.toggle("has-error", Boolean(show));
      const slot = field.querySelector(".error");
      if (slot) slot.textContent = show ? message : "";
    });
    const general = errors._;
    $("form-error").hidden = !general;
    $("form-error").textContent = general || "";
  }

  // ------------------------------------------------------------ result panel

  function renderResult(result) {
    lastResult = result;
    const totals = result.totals;
    $("total-card").classList.remove("is-loading");
    $("total-perT").textContent = `${fmt.money(totals.expectedPerT, true)} /t`;
    const range = totals.lowPerT !== totals.highPerT ? ` · range ${fmt.money(totals.lowPerT)}–${fmt.money(totals.highPerT)}/t` : "";
    let vsProduct = "";
    if (fromProduct && result.inputs.commodityCode === fromProduct.commodityCode) {
      const ref = fromProduct.targetBuyPrice || fromProduct.costPerT;
      const diff = totals.expectedPerT - ref;
      vsProduct = ` · ${diff > 0 ? "+" : "−"}${fmt.money(Math.abs(diff))}/t vs ${fromProduct.targetBuyPrice ? "target" : "stock cost"}`;
    }
    $("total-sub").textContent = `${fmt.money(totals.expectedTotal)} for ${fmt.tonnes(result.inputs.tonnage)}${range}${vsProduct}${result.complete ? "" : " · incomplete"}`;
    $("customs-value").textContent = result.buyerImports ? `Customs value ${fmt.perT(result.customsValuePerT)}` : "";

    $("build-up").replaceChildren(...result.lines.map((line) => {
      const value = line.status === "missing" ? "Needs data"
        : line.status === "in-price" ? "In price"
        : line.status === "supplier" ? "Supplier"
        : fmt.money(line.perTonne, true);
      const cls = line.status === "missing" ? "is-missing" : ["in-price", "supplier", "n/a"].includes(line.status) && !line.perTonne ? "is-muted" : "";
      return el("div", { class: `line ${cls}` },
        el("span", {}, line.label, el("small", { text: line.source }), line.note ? el("small", { text: line.note }) : null),
        el("strong", { text: value }));
    }));
    $("vat-line").textContent = result.buyerImports
      ? `Import VAT ${fmt.money(result.totals.vatTotal)} (${fmt.perT(result.totals.vatPerT)}) is not in the total — recoverable via postponed VAT accounting.`
      : "";

    const q = result.quota;
    $("quota-card").hidden = !q;
    if (q) {
      $("quota-order").textContent = q.matched ? `Order ${q.orderNumber} · ${result.quotaPeriod.label}` : result.quotaPeriod.label;
      const share = q.matched && q.initialT ? Math.max(0, Math.min(1, (q.balanceT ?? 0) / q.initialT)) : 0;
      const bar = $("quota-bar");
      bar.firstElementChild.style.width = `${Math.round(share * 100)}%`;
      bar.classList.toggle("is-warn", q.probability > 0 && q.probability < 0.5);
      bar.classList.toggle("is-bad", q.probability >= 0.5);
      $("quota-left").textContent = q.matched ? `${fmt.tonnesRound(q.balanceT)} left of ${fmt.tonnesRound(q.initialT)} now · ~${fmt.tonnesRound(q.projectedBalanceT)} at import` : "No matching quota line";
      $("quota-areas").textContent = q.matched ? (q.geographicalAreas || []).join(", ") : "";
      $("quota-basis").textContent = q.basis;
      const warn = $("quota-warn");
      warn.hidden = q.probability < 0.5;
      warn.textContent = `${fmt.pct(q.probability)} chance this line runs out before your import date. Out-of-quota tonnes pay the 50% steel-measure rate — about ${fmt.tonnesRound(q.expectedExcessT)} expected to be exposed.`;
    }

    const notes = [...result.warnings, ...result.checks];
    $("checks-card").hidden = notes.length === 0;
    $("checks").replaceChildren(...notes.map((n) => el("li", { text: n })));

    const s = result.sources || {};
    $("sample-note").hidden = !s.sample;
    $("sample-note").textContent = s.sample ? s.note : "";
    const parts = [`Calculated ${fmt.dateTime(s.calculatedAt)} · engine v${result.engineVersion}`];
    if (s.sample) parts.push("sample market data");
    if (s.quotasFetchedAt) parts.push(`quotas ${fmt.time(s.quotasFetchedAt)}`);
    if (s.tariffFetchedAt) parts.push(`tariff ${fmt.time(s.tariffFetchedAt)}`);
    if (s.fx) parts.push(`FX ${s.fx.rate} (${s.fx.date})`);
    if (s.sample && result.fx && result.fx.currency !== "GBP") parts.push(`sample FX ${result.fx.rate}`);
    $("snapshot").textContent = parts.join(" · ");

    if (result.fx && result.fx.currency !== "GBP" && !form.fxRateOverride.value) {
      $("fx-hint").textContent = `Live: ${result.fx.rate} (${result.fx.source})`;
    }
  }

  function scheduleCalc() {
    clearTimeout(calcTimer);
    calcTimer = setTimeout(runCalc, 600);
  }

  async function runCalc() {
    const seq = ++calcSeq;
    const inputs = readInputs();
    if (!inputs.commodityCode || !inputs.origin || !inputs.tonnage || !inputs.priceAmount || !inputs.importDate) {
      showErrors({});
      return;
    }
    $("total-card").classList.add("is-loading");
    try {
      const result = await api("/api/calculate", { method: "POST", body: { inputs } });
      if (seq !== calcSeq) return;
      showErrors({});
      renderResult(result);
    } catch (error) {
      if (seq !== calcSeq) return;
      $("total-card").classList.remove("is-loading");
      showErrors((error.data && error.data.errors) || { _: error.message });
    }
  }

  // ------------------------------------------------------------ scenario state

  function setDirty(value) {
    dirty = value;
    $("save-state").textContent = !scenarioId ? "Not saved" : dirty ? "Unsaved changes" : `Saved ${fmt.dateTime(scenario.updatedAt)}`;
    $("btn-save").textContent = scenarioId ? "Save changes" : "Save scenario";
    $("btn-save").disabled = !me.canEdit || (scenarioId && !dirty);
  }

  function renderScenario() {
    const saved = Boolean(scenario);
    $("page-title").textContent = saved ? (scenario.inputs.title || scenario.inputs.commodityDescription || scenario.inputs.commodityCode) : "New order scenario";
    document.title = `${$("page-title").textContent} · Datafab AGX`;
    $("status-badge").replaceChildren(saved ? statusBadge(scenario.status, scenario.inputs.quoteValidUntil) : "");
    for (const id of ["btn-recalc", "btn-duplicate", "btn-print"]) $(id).hidden = !saved;
    $("btn-recalc").hidden = !saved || !me.canEdit;
    $("btn-duplicate").hidden = !saved || !me.canEdit;

    const plan = saved && scenario.plan;
    $("plan-card").hidden = !plan;
    if (plan) {
      const timing = { "buy-ahead": "Planner advised buying ahead of need.", wait: "Planner advised holding off if stock allows.", "order-now": "Planner advised ordering now." }[plan.timing] || "";
      $("plan-timing").textContent = `${scenario.starter ? "Drafted automatically from your stock levels and supplier quotes. " : ""}${timing}`;
      $("plan-reasons").replaceChildren(...(plan.reasons || []).map((r) => el("li", { text: r })));
      $("plan-again").href = `plan.html?product=${encodeURIComponent(plan.productId || "")}`;
    }
    $("activity-card").hidden = !saved;
    if (saved) {
      $("activity").replaceChildren(...[...scenario.activity].reverse().map((a) =>
        el("li", {}, el("strong", { text: a.by }), ` ${a.action}`, a.detail ? ` — ${a.detail}` : "", el("br"), el("time", { datetime: a.at, text: fmt.dateTime(a.at) }))));
    }

    const actions = [];
    if (saved) {
      const st = scenario.status;
      if (["draft", "rejected"].includes(st) && me.canEdit) actions.push(["submit", "Submit for approval", "btn-primary"]);
      if (st === "submitted" && me.canApprove) actions.push(["approve", "Approve", "btn-good"], ["reject", "Reject", "btn-danger"]);
      if (["submitted", "approved", "rejected"].includes(st) && me.canEdit) actions.push(["reopen", "Reopen as draft", ""]);
      if (me.canEdit) actions.push(["archive", "Archive", ""]);
    }
    $("approval-card").hidden = actions.length === 0;
    $("status-actions").replaceChildren(...actions.map(([action, label, cls]) =>
      el("button", { type: "button", class: `btn ${cls}`, text: label, onclick: () => changeStatus(action) })));
    setDirty(dirty);
  }

  async function save() {
    triedSave = true;
    const inputs = readInputs();
    $("btn-save").disabled = true;
    try {
      if (scenarioId) {
        scenario = await api(`/api/scenarios/${scenarioId}`, { method: "PUT", body: { inputs } });
        toast("Changes saved");
      } else {
        scenario = await api("/api/scenarios", { method: "POST", body: { inputs } });
        scenarioId = scenario.id;
        history.replaceState(null, "", `order.html?id=${scenarioId}`);
        toast("Scenario saved");
      }
      showErrors({});
      renderResult(scenario.result);
      dirty = false;
      renderScenario();
    } catch (error) {
      showErrors((error.data && error.data.errors) || { _: error.message });
      toast("Could not save — check the highlighted fields", true);
      setDirty(dirty);
    }
  }

  async function changeStatus(action) {
    if (dirty) {
      toast("Save your changes first", true);
      return;
    }
    try {
      scenario = await api(`/api/scenarios/${scenarioId}/status`, { method: "POST", body: { action, note: $("status-note").value } });
      $("status-note").value = "";
      if (action === "archive") {
        window.location.href = "orders.html";
        return;
      }
      renderScenario();
      toast(`Scenario ${scenario.status === "draft" ? "reopened" : scenario.status}`);
    } catch (error) {
      toast(error.message, true);
    }
  }

  async function load() {
    me = await loadMe();
    const options = await api("/api/options").catch(() => null);
    if (options) {
      fillSelect(form.origin, options.origins, true);
      fillSelect(form.incoterm, options.incoterms);
      fillSelect(form.priceCurrency, options.currencies);
    }
    populateCommodities(window.STEEL_COMMODITIES);
    api("/api/steel-commodities").then((data) => {
      populateCommodities(data);
      if (scenario) writeInputs(scenario.inputs);
    }).catch(() => {});

    if (scenarioId) {
      try {
        scenario = await api(`/api/scenarios/${scenarioId}`);
        writeInputs(scenario.inputs);
        if (scenario.result) renderResult(scenario.result);
      } catch (error) {
        toast(`Could not load scenario: ${error.message}`, true);
        scenarioId = null;
      }
    } else {
      const date = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
      const defaults = { importDate: date, incoterm: "CFR", priceCurrency: "GBP", importerOfRecord: "us" };
      const productId = params.get("product");
      if (productId) {
        try {
          fromProduct = await api(`/api/products/${productId}`);
          Object.assign(defaults, {
            title: `${fromProduct.name} — restock`,
            commodityCode: fromProduct.commodityCode,
            spec: fromProduct.name,
            tonnage: fromProduct.metrics.suggestedOrderT || "",
          });
          const m = fromProduct.metrics;
          const note = $("product-note");
          note.hidden = false;
          note.textContent = `From product ${fromProduct.name}: ${fmt.tonnes(fromProduct.stockT)} in stock, using ${fmt.tonnes(fromProduct.monthlyUsageT)} a month — runs out ${fmt.date(m.stockOutDate)}. Stock cost ${fmt.perT(fromProduct.costPerT)}${fromProduct.targetBuyPrice ? `, target buy price ${fmt.perT(fromProduct.targetBuyPrice)}` : ""}.${m.suggestedOrderT ? ` Suggested order ${m.suggestedOrderT} t.` : ""}`;
        } catch (error) {
          toast(`Could not load product: ${error.message}`, true);
        }
      }
      writeInputs(defaults);
      if (fromProduct) { setDirty(true); scheduleCalc(); }
    }
    if (!me.canEdit) form.querySelectorAll("input, select, textarea").forEach((n) => { n.disabled = true; });
    renderScenario();
  }

  form.addEventListener("input", (event) => {
    if (event.target.name === "commodityCode") updateCommodityHint();
    updateDynamicHints();
    setDirty(true);
    scheduleCalc();
  });
  form.addEventListener("change", () => { updateDynamicHints(); });
  form.addEventListener("submit", (event) => { event.preventDefault(); save(); });
  $("btn-save").addEventListener("click", save);
  $("btn-print").addEventListener("click", () => window.print());
  $("btn-duplicate").addEventListener("click", async () => {
    try {
      const copy = await api(`/api/scenarios/${scenarioId}/duplicate`, { method: "POST" });
      window.location.href = `order.html?id=${copy.id}`;
    } catch (error) { toast(error.message, true); }
  });
  $("btn-recalc").addEventListener("click", async () => {
    if (dirty) { toast("Save your changes first", true); return; }
    try {
      scenario = await api(`/api/scenarios/${scenarioId}/recalculate`, { method: "POST" });
      renderResult(scenario.result);
      renderScenario();
      toast("Recalculated with latest data");
    } catch (error) { toast(error.message, true); }
  });
  window.addEventListener("beforeunload", (event) => {
    if (dirty && me.canEdit) { event.preventDefault(); event.returnValue = ""; }
  });

  load();
})();
