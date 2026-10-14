// Assumptions: the numbers every order plan runs on. Each approach (cash flow,
// speed, balanced) has its own weights and thresholds; costs and warnings are shared.
(function () {
  "use strict";
  const { api, el, toast } = window.OrderTool;
  const $ = (id) => document.getElementById(id);

  const APPROACHES = [["cashflow", "Cash flow"], ["speed", "Speed"], ["balanced", "Balanced"]];
  // [key, label, prefix, unit, min, max, step]
  const PER_APPROACH = [
    ["Weighting", [
      ["cashRatePct", "Payment terms", "", "%/yr", 0, 40, 1],
      ["leadDayPct", "Lead time", "", "%/day", 0, 0.3, 0.01],
      ["reliabilityPct", "Reliability", "", "%/pt", 0, 0.5, 0.01],
      ["quotaWeightPct", "Quota risk", "", "%", 0, 100, 5],
      ["stockOutPerDayPct", "Arriving late", "", "%/day", 0, 2, 0.05],
    ]],
    ["Buy ahead when", [
      ["buyAheadTriggerPct", "Forecast rise, 3 months", "+", "%", 0, 10, 0.1],
      ["buyAheadMinSaving", "Saving after holding costs", "£", "", 0, 5000, 50],
      ["holdMinScore", "Stockpiling score", "", "/100", 0, 100, 1],
    ]],
    ["Hold off when", [
      ["waitTriggerPct", "Forecast fall, 3 months", "−", "%", 0, 10, 0.1],
      ["waitCoverBufferMonths", "Spare cover after lead time", "", " months", 0, 6, 0.25],
    ]],
  ];
  const SHARED = [
    ["Costs", [
      ["costOfCapitalPct", "Cost of capital", "", "%/yr", 0, 20, 0.25],
      ["forecastStoragePerTMonth", "Storage", "£", "/t/month", 0, 20, 0.5],
      ["deliveryPerT", "Delivery", "£", "/t", 0, 100, 1],
    ]],
    ["Flag when", [
      ["staleQuoteDays", "Quote older than", "", " days", 7, 120, 1],
      ["onTimeWarnPct", "On time below", "", "%", 50, 100, 1],
      ["quotaWarnProbPct", "Quota run-out risk above", "", "%", 5, 90, 5],
      ["importSurgePct", "UK imports above normal", "+", "%", 5, 200, 5],
    ]],
  ];
  let data = null;
  let draft = { shared: {}, approaches: {} }; // unsaved edits
  let tab = (() => { try { return localStorage.getItem("agx-asm-ap") || "balanced"; } catch { return "balanced"; } })();
  if (!APPROACHES.some((a) => a[0] === tab)) tab = "balanced";

  const fmtVal = (row, v) => `${row[2]}${row[6] < 1 ? String(Math.round(v * 100) / 100) : Math.round(v).toLocaleString("en-GB")}${row[3]}`;
  const saved = (scope, k) => (scope === "shared" ? data.values[k] : data.approaches[scope][k]);
  const standard = (scope, k) => (scope === "shared" ? data.standard[k] : data.standardApproaches[scope][k]);
  const bucket = (scope) => (scope === "shared" ? draft.shared : (draft.approaches[scope] = draft.approaches[scope] || {}));
  const current = (scope, k) => { const b = bucket(scope); return k in b ? b[k] : saved(scope, k); };
  const count = () => Object.keys(draft.shared).length + Object.values(draft.approaches).reduce((t, x) => t + Object.keys(x).length, 0);
  const card = (title, kids, extra = {}) => el("section", { class: `as-card${extra.cls ? ` ${extra.cls}` : ""}`, "aria-labelledby": `as-${title.replace(/\W/g, "")}` },
    el("div", { class: "as-card-head" }, el("h2", { id: `as-${title.replace(/\W/g, "")}`, text: title }), extra.badge || null), ...kids);

  function render() {
    const c = data.cbam;
    const tabs = el("div", { class: "seg as-tabs", role: "tablist", "aria-label": "Approach" }, ...APPROACHES.map(([k, l]) => {
      const n = Object.keys(draft.approaches[k] || {}).length;
      return el("button", { type: "button", role: "tab", id: `as-tab-${k}`, "aria-selected": String(tab === k), "aria-pressed": String(tab === k), "aria-controls": "as-ap-panel", tabindex: tab === k ? "0" : "-1",
        onclick: () => { tab = k; try { localStorage.setItem("agx-asm-ap", k); } catch { /* blocked */ } render(); },
        onkeydown: (e) => { if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return; e.preventDefault(); const i = APPROACHES.findIndex((x) => x[0] === tab); tab = APPROACHES[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3][0]; render(); $(`as-tab-${tab}`).focus(); } },
      l, n ? el("span", { class: "as-tab-dot", "aria-label": `${n} unsaved` }) : null);
    }));
    $("as-root").replaceChildren(
      el("div", { class: "as-ap-head" }, el("h2", { text: "Approach" }), tabs),
      el("div", { class: "as-grid", id: "as-ap-panel", role: "tabpanel", "aria-labelledby": `as-tab-${tab}` }, ...PER_APPROACH.map(([title, rows]) => card(title, rows.map((r) => rowEl(tab, r))))),
      el("div", { class: "as-grid as-shared" },
        ...SHARED.map(([title, rows]) => card(title, rows.map((r) => rowEl("shared", r)))),
        card("UK CBAM", [el("dl", { class: "as-fixed-list" }, ...c.rows.map((r) => el("div", {}, el("dt", { text: r.label }), el("dd", { text: r.value }))))],
          { cls: "is-fixed", badge: el("span", { class: "as-badge", title: c.status === "awaiting" ? "HMRC publishes the steel rate and default values before 1 January 2027. Placeholders until then." : "Published by HMRC" }, c.status === "awaiting" ? "UK regulation · awaiting HMRC" : "UK regulation") })),
      el("details", { class: "as-fixed" },
        el("summary", { text: "Fixed in the model" }),
        el("dl", {}, ...data.fixed.map((f) => el("div", {}, el("dt", { text: f.label }), el("dd", { text: f.value }))))));
    refresh();
  }

  function paint(input) { const min = Number(input.min), max = Number(input.max); input.style.setProperty("--p", `${((Number(input.value) - min) / (max - min || 1)) * 100}%`); }

  function rowEl(scope, row) {
    const [key, label, , , min, max, step] = row;
    const id = `as-${scope}-${key}`;
    const v = current(scope, key);
    const input = el("input", { id, type: "range", class: "as-slider", min: String(Math.min(min, v)), max: String(Math.max(max, v)), step: String(step), value: String(v), "aria-valuetext": fmtVal(row, v), ...(data.canEdit ? {} : { disabled: "" }) });
    const out = el("output", { class: "as-val", for: id, text: fmtVal(row, v) });
    input.addEventListener("input", () => {
      const n = Number(input.value);
      out.textContent = fmtVal(row, n);
      input.setAttribute("aria-valuetext", fmtVal(row, n));
      paint(input);
      const b = bucket(scope);
      if (n === saved(scope, key)) delete b[key]; else b[key] = n;
      refresh();
    });
    paint(input);
    return el("div", { class: "as-row", "data-scope": scope, "data-key": key },
      el("div", { class: "as-top" }, el("label", { for: id, text: label }), el("span", { class: "as-right" }, el("button", { type: "button", class: "as-reset", hidden: "", "aria-label": `Reset ${label}`, text: "↺",
        onclick: () => { input.value = String(standard(scope, key)); input.dispatchEvent(new Event("input")); } }), out)),
      input);
  }

  function refresh() {
    for (const r of document.querySelectorAll(".as-row[data-key]")) {
      const scope = r.dataset.scope, key = r.dataset.key;
      const row = [...PER_APPROACH, ...SHARED].flatMap((g) => g[1]).find((x) => x[0] === key);
      const v = current(scope, key), std = standard(scope, key);
      r.classList.toggle("is-edited", key in bucket(scope));
      const reset = r.querySelector(".as-reset");
      reset.hidden = !data.canEdit || v === std;
      reset.title = `Reset to ${fmtVal(row, std)}`;
    }
    for (const [k] of APPROACHES) {
      const t = $(`as-tab-${k}`);
      if (!t) continue;
      const n = Object.keys(draft.approaches[k] || {}).length;
      const dot = t.querySelector(".as-tab-dot");
      if (n && !dot) t.append(el("span", { class: "as-tab-dot", "aria-label": `${n} unsaved` }));
      if (!n && dot) dot.remove();
    }
    const n = count();
    $("as-savebar").hidden = !n;
    $("as-count").textContent = `${n} unsaved change${n === 1 ? "" : "s"}`;
    $("as-save").disabled = !n;
  }

  async function load() {
    try {
      data = await api("/api/orders/assumptions");
      draft = { shared: {}, approaches: {} };
      render();
    } catch (error) { $("as-root").replaceChildren(el("p", { class: "muted", text: `Couldn't load assumptions: ${error.message}` })); }
  }

  $("as-discard").addEventListener("click", () => { draft = { shared: {}, approaches: {} }; render(); });
  $("as-save").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await api("/api/settings", { method: "PUT", body: { ...draft.shared, approaches: draft.approaches } });
      toast("Saved. Every order plan now uses these numbers.");
      await load();
    } catch (error) {
      toast(error.data && error.data.errors ? Object.values(error.data.errors).join(" ") : error.message, true);
    } finally { btn.textContent = "Save changes"; refresh(); }
  });
  window.addEventListener("beforeunload", (e) => { if (count()) { e.preventDefault(); e.returnValue = ""; } });
  load();
})();
