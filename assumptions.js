// Assumptions: the numbers every order plan runs on, on one page.
(function () {
  "use strict";
  const { api, el, toast } = window.OrderTool;
  const $ = (id) => document.getElementById(id);

  // [key, label, prefix, unit, min, max, step]
  const SECTIONS = [
    ["Buy ahead when", [
      ["buyAheadTriggerPct", "Forecast rise, 3 months", "+", "%", 0, 10, 0.1],
      ["buyAheadMinSaving", "Saving after holding costs", "£", "", 0, 5000, 50],
      ["holdMinScore", "Stockpiling score", "", "/100", 0, 100, 1],
    ]],
    ["Hold off when", [
      ["waitTriggerPct", "Forecast fall, 3 months", "−", "%", 0, 10, 0.1],
      ["waitCoverBufferMonths", "Spare cover after lead time", "", " months", 0, 6, 0.25],
    ]],
    ["Costs", [
      ["costOfCapitalPct", "Cost of capital", "", "%/yr", 0, 20, 0.25],
      ["forecastStoragePerTMonth", "Storage", "£", "/t/month", 0, 20, 0.5],
      ["deliveryPerT", "Delivery", "£", "/t", 0, 100, 1],
      ["stockOutPerDayPct", "Arriving late", "", "%/day", 0, 2, 0.05],
    ]],
    ["Quota risk counted", [
      ["quotaWeightCautiousPct", "Cautious", "", "%", 0, 100, 5],
      ["quotaWeightBalancedPct", "Balanced", "", "%", 0, 100, 5],
      ["quotaWeightBoldPct", "Price first", "", "%", 0, 100, 5],
    ]],
    ["Flag when", [
      ["staleQuoteDays", "Quote older than", "", " days", 7, 120, 1],
      ["onTimeWarnPct", "On time below", "", "%", 50, 100, 1],
      ["quotaWarnProbPct", "Quota run-out risk above", "", "%", 5, 90, 5],
      ["importSurgePct", "UK imports above normal", "+", "%", 5, 200, 5],
    ]],
  ];
  const ROWS = SECTIONS.flatMap((s) => s[1]);
  let data = null;
  let draft = {}; // unsaved edits

  const fmtVal = (row, v) => `${row[2]}${row[6] < 1 ? String(Math.round(v * 100) / 100) : Math.round(v).toLocaleString("en-GB")}${row[3]}`;
  const current = (k) => (k in draft ? draft[k] : data.values[k]);
  const card = (title, kids, extra = {}) => el("section", { class: `as-card${extra.cls ? ` ${extra.cls}` : ""}`, "aria-labelledby": `as-${title.replace(/\W/g, "")}` },
    el("div", { class: "as-card-head" }, el("h2", { id: `as-${title.replace(/\W/g, "")}`, text: title }), extra.badge || null), ...kids);

  function render() {
    const c = data.cbam;
    $("as-root").replaceChildren(
      el("div", { class: "as-grid" },
        ...SECTIONS.map(([title, rows]) => card(title, rows.map(rowEl))),
        card("UK CBAM", [el("dl", { class: "as-fixed-list" }, ...c.rows.map((r) => el("div", {}, el("dt", { text: r.label }), el("dd", { text: r.value }))))],
          { cls: "is-fixed", badge: el("span", { class: "as-badge", title: c.status === "awaiting" ? "HMRC publishes the steel rate and default values before 1 January 2027. Placeholders until then." : "Published by HMRC" }, c.status === "awaiting" ? "UK regulation · awaiting HMRC" : "UK regulation") })),
      el("details", { class: "as-fixed" },
        el("summary", { text: "Fixed in the model" }),
        el("dl", {}, ...data.fixed.map((f) => el("div", {}, el("dt", { text: f.label }), el("dd", { text: f.value }))))));
    refresh();
  }

  function paint(input) { const min = Number(input.min), max = Number(input.max); input.style.setProperty("--p", `${((Number(input.value) - min) / (max - min || 1)) * 100}%`); }

  function rowEl(row) {
    const [key, label, , , min, max, step] = row;
    const id = `as-${key}`;
    const v = current(key);
    const input = el("input", { id, type: "range", class: "as-slider", min: String(Math.min(min, v)), max: String(Math.max(max, v)), step: String(step), value: String(v), ...(data.canEdit ? {} : { disabled: "" }) });
    const out = el("output", { class: "as-val", for: id, text: fmtVal(row, v) });
    input.addEventListener("input", () => {
      const n = Number(input.value);
      out.textContent = fmtVal(row, n);
      input.setAttribute("aria-valuetext", fmtVal(row, n));
      paint(input);
      if (n === data.values[key]) delete draft[key]; else draft[key] = n;
      refresh();
    });
    paint(input);
    input.setAttribute("aria-valuetext", fmtVal(row, v));
    return el("div", { class: "as-row", "data-key": key },
      el("div", { class: "as-top" }, el("label", { for: id, text: label }), el("span", { class: "as-right" }, el("button", { type: "button", class: "as-reset", hidden: "", "aria-label": `Reset ${label}`, title: "Reset", text: "↺",
        onclick: () => { input.value = String(data.standard[key]); input.dispatchEvent(new Event("input")); } }), out)),
      input);
  }

  function refresh() {
    for (const row of ROWS) {
      const r = document.querySelector(`.as-row[data-key="${row[0]}"]`);
      if (!r) continue;
      const v = current(row[0]), std = data.standard[row[0]];
      r.classList.toggle("is-edited", row[0] in draft);
      const reset = r.querySelector(".as-reset");
      reset.hidden = !data.canEdit || v === std;
      reset.title = `Reset to ${fmtVal(row, std)}`;
    }
    const n = Object.keys(draft).length;
    $("as-savebar").hidden = !n;
    $("as-count").textContent = `${n} unsaved change${n === 1 ? "" : "s"}`;
    $("as-save").disabled = !n;
  }

  async function load() {
    try {
      data = await api("/api/orders/assumptions");
      draft = {};
      render();
    } catch (error) { $("as-root").replaceChildren(el("p", { class: "muted", text: `Couldn't load assumptions: ${error.message}` })); }
  }

  $("as-discard").addEventListener("click", () => { draft = {}; render(); });
  $("as-save").addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true; btn.textContent = "Saving…";
    try {
      await api("/api/settings", { method: "PUT", body: draft });
      toast("Saved. Every order plan now uses these numbers.");
      await load();
    } catch (error) {
      toast(error.data && error.data.errors ? Object.values(error.data.errors).join(" ") : error.message, true);
    } finally { btn.textContent = "Save changes"; refresh(); }
  });
  window.addEventListener("beforeunload", (e) => { if (Object.keys(draft).length) { e.preventDefault(); e.returnValue = ""; } });
  load();
})();
