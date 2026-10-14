// Assumptions: the numbers every order plan runs on, on one page.
(function () {
  "use strict";
  const { api, el, toast } = window.OrderTool;
  const $ = (id) => document.getElementById(id);

  // [key, label, prefix, unit, step, tip]
  const SECTIONS = [
    ["Buy ahead when", [
      ["buyAheadTriggerPct", "Forecast rise, 3 months", "", "%", 0.1, "The steel forecast must rise at least this much."],
      ["buyAheadMinSaving", "Saving after holding costs", "£", "", 50, ""],
      ["holdMinScore", "Stockpiling score", "", "/100", 1, "Shown on Products."],
    ]],
    ["Hold off when", [
      ["waitTriggerPct", "Forecast fall, 3 months", "", "%", 0.1, ""],
      ["waitCoverBufferMonths", "Spare cover after lead time", "", "months", 0.25, ""],
    ]],
    ["Costs", [
      ["costOfCapitalPct", "Cost of capital", "", "%/yr", 0.25, ""],
      ["forecastStoragePerTMonth", "Storage", "£", "/t/month", 0.5, ""],
      ["deliveryPerT", "Delivery", "£", "/t", 1, "Only for suppliers who charge it on top."],
      ["stockOutPerDayPct", "Arriving late", "", "%/day", 0.05, "Share of the order's value for each day after you run out."],
    ]],
    ["Quota risk counted", [
      ["quotaWeightCautiousPct", "Cautious", "", "%", 5, ""],
      ["quotaWeightBalancedPct", "Balanced", "", "%", 5, ""],
      ["quotaWeightBoldPct", "Price first", "", "%", 5, ""],
    ]],
    ["UK CBAM", [
      ["cbamRatePerT", "Carbon price", "£", "/t CO₂", 1, "Placeholder until HMRC publishes the rate."],
      ["cbamEafTPerT", "Electric-arc emissions", "", "t CO₂/t", 0.05, ""],
      ["cbamBofTPerT", "Blast-furnace emissions", "", "t CO₂/t", 0.05, ""],
      ["cbamUnknownTPerT", "Unknown-route emissions", "", "t CO₂/t", 0.05, ""],
      ["forecastCbamPassThroughPct", "Passed into UK prices", "", "%", 5, ""],
    ]],
    ["Flag when", [
      ["staleQuoteDays", "Quote older than", "", "days", 1, ""],
      ["onTimeWarnPct", "On time below", "", "%", 1, ""],
      ["quotaWarnProbPct", "Quota run-out risk above", "", "%", 1, ""],
      ["importSurgePct", "UK imports above normal", "", "%", 1, ""],
    ]],
  ];
  const ROWS = SECTIONS.flatMap((s) => s[1]);
  let data = null;
  let draft = {}; // unsaved edits

  const fmtVal = (row, v) => `${row[2]}${Number.isFinite(v) ? (row[4] < 1 ? String(Math.round(v * 100) / 100) : Math.round(v).toLocaleString("en-GB")) : "—"}${row[3] ? `${/^[%/]/.test(row[3]) ? "" : " "}${row[3]}` : ""}`;
  const current = (k) => (k in draft ? draft[k] : data.values[k]);

  function render() {
    const root = $("as-root");
    root.replaceChildren(
      el("div", { class: "as-grid" }, ...SECTIONS.map(([title, rows]) => el("section", { class: "as-card", "aria-labelledby": `as-${title.replace(/\W/g, "")}` },
        el("h2", { id: `as-${title.replace(/\W/g, "")}`, text: title }),
        el("div", { class: "as-rows" }, ...rows.map(rowEl))))),
      el("details", { class: "as-fixed" },
        el("summary", { text: "Fixed in the model" }),
        el("dl", {}, ...data.fixed.map((f) => el("div", {}, el("dt", { text: f.label }), el("dd", { text: f.value }))))));
    refresh();
  }

  function rowEl(row) {
    const [key, label, pre, unit, step, tip] = row;
    const id = `as-${key}`;
    const input = el("input", { id, type: "number", step: String(step), inputmode: "decimal", value: String(current(key)), ...(data.canEdit ? {} : { disabled: "" }) });
    input.addEventListener("input", () => {
      const [min, max] = data.limits[key];
      const v = input.value === "" ? NaN : Number(input.value);
      const r = input.closest(".as-row");
      const bad = !Number.isFinite(v) || v < min || v > max;
      r.classList.toggle("is-error", bad);
      r.querySelector(".as-note").textContent = bad ? `Use ${min}–${max.toLocaleString("en-GB")}` : "";
      if (!bad) { if (v === data.values[key]) delete draft[key]; else draft[key] = v; }
      refresh();
    });
    return el("div", { class: "as-row", "data-key": key },
      el("label", { for: id, title: tip || null }, label, tip ? el("span", { class: "as-tip", "aria-hidden": "true", text: "?" }) : null),
      el("div", { class: "as-field" }, pre ? el("span", { class: "as-pre", text: pre }) : null, input, unit ? el("span", { class: "as-unit", text: unit }) : null),
      el("span", { class: "as-note", "aria-live": "polite" }));
  }

  // highlight edits and anything that differs from the standard value
  function refresh() {
    for (const row of ROWS) {
      const r = document.querySelector(`.as-row[data-key="${row[0]}"]`);
      if (!r || r.classList.contains("is-error")) continue;
      const v = current(row[0]), std = data.standard[row[0]];
      r.classList.toggle("is-edited", row[0] in draft);
      const note = r.querySelector(".as-note");
      note.replaceChildren(...(v !== std && data.canEdit ? [el("button", { type: "button", class: "as-reset", text: `Reset to ${fmtVal(row, std)}`, onclick: () => { const i = $(`as-${row[0]}`); i.value = String(std); i.dispatchEvent(new Event("input")); } })] : []));
    }
    const n = Object.keys(draft).length;
    const bad = document.querySelectorAll(".as-row.is-error").length;
    $("as-savebar").hidden = !n && !bad;
    $("as-count").textContent = bad ? `Fix ${bad} value${bad === 1 ? "" : "s"} to save` : `${n} unsaved change${n === 1 ? "" : "s"}`;
    $("as-save").disabled = Boolean(bad) || !n;
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
