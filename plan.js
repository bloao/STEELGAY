(function () {
  "use strict";
  const { api, fmt, el, toast, loadMe } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let me = { canEdit: true };
  let products = [];
  let plan = null;
  let chosen = null; // supplier id picked for saving (defaults to the recommendation)
  let appetite = "balanced";
  let timer = null;
  let seq = 0;
  let overrides = {}; // what-if assumption changes for this plan only
  let asmBuilt = false;

  const readCbam = () => { try { return localStorage.getItem("agx-cbam") === "on"; } catch { return false; } };
  const gbpT = (v) => (Number.isFinite(v) ? `£${Math.round(v).toLocaleString("en-GB")}/t` : "—");
  const gbp = (v) => (Number.isFinite(v) ? `£${Math.round(v).toLocaleString("en-GB")}` : "—");
  const pct = (v) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(1)}%` : "—");
  const per = (p) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(4, 6)) - 1, 1)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  const TIMING = { "order-now": "is-go", "buy-ahead": "is-watch", wait: "is-maybe" };
  const RISK = { critical: ["Close to running out", "is-risk"], high: ["Filling fast", "is-maybe"], medium: ["Watch", "is-maybe"], low: ["Plenty left", "is-go"] };

  // ---------------------------------------------------------------- form
  const NEEDS = ["critical", "reorder", "low"];
  const STATUS = { critical: ["Order now", "is-risk"], reorder: ["Order now", "is-risk"], low: ["Order soon", "is-maybe"], ok: ["Stock OK", "is-go"], "no-usage": ["No usage set", ""] };
  const APPROACHES = [["cautious", "Cautious", "quotaWeightCautiousPct"], ["balanced", "Balanced", "quotaWeightBalancedPct"], ["bold", "Price first", "quotaWeightBoldPct"]];
  const weightOf = (k) => { const a = plan && plan.assumptions; const key = (APPROACHES.find((x) => x[0] === k) || APPROACHES[1])[2]; return a ? a.values[key] : { cautious: 60, balanced: 25, bold: 0 }[k]; };

  function fillProducts() {
    const keep = $("pf-product").value;
    const need = products.filter((p) => NEEDS.includes(p.status));
    const rest = products.filter((p) => !NEEDS.includes(p.status));
    const opt = (p) => el("option", { value: p.id, text: p.name });
    $("pf-product").replaceChildren(
      ...(need.length ? [el("optgroup", { label: "Needs ordering" }, ...need.map(opt))] : []),
      ...(rest.length ? [el("optgroup", { label: need.length ? "Other products" : "Products" }, ...rest.map(opt))] : []));
    if (keep) $("pf-product").value = keep;
  }
  function fillForm() {
    $("pf-appetite").replaceChildren(...APPROACHES.map(([k, l]) => el("button", { type: "button", role: "radio", "aria-checked": String(appetite === k), "aria-pressed": String(appetite === k), tabindex: appetite === k ? "0" : "-1", text: l,
      onclick: () => { appetite = k; fillForm(); run(); },
      onkeydown: (e) => { if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return; e.preventDefault(); const i = APPROACHES.findIndex((x) => x[0] === appetite); appetite = APPROACHES[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3][0]; fillForm(); $("pf-appetite").querySelector('[aria-checked="true"]').focus(); run(); } })));
    const w = weightOf(appetite);
    $("pf-appetite-hint").textContent = w ? `Counts ${w}% of the quota-miss cost` : "Expected cost only, ignores quota risk";
    const on = readCbam(), sw = $("pf-cbam");
    sw.classList.toggle("is-on", on); sw.setAttribute("aria-checked", String(on));
    sw.querySelector(".pf-switch-text").textContent = on ? "Included" : "Not included";
    $("pf-cbam-hint").textContent = on ? "Priced as if already in force" : "Charges imports from 1 Jan 2027";
  }
  function fillHints(r) {
    const p = products.find((x) => x.id === r.product.id) || r.product;
    const [label, cls] = STATUS[r.product.status] || [r.product.status, ""];
    $("pf-product-hint").replaceChildren(el("span", { class: `pf-dot ${cls}`, "aria-hidden": "true" }), `${label}${r.product.coverMonths !== null ? ` · ${r.product.coverMonths.toFixed(1)} months of cover` : ""}`);
    const sug = r.product.suggestedOrderT;
    $("pf-tonnes-hint").replaceChildren(sug && Number(sug) !== Number(r.inputs.tonnage)
      ? el("button", { type: "button", class: "pf-hint-btn", text: `Use suggested ${sug} t`, onclick: () => { $("pf-tonnes").value = sug; run(); } })
      : sug ? "Suggested quantity" : `Uses ${p.monthlyUsageT ?? r.product.monthlyUsageT} t a month`);
    $("pf-needby-hint").textContent = r.product.stockOutDate ? `Runs out ${fmt.date(r.product.stockOutDate)}` : "No run-out date";
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 350); }

  async function run({ keepInputs = true } = {}) {
    const id = $("pf-product").value;
    if (!id) return;
    const mine = ++seq;
    $("plan").classList.add("is-loading");
    const body = { productId: id, appetite, cbam: readCbam(), assume: overrides };
    if (keepInputs && $("pf-tonnes").value) body.tonnage = Number($("pf-tonnes").value);
    if (keepInputs && $("pf-needby").value) body.needBy = $("pf-needby").value;
    try {
      const r = await api("/api/orders/plan", { method: "POST", body });
      if (mine !== seq) return;
      plan = r;
      if (!r.ok) { $("plan").replaceChildren(el("p", { class: "muted", text: r.error })); return; }
      // keep a supplier you picked, unless it can no longer price this order
      if (!keepInputs || !chosen || !r.options.some((o) => o.id === chosen)) chosen = r.recommendation.ok ? r.recommendation.best.id : null;
      if (document.activeElement !== $("pf-tonnes")) $("pf-tonnes").value = r.inputs.tonnage;
      $("pf-needby").value = r.inputs.needBy;
      fillHints(r);
      fillForm();
      history.replaceState(null, "", `plan.html?product=${id}`);
      renderAssumptions(r);
      render();
    } catch (error) {
      $("plan").replaceChildren(el("p", { class: "muted", text: `Couldn't plan this order: ${error.message}` }));
    } finally { $("plan").classList.remove("is-loading"); }
  }

  // ---------------------------------------------------------------- assumptions & thresholds
  // [key, label, help, prefix, suffix, step, context(plan) → text]
  const ASM = {
    thresholds: [
      ["Buying ahead", "Buy more than you need now only when all three hold.", [
        ["buyAheadTriggerPct", "Prices forecast to rise by at least", "Over the next 3 months", "", "%", 0.1, (r) => (r.forecast && Number.isFinite(r.forecast.in3) ? `Forecast now ${pct(r.forecast.in3)}` : "No forecast yet")],
        ["buyAheadMinSaving", "Net saving of at least", "After storage and cost of capital", "£", "", 50, (r) => { const best = (r.aheadOptions || []).slice().sort((a, b) => b.netMid - a.netMid)[0]; return best ? `Best now ${best.netMid >= 0 ? "" : "−"}${gbp(Math.abs(best.netMid))} (+${best.months} mo)` : ""; }],
        ["holdMinScore", "Stockpiling score of at least", "Demand, versatility and price swings", "", "/100", 1, (r) => (r.stockpile ? `${r.product.name}: ${r.stockpile.score}/100` : "")],
      ]],
      ["Holding off", "Suggest waiting only when both hold.", [
        ["waitTriggerPct", "Prices forecast to fall by at least", "Over the next 3 months", "", "%", 0.1, (r) => (r.forecast && Number.isFinite(r.forecast.in3) ? `Forecast now ${pct(r.forecast.in3)}` : "")],
        ["waitCoverBufferMonths", "Stock covers the lead time plus", "Safety margin on top of the supplier's lead time", "", "months", 0.25, (r) => (r.product.coverMonths !== null ? `Cover now ${r.product.coverMonths.toFixed(1)} months` : "")],
      ]],
      ["Warnings", "When a supplier or the market gets flagged.", [
        ["staleQuoteDays", "Quote older than", "Ask for a fresh price", "", "days", 1, null],
        ["onTimeWarnPct", "Supplier on time less than", "From their delivery record", "", "%", 1, null],
        ["quotaWarnProbPct", "Chance the quota runs out above", "Before your load arrives", "", "%", 1, null],
        ["importSurgePct", "UK imports above normal by", "Latest month vs 12-month average", "", "%", 1, (r) => (r.competition && r.competition.vsAvgPct !== null ? `Latest ${pct(r.competition.vsAvgPct)}` : "")],
      ]],
    ],
    costs: [
      ["Money and holding", "Goes into every supplier's landed cost.", [
        ["costOfCapitalPct", "Cost of capital", "Values payment terms, MOQ overbuy, safety stock and buying ahead", "", "% a year", 0.25, null],
        ["forecastStoragePerTMonth", "Storage", "Holding extra stock", "£", "/t a month", 0.5, null],
        ["deliveryPerT", "Delivery to you", "Suppliers who charge delivery on top", "£", "/t", 1, null],
        ["stockOutPerDayPct", "Cost of running out", "Each day a load lands after you run out, % of its value", "", "% a day", 0.05, null],
      ]],
      ["Quota-miss weighting", "Share of the extra duty, if the quota runs out first, each approach counts.", [
        ["quotaWeightCautiousPct", "Cautious", "", "", "%", 5, null],
        ["quotaWeightBalancedPct", "Balanced", "", "", "%", 5, null],
        ["quotaWeightBoldPct", "Price first", "", "", "%", 5, null],
      ]],
      ["UK CBAM", "Placeholders until HMRC publishes the steel rate and default values.", [
        ["cbamRatePerT", "Carbon price", "Close to the UK ETS allowance price", "£", "/t CO₂e", 1, null],
        ["cbamEafTPerT", "Electric-arc steel", "Emissions when the mill gives no verified figure", "", "t CO₂e/t", 0.05, null],
        ["cbamBofTPerT", "Blast-furnace steel", "Emissions when the mill gives no verified figure", "", "t CO₂e/t", 0.05, null],
        ["cbamUnknownTPerT", "Route not known", "Assumes the higher figure", "", "t CO₂e/t", 0.05, null],
        ["forecastCbamPassThroughPct", "Passed into UK prices", "Share of importers' CBAM cost the forecast adds to the UK market", "", "%", 5, null],
      ]],
    ],
  };
  const ALL_ROWS = [...ASM.thresholds, ...ASM.costs].flatMap((g) => g[2]);
  const SUMMARY = ["buyAheadTriggerPct", "holdMinScore", "waitTriggerPct", "costOfCapitalPct", "forecastStoragePerTMonth", "cbamRatePerT"];
  const num = (v, step) => (Number.isFinite(v) ? (step < 1 ? String(Math.round(v * 100) / 100) : Math.round(v).toLocaleString("en-GB")) : "—");
  const show = (row, v) => { const [, , , pre, suf, step] = row; return `${pre}${num(v, step)}${suf && !suf.startsWith("/") && !suf.startsWith("%") ? " " : ""}${suf}`; };
  const readOpen = () => { try { return localStorage.getItem("agx-asm-open") === "1"; } catch { return false; } };
  const writeOpen = (v) => { try { localStorage.setItem("agx-asm-open", v ? "1" : "0"); } catch { /* blocked */ } };

  function buildAssumptions() {
    const box = $("asm");
    const open = readOpen();
    const toggle = el("button", { type: "button", class: "btn btn-sm asm-toggle", id: "asm-toggle", "aria-expanded": String(open), "aria-controls": "asm-body" },
      el("span", { text: open ? "Hide" : "Review and edit" }), el("span", { class: "asm-chev", "aria-hidden": "true" }));
    toggle.addEventListener("click", () => { const now = toggle.getAttribute("aria-expanded") !== "true"; toggle.setAttribute("aria-expanded", String(now)); toggle.firstChild.textContent = now ? "Hide" : "Review and edit"; $("asm-body").hidden = !now; $("asm-summary").hidden = now; writeOpen(now); });
    const group = ([title, sub, rows]) => el("fieldset", { class: "asm-group" }, el("legend", { text: title }), sub ? el("p", { class: "asm-sub", text: sub }) : null, ...rows.map(rowEl));
    box.replaceChildren(
      el("header", { class: "asm-head" },
        el("div", { class: "asm-title" },
          el("h2", { id: "asm-title", text: "Assumptions and thresholds" }),
          el("p", { text: "Every number this plan is calculated on. Change a value to see its effect on this plan, then save it as the default for every plan." })),
        el("div", { class: "asm-actions" },
          el("span", { class: "asm-state", id: "asm-state", "aria-live": "polite" }),
          el("button", { type: "button", class: "btn btn-sm", id: "asm-reset", text: "Reset all", onclick: () => { overrides = {}; syncInputs(true); run(); } }),
          me.canEdit ? el("button", { type: "button", class: "btn btn-sm btn-primary", id: "asm-save", text: "Save as defaults", onclick: saveDefaults }) : null,
          toggle)),
      el("div", { class: "asm-summary", id: "asm-summary", hidden: open ? "" : null }),
      el("div", { class: "asm-body", id: "asm-body", hidden: open ? null : "" },
        el("div", { class: "asm-cols" },
          el("section", { class: "asm-col", "aria-labelledby": "asm-th" }, el("h3", { id: "asm-th", text: "Decision thresholds" }), el("p", { class: "asm-col-sub", text: "When the plan says buy ahead, hold off, or flags a risk." }), ...ASM.thresholds.map(group)),
          el("section", { class: "asm-col", "aria-labelledby": "asm-co" }, el("h3", { id: "asm-co", text: "Cost assumptions" }), el("p", { class: "asm-col-sub", text: "What goes into each supplier's landed cost and the forecast." }), ...ASM.costs.map(group))),
        el("section", { class: "asm-fixed", "aria-labelledby": "asm-fx" }, el("h3", { id: "asm-fx", text: "Fixed in the model" }), el("p", { class: "asm-col-sub", text: "Set by regulation or the model's design, so not editable here." }), el("dl", { id: "asm-fixed" }))));
    if (!open) $("asm-body").hidden = true;
    box.hidden = false;
    asmBuilt = true;
  }

  function rowEl(row) {
    const [key, label, help, pre, suf, step] = row;
    const id = `asm-${key}`;
    const input = el("input", { id, type: "number", step: String(step), inputmode: "decimal", "aria-describedby": `${id}-help ${id}-meta`, "data-key": key });
    input.addEventListener("input", () => onEdit(row, input));
    input.addEventListener("blur", () => { if (input.closest(".asm-row").classList.contains("is-error")) syncInputs(true); });
    return el("div", { class: "asm-row", "data-row": key },
      el("div", { class: "asm-text" }, el("label", { for: id, text: label }), help ? el("span", { class: "asm-help", id: `${id}-help`, text: help }) : null),
      el("div", { class: "asm-field" }, pre ? el("span", { class: "asm-pre", text: pre }) : null, input, suf ? el("span", { class: "asm-suf", text: suf }) : null),
      el("div", { class: "asm-meta", id: `${id}-meta` }));
  }

  function onEdit(row, input) {
    const [key] = row;
    const a = plan.assumptions;
    const [min, max] = a.limits[key] || [0, Infinity];
    const v = input.value === "" ? NaN : Number(input.value);
    const wrap = input.closest(".asm-row");
    if (!Number.isFinite(v) || v < min || v > max) {
      wrap.classList.add("is-error");
      wrap.querySelector(".asm-meta").replaceChildren(el("span", { class: "asm-err", text: `Use ${num(min, row[5])}–${num(max, row[5])}` }));
      return;
    }
    wrap.classList.remove("is-error");
    if (v === a.defaults[key]) delete overrides[key]; else overrides[key] = v;
    markRow(row);
    schedule();
  }

  function markRow(row) {
    const [key, , , , , , ctx] = row;
    const a = plan.assumptions;
    const wrap = $("asm").querySelector(`[data-row="${key}"]`);
    if (!wrap || wrap.classList.contains("is-error")) return;
    const changed = key in overrides && overrides[key] !== a.defaults[key];
    wrap.classList.toggle("is-changed", changed);
    const meta = wrap.querySelector(".asm-meta");
    const context = ctx ? ctx(plan) : "";
    meta.replaceChildren(...[
      changed ? el("span", { class: "asm-default" }, `Default ${show(row, a.defaults[key])}`, el("button", { type: "button", class: "asm-undo", "aria-label": `Reset ${row[1]} to ${show(row, a.defaults[key])}`, title: "Reset to default", text: "Reset",
        onclick: () => { delete overrides[key]; syncInputs(true); run(); } })) : null,
      context ? el("span", { class: "asm-ctx", text: context }) : null].filter(Boolean));
  }

  function syncInputs(force = false) {
    const a = plan.assumptions;
    for (const row of ALL_ROWS) {
      const input = $(`asm-${row[0]}`);
      if (!input) continue;
      if (force || document.activeElement !== input) {
        input.value = row[0] in overrides ? overrides[row[0]] : a.values[row[0]];
        input.closest(".asm-row").classList.remove("is-error");
      }
      markRow(row);
    }
  }

  function renderAssumptions(r) {
    if (!r.assumptions) return;
    if (!asmBuilt) buildAssumptions();
    const a = r.assumptions;
    // drop what-ifs the server refused or that now match the saved default
    for (const k of Object.keys(overrides)) if (a.errors[k] || overrides[k] === a.defaults[k]) delete overrides[k];
    syncInputs();
    const n = Object.keys(overrides).length;
    $("asm").classList.toggle("has-changes", n > 0);
    $("asm-state").replaceChildren(n ? el("span", { class: "asm-badge" }, `${n} changed for this plan`) : el("span", { class: "muted", text: a.savedAt ? `Saved defaults · updated ${fmt.date(a.savedAt.slice(0, 10))}` : "Using the standard defaults" }));
    $("asm-reset").hidden = !n;
    if ($("asm-save")) $("asm-save").hidden = !n;
    $("asm-summary").replaceChildren(...SUMMARY.map((k) => { const row = ALL_ROWS.find((x) => x[0] === k); const v = k in overrides ? overrides[k] : a.values[k];
      return el("span", { class: `asm-chip${k in overrides ? " is-changed" : ""}` }, el("span", { text: { buyAheadTriggerPct: "Buy ahead at", holdMinScore: "Hold score", waitTriggerPct: "Hold off at", costOfCapitalPct: "Capital", forecastStoragePerTMonth: "Storage", cbamRatePerT: "CBAM" }[k] }), el("b", { text: `${k === "buyAheadTriggerPct" ? "+" : k === "waitTriggerPct" ? "−" : ""}${show(row, v)}` })); }),
      ...(n > SUMMARY.filter((k) => k in overrides).length ? [el("span", { class: "asm-chip is-changed" }, el("b", { text: `+${n - SUMMARY.filter((k) => k in overrides).length} more changed` }))] : []));
    $("asm-fixed").replaceChildren(...a.fixed.map((f) => el("div", { class: "asm-fx" }, el("dt", { text: f.label }), el("dd", {}, el("b", { text: f.value }), el("span", { text: f.note })))));
  }

  async function saveDefaults(e) {
    const btn = e.currentTarget;
    const body = { ...overrides };
    if (!Object.keys(body).length) return;
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await api("/api/settings", { method: "PUT", body });
      overrides = {};
      toast("Saved. Every plan now uses these values.");
      await run();
    } catch (error) {
      toast(error.data && error.data.errors ? Object.values(error.data.errors).join(" ") : error.message, true);
    } finally { btn.disabled = false; btn.textContent = "Save as defaults"; }
  }

  // ---------------------------------------------------------------- render
  function render() {
    const r = plan, rec = r.recommendation;
    if (!rec.ok) {
      $("plan").replaceChildren(el("div", { class: "empty-state" }, el("h3", { text: "No supplier prices for this product" }), el("p", {}, rec.reason, " ", el("a", { href: "suppliers.html", text: "Open Suppliers →" }))));
      return;
    }
    $("plan").replaceChildren(hero(r, rec), el("div", { class: "plan-grid" }, stockCard(r), priceCard(r), compCard(r), quotaCard(r), holdCard(r), intelCard(r)), optionsCard(r, rec));
  }

  function hero(r, rec) {
    const b = rec.best, t = rec.timing;
    const pick = r.options.find((o) => o.id === chosen) || b;
    const tonnes = rec.recTonnes;
    return el("section", { class: "plan-hero card" },
      el("div", { class: "ph-top" },
        el("span", { class: `sig ${TIMING[t.action] || ""}`, text: t.label }),
        el("span", { class: "small muted", text: `${(r.appetites[r.inputs.appetite] || {}).label} approach${r.inputs.cbam ? " · UK CBAM included" : ""}` })),
      el("h2", { class: "ph-title" }, "Buy ", el("b", { text: `${tonnes} t` }), ` of ${r.product.name} from `, el("b", { text: b.name })),
      el("div", { class: "ph-figs" },
        el("div", {}, el("span", { text: "Landed cost" }), el("strong", { text: gbpT(b.effectivePerT) }), el("small", { text: "every cost counted" })),
        el("div", {}, el("span", { text: "Order total" }), el("strong", { text: gbp(b.effectivePerT * tonnes) }), el("small", { text: `${tonnes} t` })),
        el("div", {}, el("span", { text: "If quota missed" }), el("strong", { class: b.quotaExposure > 1 ? "is-bad" : "", text: b.quotaExposure > 1 ? `+${gbpT(b.quotaExposure)}` : "£0" }), el("small", { text: b.quotaExposure > 1 ? `${Math.round((b.probability || 0) * 100)}% chance by arrival` : "no quota risk" })),
        el("div", {}, el("span", { text: "Arrives" }), el("strong", { text: b.arrival ? fmt.date(b.arrival) : "—" }), el("small", { class: b.lateDays ? "is-bad" : "", text: b.lateDays ? `${b.lateDays} days after you run out` : `need it by ${fmt.date(r.inputs.needBy)}` }))),
      el("p", { class: "ph-timing", text: t.text }),
      el("div", { class: "ph-cols" },
        el("div", {}, el("h4", { text: "Why" }), el("ul", { class: "ph-list" }, ...rec.reasons.map((x) => el("li", { text: x })))),
        rec.watch.length ? el("div", {}, el("h4", { text: "Watch out" }), el("ul", { class: "ph-list is-watch" }, ...rec.watch.map((x) => el("li", { text: x })))) : null),
      el("div", { class: "ph-actions" },
        me.canEdit ? el("button", { class: "btn btn-primary", type: "button", text: pick.id === b.id ? `Save order with ${b.name}` : `Save order with ${pick.name}`, onclick: (e) => save(e.currentTarget, pick, tonnes) }) : null,
        el("a", { class: "btn", href: `suppliers.html?supplier=${pick.id}`, text: "Full cost breakdown" }),
        me.canEdit && (pick.quoteScope !== "product" || pick.quoteAgeDays > r.assumptions.values.staleQuoteDays) ? el("a", { class: "btn", href: `suppliers.html?rfq=${r.product.id}`, text: "Request fresh quotes" }) : null,
        me.canEdit ? el("button", { class: "link-btn", type: "button", text: "+ Log market intel", onclick: () => window.openMarketIntel({ scope: "product", targetId: r.product.id }) }) : null));
  }

  async function save(btn, opt, tonnes) {
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      const res = await api("/api/orders/plan/save", { method: "POST", body: { productId: plan.product.id, supplierId: opt.id, tonnage: tonnes, cbam: plan.inputs.cbam, assume: overrides, timing: plan.recommendation.timing.action, reasons: plan.recommendation.reasons } });
      toast("Order saved as a draft. Submit it for approval from the order page.");
      location.href = `order.html?id=${res.id}`;
    } catch (error) { toast(error.message, true); btn.disabled = false; btn.textContent = "Save order"; }
  }

  const card = (title, sub, ...kids) => el("section", { class: "plan-card" }, el("div", { class: "pc-head" }, el("h3", { text: title }), sub ? el("span", { class: "small muted", text: sub }) : null), ...kids);
  const fact = (k, v, cls) => el("div", { class: "pc-fact" }, el("span", { text: k }), el("b", { class: cls || "", text: v }));

  function stockCard(r) {
    const p = r.product;
    const st = { critical: ["Order now", "is-risk"], reorder: ["Order now", "is-risk"], low: ["Order soon", "is-maybe"], ok: ["OK", "is-go"], "no-usage": ["No usage", ""] }[p.status] || [p.status, ""];
    return card("Your stock", null,
      el("span", { class: `sig ${st[1]}`, text: st[0] }), el("p", { class: "pc-note", text: p.reason }),
      fact("In stock", `${Math.round(p.stockT)} t`), fact("You use", `${p.monthlyUsageT} t a month`),
      fact("Cover", p.coverMonths !== null ? `${p.coverMonths.toFixed(1)} months` : "—"), fact("Runs out", p.stockOutDate ? fmt.date(p.stockOutDate) : "—"),
      p.latestOrderDate ? fact("Order by", fmt.date(p.latestOrderDate), p.latestOrderDate <= r.today ? "is-bad" : "") : null);
  }

  function priceCard(r) {
    const f = r.forecast, m = r.market, best = r.recommendation.best;
    const rows = r.aheadOptions || [];
    return card("Price outlook", f ? `UK steel ${pct(f.in3)} over 3 months` : "No forecast yet",
      fact("Best landed now", gbpT(best.effectivePerT)), fact("You pay now", gbpT(m.yourCost)),
      m.benchmark ? fact(m.benchmarkLabel.replace(/^./, (c) => c.toUpperCase()), gbpT(m.benchmark)) : fact("Market price", "Not set"),
      f && f.in3Price ? fact("Expected in 3 months", `${gbpT(f.in3Price)} (${gbp(f.band3[0])}–${gbp(f.band3[1])})`, f.in3 >= 1 ? "is-up" : f.in3 <= -1 ? "is-down" : "") : null,
      rows.length ? el("div", { class: "pc-ahead" }, el("span", { class: "pc-sub", text: "Buying ahead, after holding costs" }),
        ...rows.map((a) => el("div", { class: "pc-ahead-row" }, el("span", { text: `+${a.months} mo (${Math.round(a.tonnes)} t)` }), el("b", { class: a.netMid > 0 ? "is-down" : "is-up", text: `${a.netMid >= 0 ? "+" : "−"}${gbp(Math.abs(a.netMid))}` })))) : null,
      el("a", { class: "pc-link", href: `products.html?product=${r.product.id}`, text: "Product market prices →" }));
  }

  function compCard(r) {
    const c = r.competition;
    const bars = el("div", { class: "pc-bars", role: "img", "aria-label": "UK imports of this product by month" });
    const max = Math.max(...c.volume.map((v) => v.tonnes), 1);
    c.volume.forEach((v) => bars.append(el("span", { class: v.avg12 && v.tonnes > v.avg12 * 1.25 ? "is-hot" : "", style: `height:${Math.max(3, (v.tonnes / max) * 40)}px`, title: `${per(v.p)}: ${v.tonnes.toLocaleString("en-GB")} t` })));
    return card("Competition", c.hasData ? `UK imports of this code, 12 months` : "Load HMRC history for volumes",
      c.hasData ? bars : null,
      c.vsAvgPct !== null ? fact("Latest month vs normal", pct(c.vsAvgPct), c.vsAvgPct >= 25 ? "is-up" : c.vsAvgPct <= -25 ? "is-down" : "") : null,
      fact("UK companies importing it", c.buyers.source === "none" ? "—" : String(c.buyers.exact)),
      c.rivals.length ? el("ul", { class: "pc-rivals" }, ...c.rivals.slice(0, 4).map((x) => el("li", {}, el("b", { text: x.name }), ` ${({ "stepping-up": "stepping up", expanding: "widening range", slowing: "slowing", quiet: "gone quiet", steady: "steady" })[x.signal] || x.signal}`,
        x.stock ? el("span", { class: "row-sub", text: ` · stock £${(x.stock.value / 1e6).toFixed(1)}m${x.stockPrev && x.stockPrev.value ? ` (${x.stock.value >= x.stockPrev.value ? "+" : "−"}${Math.abs(Math.round(((x.stock.value - x.stockPrev.value) / x.stockPrev.value) * 100))}%)` : ""}` }) : null))) : el("p", { class: "pc-note", text: "None of the competitors you follow import this code." }),
      el("a", { class: "pc-link", href: "competition.html", text: "Competition →" }));
  }

  function quotaCard(r) {
    const q = r.quota;
    if (!r.product.steelCategory) return card("Quota", null, el("p", { class: "pc-note", text: "Not in a steel-measure category, so there's no quota to worry about." }));
    if (!q) return card("Quota", r.product.steelCategory.name, el("p", { class: "pc-note", text: "Quota data isn't available right now." }));
    const [rl, rc] = RISK[q.risk] || [q.risk, ""];
    const arrival = r.recommendation.best.arrival;
    return card("Quota", `Category ${r.product.steelCategory.id}`,
      el("span", { class: `sig ${rc}`, text: rl }),
      fact(`${q.origin || "Line"} ${q.orderNumber}`, `${Math.round(q.balanceT).toLocaleString("en-GB")} t left`),
      el("span", { class: "sp-bar pc-quota" }, el("span", { style: `width:${Math.round((q.usedShare || 0) * 100)}%` })),
      q.runOutDate ? fact("Runs out about", fmt.date(q.runOutDate), arrival && q.runOutDate < arrival ? "is-bad" : "") : null,
      fact("Next quarter opens", fmt.date(q.nextStartDate)),
      el("a", { class: "pc-link", href: "quotas.html", text: "Live quotas →" }));
  }

  function holdCard(r) {
    const s = r.stockpile;
    if (!s) return card("Safe to hold?", null, el("p", { class: "pc-note", text: "Not scored yet." }));
    const cls = { good: "is-go", ok: "is-maybe", caution: "", risk: "is-risk" }[s.level];
    return card("Safe to hold?", `#${s.rank} of ${s.of} products`,
      el("span", { class: `sig ${cls}`, text: `${s.score}/100` }), el("p", { class: "pc-note", text: s.text }),
      fact("Price swings", s.volatilityPct !== null ? `±${s.volatilityPct.toFixed(1)}% a month` : "—"),
      fact("UK buyers of this code", String(s.buyers ?? "—")),
      el("a", { class: "pc-link", href: "products.html", text: "Stockpiling ranking →" }));
  }

  function intelCard(r) {
    return card("Market intel", r.intel.length ? `${r.intel.length} in these prices` : "Nothing logged",
      r.intel.length ? el("ul", { class: "pc-rivals" }, ...r.intel.slice(0, 5).map((n) => el("li", {}, el("b", { text: n.effectUnit === "pct" ? `${n.effectValue > 0 ? "+" : ""}${n.effectValue}%` : `${n.effectValue > 0 ? "+" : "−"}£${Math.abs(n.effectValue)}/t` }), ` ${n.title}`, el("span", { class: "row-sub", text: ` · ${n.scope === "market" ? "whole market" : n.targetName}` })))) : el("p", { class: "pc-note", text: "Heard something about prices or a supplier? Log it and the plan recalculates." }),
      me.canEdit ? el("button", { class: "btn btn-sm", type: "button", text: "Log market intel", onclick: () => window.openMarketIntel({ scope: "product", targetId: r.product.id }) }) : null);
  }

  function optionsCard(r, rec) {
    const tags = (o) => [o.id === rec.best.id ? ["Best overall", "is-go"] : null, rec.alternatives.cheapest && o.id === rec.alternatives.cheapest.id && o.id !== rec.best.id ? ["Cheapest", "is-maybe"] : null,
      rec.alternatives.safest && o.id === rec.alternatives.safest.id && o.id !== rec.best.id ? ["Lowest risk", ""] : null, rec.alternatives.fastest && o.id === rec.alternatives.fastest.id && o.id !== rec.best.id ? ["Fastest", ""] : null].filter(Boolean);
    return el("section", { class: "card mk-card plan-options" },
      el("div", { class: "card-head" }, el("div", {}, el("h2", { text: "Every supplier for this order" }), el("p", { class: "small muted", style: "margin:2px 0 0", text: `Priced for ${r.inputs.tonnage} t with each supplier's lead time. "Risk-adjusted" adds ${weightOf(r.inputs.appetite) ? `${weightOf(r.inputs.appetite)}%` : "none"} of the quota-miss cost and a penalty for arriving after you run out. Pick one to save it instead.` }))),
      el("div", { class: "table-scroll" }, el("table", { class: "quota-table plan-table" },
        el("thead", {}, el("tr", {}, el("th", {}), el("th", { text: "Supplier" }), el("th", { class: "num", text: "Landed cost" }), el("th", { class: "num", text: "If quota missed" }), el("th", { class: "num", text: "Risk-adjusted" }), el("th", { text: "Arrives" }), el("th", { text: "Notes" }))),
        el("tbody", {}, ...r.options.map((o, i) => el("tr", { class: `opp-row${o.id === chosen ? " is-chosen" : ""}`, style: `--d:${i * 40}ms`, onclick: () => { chosen = o.id; render(); } },
          el("td", {}, el("input", { type: "radio", name: "pick", "aria-label": `Choose ${o.name}`, ...(o.id === chosen ? { checked: "" } : {}), onchange: () => { chosen = o.id; render(); } })),
          el("td", {}, el("strong", { text: o.name }), el("div", { class: "row-sub" }, `${o.origin || ""}${o.covers === "everything" ? " · all-in" : o.covers === "except-duty" ? " · + duty" : ""}`, ...tags(o).map(([l, c]) => el("span", { class: `sig ${c} plan-tag`, text: l })))),
          el("td", { class: "num" }, el("strong", { text: gbpT(o.effectivePerT) }), el("div", { class: "row-sub", text: `quoted ${gbpT(o.quotedPerT)}` })),
          el("td", { class: "num" }, el("span", { class: o.quotaExposure > 1 ? "is-bad" : "muted", text: o.quotaExposure > 1 ? `+${gbpT(o.quotaExposure)}` : "—" })),
          el("td", { class: "num" }, el("strong", { text: gbpT(o.score) }), o.latePenalty ? el("div", { class: "row-sub is-bad", text: `incl. ${gbpT(o.latePenalty)} late` }) : null),
          el("td", {}, el("span", { class: o.lateDays ? "is-bad" : "", text: o.arrival ? fmt.date(o.arrival) : "—" }), el("div", { class: "row-sub", text: o.leadDays ? (o.leadDays < 14 ? `${o.leadDays} days lead` : `${Math.round(o.leadDays / 7)} wk lead`) : "" })),
          el("td", {}, o.warnings.length ? el("ul", { class: "plan-warn" }, ...o.warnings.slice(0, 3).map((w) => el("li", { text: w }))) : el("span", { class: "muted small", text: "No concerns" }))))))),
      r.unpriced.length ? el("p", { class: "lad-note", text: `Couldn't price: ${r.unpriced.map((u) => `${u.name} (${(u.error || "").replace(/\.$/, "").toLowerCase()})`).join("; ")}.` }) : null);
  }

  // ---------------------------------------------------------------- start
  $("plan-form").addEventListener("change", (e) => { if (e.target.id === "pf-product") { $("pf-tonnes").value = ""; $("pf-needby").value = ""; run({ keepInputs: false }); } else schedule(); });
  $("pf-tonnes").addEventListener("input", schedule);
  $("pf-cbam").addEventListener("click", () => { try { localStorage.setItem("agx-cbam", readCbam() ? "off" : "on"); } catch { /* blocked */ } fillForm(); run(); });
  $("plan-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  window.addEventListener("agx:intel", () => run());
  loadMe().then((m) => { me = m; if (plan) render(); }).catch(() => {});
  api("/api/orders/needs").then((r) => {
    products = r.products;
    fillProducts();
    fillForm();
    const want = new URLSearchParams(location.search).get("product");
    if (want && products.some((p) => p.id === want)) $("pf-product").value = want;
    run({ keepInputs: false });
  }).catch((error) => { $("plan").replaceChildren(el("p", { class: "muted", text: `Couldn't load products: ${error.message}` })); });
})();
