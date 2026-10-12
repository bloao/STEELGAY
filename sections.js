// Suppliers and Products pages: simple roll-ups of saved scenarios.
(function () {
  "use strict";
  const { api, fmt, el, toast } = window.OrderTool;
  const section = document.currentScript.dataset.section;
  const rowsEl = document.getElementById("rows");
  const emptyEl = document.getElementById("empty");
  const countEl = document.getElementById("count");

  const uniq = (xs) => [...new Set(xs.filter(Boolean))];
  const minBy = (xs, f) => xs.reduce((best, x) => (f(x) < f(best) ? x : best), xs[0]);

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

  function renderSuppliers(all) {
    const groups = groupBy(all, (s) => s.supplier).sort((a, b) => a[0].localeCompare(b[0]));
    countEl.textContent = `${groups.length} supplier${groups.length === 1 ? "" : "s"}`;
    rowsEl.replaceChildren(...groups.map(([name, g]) => {
      const latest = g.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
      return el("tr", {},
        el("td", {}, el("strong", { text: name })),
        el("td", { text: uniq(g.map((s) => s.mill)).join(", ") || "—" }),
        el("td", { text: uniq(g.map((s) => s.origin)).join(", ") }),
        el("td", { text: uniq(g.map((s) => s.incoterm)).join(", ") }),
        el("td", { class: "num", text: g.length }),
        bestCell(g),
        el("td", {}, el("span", { class: "small", text: fmt.dateTime(latest.updatedAt) }), el("div", { class: "row-sub", text: latest.quoteValidUntil ? `valid to ${fmt.date(latest.quoteValidUntil)}` : "" })));
    }));
    return groups.length;
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

  api("/api/scenarios").then(({ scenarios }) => {
    const n = section === "suppliers" ? renderSuppliers(scenarios) : renderProducts(scenarios);
    emptyEl.hidden = n > 0;
  }).catch((error) => toast(`Could not load scenarios: ${error.message}`, true));
})();
