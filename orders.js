(function () {
  "use strict";
  const { api, apiBase, fmt, el, statusBadge, quotaBadge, toast, loadDataStatus, loadMe } = window.OrderTool;
  document.getElementById("csv-btn").href = `${apiBase}/api/scenarios.csv`;

  const rowsEl = document.getElementById("rows");
  const emptyEl = document.getElementById("empty");
  const search = document.getElementById("search");
  const statusFilter = document.getElementById("filter-status");
  const originFilter = document.getElementById("filter-origin");
  const compareBtn = document.getElementById("compare-btn");
  const selected = new Set();
  let all = [];

  // The summary boxes were removed from the page; kept as a no-op so
  // existing calls still work.
  function renderKpis() {}

  function render() {
    const q = search.value.trim().toLowerCase();
    const st = statusFilter.value;
    const og = originFilter.value;
    const rows = all.filter((s) => {
      if (st && s.status !== st) return false;
      if (og && s.origin !== og) return false;
      if (!q) return true;
      return [s.title, s.commodityCode, s.commodityDescription, s.supplier].some((v) => String(v || "").toLowerCase().includes(q));
    });

    rowsEl.replaceChildren(...rows.map((s) => {
      const box = el("input", {
        type: "checkbox",
        "aria-label": `Select ${s.title}`,
        onchange: (e) => {
          if (e.target.checked) selected.add(s.id); else selected.delete(s.id);
          compareBtn.disabled = selected.size < 2 || selected.size > 4;
          compareBtn.textContent = selected.size ? `Compare selected (${selected.size})` : "Compare selected";
        },
      });
      box.checked = selected.has(s.id);
      return el("tr", {},
        el("td", {}, box),
        el("td", {},
          el("a", { class: "row-title", href: `order-tool.html?id=${s.id}`, text: s.title || s.commodityCode }),
          s.sample ? el("span", { class: "badge badge-info", style: "margin-left:8px", title: "Priced with sample market data", text: "Sample" }) : null,
          el("div", { class: "row-sub", text: `${s.commodityCode.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4")}${s.categoryId ? ` · Cat ${s.categoryId}` : ""}` })),
        el("td", {}, `${s.supplier || "—"} · ${s.origin}`, el("div", { class: "row-sub", text: s.incoterm })),
        el("td", { class: "num", text: fmt.tonnes(s.tonnage) }),
        el("td", { class: "num" }, el("strong", { text: fmt.perT(s.expectedPerT) }), el("div", { class: "row-sub", text: fmt.money(s.expectedTotal) })),
        el("td", {}, quotaBadge(s)),
        el("td", { text: fmt.date(s.importDate) }),
        el("td", {}, statusBadge(s.status, s.quoteValidUntil)),
        el("td", {}, el("span", { class: "small", text: fmt.dateTime(s.updatedAt) }), el("div", { class: "row-sub", text: s.createdBy })),
      );
    }));
    emptyEl.hidden = all.length > 0;
    if (all.length && !rows.length) {
      rowsEl.append(el("tr", {}, el("td", { colspan: "9", class: "empty", text: "No scenarios match these filters." })));
    }
  }

  async function load() {
    try {
      const data = await api("/api/scenarios");
      all = data.scenarios;
      const origins = [...new Set(all.map((s) => s.origin))].sort();
      originFilter.replaceChildren(el("option", { value: "", text: "All origins" }), ...origins.map((o) => el("option", { value: o, text: o })));
      renderKpis();
      render();
    } catch (error) {
      toast(`Could not load scenarios: ${error.message}`, true);
    }
  }

  document.getElementById("sample-btn").addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      const res = await api("/api/sample-data", { method: "POST" });
      toast(res.created ? `Loaded ${res.created} sample scenarios` : res.message);
      await load();
    } catch (error) {
      toast(`Could not load samples: ${error.message}`, true);
    } finally {
      event.target.disabled = false;
    }
  });

  [search, statusFilter, originFilter].forEach((input) => input.addEventListener("input", render));
  compareBtn.addEventListener("click", () => {
    window.location.href = `compare.html?ids=${[...selected].join(",")}`;
  });

  loadMe().then((me) => { if (!me.canEdit) document.getElementById("new-btn").hidden = true; });
  loadDataStatus(document.getElementById("data-status"));
  load();
})();
