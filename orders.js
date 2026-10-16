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
  const openBulk = new Set();
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

    // lines saved together (one load from one supplier) show as a single bulk order
    const groups = new Map();
    for (const s of rows) if (s.packageId) { if (!groups.has(s.packageId)) groups.set(s.packageId, []); groups.get(s.packageId).push(s); }
    const out = [];
    const done = new Set();
    for (const s of rows) {
      if (!s.packageId || (groups.get(s.packageId) || []).length < 2) { out.push(lineRow(s, false)); continue; }
      if (done.has(s.packageId)) continue;
      done.add(s.packageId);
      const g = groups.get(s.packageId);
      const open = openBulk.has(s.packageId);
      const tonnes = g.reduce((n, x) => n + (x.tonnage || 0), 0);
      const value = g.reduce((n, x) => n + (x.plannedPerT !== null ? x.plannedPerT * x.tonnage : x.expectedTotal || 0), 0);
      const arrive = g.map((x) => x.importDate).filter(Boolean).sort().slice(-1)[0];
      out.push(el("tr", { class: `bulk-row${open ? " is-open" : ""}`, tabindex: "0", "aria-expanded": String(open),
        onclick: (e) => { if (e.target.closest("input,a")) return; if (open) openBulk.delete(s.packageId); else openBulk.add(s.packageId); render(); },
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (open) openBulk.delete(s.packageId); else openBulk.add(s.packageId); render(); } } },
        el("td", {}, el("span", { class: "bulk-caret", "aria-hidden": "true" })),
        el("td", {}, el("strong", { class: "row-title", text: `Bulk order · ${g.length} products` }), el("span", { class: "badge badge-info", style: "margin-left:8px", text: "One load" }),
          el("div", { class: "row-sub", text: g.map((x) => (x.title || "").replace(/ from .*$/, "")).join(" · ") })),
        el("td", {}, `${s.supplier || "—"} · ${s.origin}`, el("div", { class: "row-sub", text: s.incoterm })),
        el("td", { class: "num" }, el("strong", { text: fmt.tonnes(tonnes) })),
        el("td", { class: "num" }, el("strong", { text: fmt.perT(tonnes ? value / tonnes : null) }), el("div", { class: "row-sub", text: fmt.money(value) })),
        el("td", {}, quotaBadge(g.find((x) => x.quotaProbability) || s)),
        el("td", { text: fmt.date(arrive) }),
        el("td", {}, statusBadge(s.status, s.quoteValidUntil)),
        el("td", {}, el("span", { class: "small", text: fmt.dateTime(s.updatedAt) }), el("div", { class: "row-sub", text: s.createdBy }))));
      if (open) g.forEach((x) => out.push(lineRow(x, true)));
    }
    rowsEl.replaceChildren(...out);
    function lineRow(s, child) {
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
      return el("tr", { class: child ? "bulk-child" : "" },
        el("td", {}, box),
        el("td", {},
          el("a", { class: "row-title", href: `order.html?id=${s.id}`, text: s.title || s.commodityCode }),
          s.planned ? el("span", { class: `badge ${s.planRole === "alternative" ? "" : "badge-info"}`, style: "margin-left:8px", title: s.planRole === "alternative" ? "Runner-up from the order planner, to compare against the recommendation" : s.starter ? "The order planner's pick, drafted from your stock levels and supplier quotes" : "Saved from the order planner", text: s.planRole === "alternative" ? "Alternative" : s.starter ? "Recommended" : "Planned" }) : null,
          s.sample ? el("span", { class: "badge badge-warn", style: "margin-left:8px", title: "Priced with sample market data, not the live feeds", text: "Sample prices" }) : null,
          el("div", { class: "row-sub", text: `${s.commodityCode.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4")}${s.categoryId ? ` · Cat ${s.categoryId}` : ""}` })),
        el("td", {}, `${s.supplier || "—"} · ${s.origin}`, el("div", { class: "row-sub", text: s.incoterm })),
        el("td", { class: "num", text: fmt.tonnes(s.tonnage) }),
        s.plannedPerT !== null
          ? el("td", { class: "num", title: `All costs counted (finance, handling, quota-miss risk). Duty and freight alone: ${fmt.perT(s.expectedPerT)}` }, el("strong", { text: fmt.perT(s.plannedPerT) }), el("div", { class: "row-sub", text: fmt.money(s.plannedPerT * s.tonnage) }))
          : el("td", { class: "num" }, el("strong", { text: fmt.perT(s.expectedPerT) }), el("div", { class: "row-sub", text: fmt.money(s.expectedTotal) })),
        el("td", {}, quotaBadge(s)),
        el("td", { text: fmt.date(s.importDate) }),
        el("td", {}, statusBadge(s.status, s.quoteValidUntil)),
        el("td", {}, el("span", { class: "small", text: fmt.dateTime(s.updatedAt) }), el("div", { class: "row-sub", text: s.createdBy })),
      );
    }
    emptyEl.hidden = all.length > 0;
    if (all.length && !rows.length) {
      rowsEl.append(el("tr", {}, el("td", { colspan: "9", class: "empty", text: "No scenarios match these filters." })));
    }
  }

  async function loadNeeds() {
    try {
      const r = await api("/api/orders/needs");
      const need = r.products.filter((p) => ["critical", "reorder", "low"].includes(p.status));
      const box = document.getElementById("needs");
      if (!need.length) { box.replaceChildren(el("li", { class: "muted", text: "Nothing needs ordering right now. Every product is above its reorder point." })); return; }
      box.replaceChildren(...need.map((p, i) => el("li", { class: p.status === "low" ? "is-low" : "is-critical", style: `animation-delay:${i * 50}ms` },
        el("div", { class: "needs-head" }, el("strong", { text: p.name }), el("span", { class: `sig ${p.status === "low" ? "is-maybe" : "is-risk"}`, text: p.status === "low" ? "Order soon" : "Order now" })),
        el("p", { class: "needs-figs" }, el("span", {}, el("b", { text: `${Math.round(p.stockT)} t` }), " in stock"), el("span", {}, el("b", { text: p.coverMonths !== null ? `${p.coverMonths.toFixed(1)} mo` : "—" }), " cover"), p.stockOutDate ? el("span", {}, "out ", el("b", { text: fmt.date(p.stockOutDate) })) : null),
        el("a", { class: "btn btn-sm btn-primary", href: `plan.html?product=${p.id}`, text: p.suggestedOrderT ? `Plan ${p.suggestedOrderT} t` : "Plan an order" }))));
    } catch { document.getElementById("needs-card").hidden = true; }
  }
  loadNeeds();

  // ---- One load: everything that needs ordering packaged to meet the supplier's minimum
  let pkg = null, pkgPick = null;
  const t1 = (v) => `${Math.round(v * 10) / 10} t`;
  const COLORS = ["#2a78d6", "#4f9a8f", "#6250d6", "#c2862a", "#c4553a", "#5b7083"];
  function renderPackage() {
    const box = document.getElementById("pkg");
    if (!pkg || !pkg.options || !pkg.options.length) { box.hidden = true; return; }
    const opts = pkg.options.slice(0, 4);
    const o = opts.find((x) => x.supplierId === pkgPick) || opts[0];
    pkgPick = o.supplierId;
    const cap = o.moqMaxT ? o.moqMaxT * o.loads : Math.max(o.totalT, o.moqMinT || 0);
    const scale = Math.max(cap, o.totalT) || 1;
    const fig = (k, v) => el("div", { class: "pkg-fig" }, el("span", { text: k }), el("strong", { text: v }));
    const seg = el("div", { class: "pkg-bar", role: "img", "aria-label": `${t1(o.totalT)} on ${o.loads} load${o.loads === 1 ? "" : "s"}${o.moqMinT ? `, minimum ${o.moqMinT} t` : ""}` },
      ...o.items.map((it, i) => el("span", { class: `pkg-seg${it.role === "bring-forward" ? " is-fwd" : ""}`, style: `width:${(it.tonnes / scale) * 100}%;--c:${COLORS[i % COLORS.length]}`, title: `${it.name} · ${t1(it.tonnes)}` })),
      o.moqMinT ? el("i", { class: "pkg-min", style: `left:${Math.min(100, ((o.moqMaxT && o.loads > 1 ? (o.loads - 1) * o.moqMaxT + o.moqMinT : o.moqMinT) / scale) * 100)}%`, title: `Minimum ${o.moqMinT} t` }) : null,
      ...(o.moqMaxT && o.loads > 1 ? Array.from({ length: o.loads - 1 }, (_, i) => el("i", { class: "pkg-load", style: `left:${(((i + 1) * o.moqMaxT) / scale) * 100}%` })) : []));
    box.hidden = false;
    box.replaceChildren(
      el("div", { class: "pkg-head" },
        el("h3", { text: "One load" }),
        opts.length > 1 ? el("div", { class: "pkg-opts", role: "group", "aria-label": "Supplier" }, ...opts.map((x) => el("button", { type: "button", class: "pkg-opt", "aria-pressed": String(x.supplierId === o.supplierId), onclick: () => { pkgPick = x.supplierId; renderPackage(); } },
          el("b", { text: x.supplier }), el("span", { text: `£${x.scorePerT}/t · ${t1(x.totalT)}${x.origin && x.origin !== "UK" ? (x.ddp === "yes" ? " · DDP" : x.ddp === "no" ? " · no DDP" : "") : ""}` })))) : null),
      el("div", { class: "pkg-body" },
        el("div", { class: "pkg-figs" },
          fig("Load", t1(o.totalT)),
          fig(o.loads > 1 ? "Loads" : "Minimum", o.loads > 1 ? `${o.loads} × ${o.moqMaxT} t` : o.moqMinT ? `${o.moqMinT}${o.moqMaxT && o.moqMaxT !== o.moqMinT ? `–${o.moqMaxT}` : ""} t` : "None"),
          fig("Extra stock", o.extraT > 0 ? `+${t1(o.extraT)}` : "None"),
          fig("Order total", fmt.money(o.cost)),
          fig("Per tonne", `£${o.perT}`)),
        seg,
        el("ul", { class: "pkg-items" }, ...o.items.map((it, i) => el("li", { style: `--c:${COLORS[i % COLORS.length]}` },
          el("i", { class: it.role === "bring-forward" ? "is-fwd" : "" }), el("span", { text: it.name }),
          el("b", { text: it.role === "bring-forward" ? `+${t1(it.tonnes)}` : it.extraT > 0 ? `${t1(it.needT)} +${t1(it.extraT)}` : t1(it.tonnes) }),
          it.role === "bring-forward" ? el("small", { text: "brought forward" }) : null))),
        o.uncovered.length ? el("p", { class: "pkg-miss", text: `Not supplied by ${o.supplier}: ${o.uncovered.join(", ")}` }) : null,
        el("div", { class: "pkg-actions" },
          el("button", { type: "button", class: "btn btn-primary", id: "pkg-save", text: `Save ${o.items.length} orders as one load`, onclick: savePackage }))));
  }
  async function savePackage() {
    const o = pkg.options.find((x) => x.supplierId === pkgPick);
    const btn = document.getElementById("pkg-save");
    btn.disabled = true;
    try {
      const r = await api("/api/orders/package/save", { method: "POST", body: { supplierId: o.supplierId, items: o.items.map((it) => ({ productId: it.productId, tonnes: it.tonnes })) } });
      toast(`Saved ${r.ids.length} orders: one ${t1(r.packageT)} load from ${o.supplier}.`);
      load();
    } catch (error) { toast(error.message, true); btn.disabled = false; }
  }
  api("/api/orders/package").then((r) => { pkg = r; renderPackage(); }).catch(() => {});

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

  document.getElementById("starter-btn").addEventListener("click", async (event) => {
    event.target.disabled = true;
    try {
      const res = await api("/api/orders/starter", { method: "POST" });
      toast(res.created ? `Drafted ${res.created} order${res.created === 1 ? "" : "s"} from your products and suppliers` : res.message || "Nothing new to draft");
      await load();
    } catch (error) {
      toast(`Could not draft orders: ${error.message}`, true);
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
