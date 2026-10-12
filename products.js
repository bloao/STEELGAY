(function () {
  "use strict";
  const { api, fmt, el, toast, loadMe } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  const form = $("product-form");
  const categories = (window.STEEL_TRADE_MEASURE && window.STEEL_TRADE_MEASURE.categories) || [];
  let products = [];
  let quotes = new Map();
  let quota = null;
  let editing = null;
  let me = { canEdit: true };

  const STATUS = {
    critical: ["Order now", "badge-bad"],
    reorder: ["Order now", "badge-bad"],
    low: ["Order soon", "badge-warn"],
    ok: ["OK", "badge-good"],
    "no-usage": ["No usage", ""],
  };
  const needsOrder = (p) => ["critical", "reorder", "low"].includes(p.metrics.status);
  const fmtCode = (c) => c.replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4");
  const months = (m) => (m === null ? "—" : m >= 12 ? `${(m / 12).toFixed(1)} yrs` : `${m.toFixed(1)} mo`);

  function coverCell(p) {
    const m = p.metrics;
    if (m.coverMonths === null) return el("td", { class: "muted", text: "—" });
    const target = Math.max(p.targetCoverMonths || 3, 1);
    const share = Math.min(m.coverMonths / (target * 1.5), 1);
    const cls = m.status === "critical" || m.status === "reorder" ? "is-bad" : m.status === "low" ? "is-warn" : "";
    return el("td", {},
      el("div", { class: "cover-bar" },
        el("div", { class: `bar ${cls}`, role: "img", "aria-label": `${m.coverMonths.toFixed(1)} months of cover` },
          el("div", { style: `width:${(share * 100).toFixed(1)}%` })),
        el("span", { text: months(m.coverMonths) })),
      m.reorderPointT !== null ? el("div", { class: "row-sub", text: `Reorder at ${fmt.tonnesRound(m.reorderPointT)}` }) : null);
  }

  function quoteCell(p) {
    const q = quotes.get(p.commodityCode);
    if (!q) return el("td", { class: "num muted", text: "—" });
    const diff = q.expectedPerT - p.costPerT;
    return el("td", { class: "num" },
      el("a", { href: `order-tool.html?id=${q.id}`, style: "font-weight:600", text: fmt.perT(q.expectedPerT) }),
      el("div", { class: "row-sub", style: `color:${diff > 0 ? "var(--bad-ink)" : "var(--good-ink)"}`, text: `${diff > 0 ? "+" : "−"}${fmt.money(Math.abs(diff))}/t vs cost` }));
  }

  function render() {
    const q = $("q").value.trim().toLowerCase();
    const st = $("f-status").value;
    const list = products.filter((p) => {
      if (st === "order" && !needsOrder(p)) return false;
      if (!q) return true;
      return [p.name, p.commodityCode, p.category].some((v) => String(v).toLowerCase().includes(q));
    });
    const rows = [];
    let lastCat = null;
    for (const p of list) {
      if (p.category !== lastCat) {
        lastCat = p.category;
        const inCat = products.filter((x) => x.category === p.category);
        rows.push(el("tr", { class: "cat-row" }, el("td", { colspan: "11" },
          `${p.category}`, el("span", { class: "small muted", style: "font-family:var(--font-sans);font-weight:500;margin-left:10px",
            text: `${inCat.length} products · ${fmt.tonnesRound(inCat.reduce((t, x) => t + x.stockT, 0))} · ${fmt.money(inCat.reduce((t, x) => t + x.metrics.stockValue, 0))}` }))));
      }
      const m = p.metrics;
      const [label, cls] = STATUS[m.status] || [m.status, ""];
      const order = m.suggestedOrderT > 0
        ? el("a", { class: "btn btn-primary", href: `order-tool.html?product=${p.id}`, text: `Price ${m.suggestedOrderT} t` })
        : el("a", { class: "btn", href: `order-tool.html?product=${p.id}`, text: "Price an order" });
      rows.push(el("tr", {},
        el("td", {}, el("strong", { text: p.name }), p.notes ? el("div", { class: "row-sub", text: p.notes }) : null),
        el("td", {}, el("span", { style: "font-variant-numeric:tabular-nums", text: fmtCode(p.commodityCode) }),
          el("div", {}, p.steelCategory
            ? el("span", { class: "badge badge-info", title: p.steelCategory.name, text: `Steel cat ${p.steelCategory.id}` })
            : el("span", { class: "badge", text: "No steel quota" }))),
        el("td", { class: "num" }, el("strong", { text: fmt.tonnes(p.stockT) })),
        el("td", { class: "num", text: fmt.tonnes(p.monthlyUsageT) }),
        coverCell(p),
        el("td", {}, m.stockOutDate ? el("span", { text: fmt.date(m.stockOutDate) }) : "—",
          m.latestOrderDate ? el("div", { class: "row-sub", text: `order by ${fmt.date(m.latestOrderDate)}` }) : null),
        el("td", { class: "num", text: fmt.money(p.costPerT) }),
        el("td", { class: "num", text: fmt.money(m.stockValue) }),
        el("td", {}, el("span", { class: `badge ${cls}`, title: m.reason, text: label }), m.reason && m.status !== "ok" ? el("div", { class: "row-sub", text: m.reason }) : null),
        quoteCell(p),
        el("td", {}, el("div", { class: "row-actions" },
          order,
          me.canEdit ? el("button", { class: "btn", type: "button", text: "Edit", "aria-label": `Edit ${p.name}`, onclick: () => openForm(p) }) : null))));
    }
    if (!list.length) rows.push(el("tr", {}, el("td", { colspan: "11", class: "empty", text: products.length ? "No products match." : "No products yet — add your first one." })));
    $("rows").replaceChildren(...rows);
  }

  function renderKpis() {
    $("kpi-count").textContent = products.length;
    $("kpi-value").textContent = fmt.money(products.reduce((t, p) => t + p.metrics.stockValue, 0));
    $("kpi-order").textContent = products.filter(needsOrder).length;
    const first = products.filter((p) => p.metrics.stockOutDate).sort((a, b) => a.metrics.stockOutDate.localeCompare(b.metrics.stockOutDate))[0];
    $("kpi-first").textContent = first ? `${fmt.date(first.metrics.stockOutDate)}` : "—";
    $("kpi-first").title = first ? first.name : "";
    $("category-list").replaceChildren(...[...new Set(products.map((p) => p.category))].map((c) => el("option", { value: c })));
  }

  function renderQuota() {
    const cats = [...new Set(products.map((p) => p.steelCategory && p.steelCategory.id).filter(Boolean))];
    if (!quota || !cats.length) { $("quota-card").hidden = true; return; }
    $("quota-card").hidden = false;
    $("quota-src").textContent = `${quota.sources.tariff.lines ? "HMRC Trade Tariff" : "DBT daily dataset"} · ${quota.quarter.label} · ${fmt.time(quota.fetchedAt)}`;
    const RISK = { exhausted: ["Used up", "badge-bad"], critical: ["Runs out this quarter", "badge-bad"], watch: ["Under 30% left", "badge-warn"], open: ["Open", "badge-good"], blocked: ["Blocked", "badge-bad"], unknown: ["No data", ""] };
    $("quota-groups").replaceChildren(...cats.map((id) => {
      const lines = quota.lines.filter((l) => l.categoryId === id);
      const names = products.filter((p) => p.steelCategory && p.steelCategory.id === id).map((p) => p.name);
      return el("div", { class: "quota-group" },
        el("h3", { text: `Category ${id} · ${lines[0] ? lines[0].categoryName : ""}` }),
        el("p", { class: "small muted", style: "margin:0 0 8px", text: names.join(", ") }),
        ...lines.map((l) => {
          const [label, cls] = RISK[l.risk] || [l.risk, ""];
          return el("div", { class: "line" },
            el("span", {}, el("strong", { text: l.residual ? "Residual (all other origins)" : l.origin }), el("div", { class: "row-sub", text: l.orderNumber })),
            el("span", { style: "text-align:right" },
              el("strong", { text: l.found ? `${fmt.tonnesRound(l.balanceT)} left` : "—" }),
              el("div", {}, el("span", { class: `badge ${cls}`, text: label }))));
        }));
    }));
  }

  // ---------------------------------------------------------- form

  function showErrors(errors = {}) {
    form.querySelectorAll("[data-field]").forEach((f) => {
      const msg = errors[f.dataset.field];
      f.classList.toggle("has-error", Boolean(msg));
      const slot = f.querySelector(".error");
      if (slot) slot.textContent = msg || "";
    });
  }

  function codeHint() {
    let code = form.commodityCode.value.replace(/\s+/g, "");
    if (code.length === 8) code += "00";
    const cat = /^\d{10}$/.test(code) ? categories.find((c) => c.commodityPrefixes.some((p) => code.startsWith(p))) : null;
    $("code-hint").textContent = !code ? "" : cat ? `Steel measure Category ${cat.id} · ${cat.name}` : /^\d{10}$/.test(code) ? "Not in a steel-measure category" : "";
    $("code-hint").classList.toggle("is-match", Boolean(cat));
  }

  function openForm(p) {
    editing = p || null;
    $("form-title").textContent = p ? `Edit ${p.name}` : "Add product";
    $("form-archive").hidden = !p;
    $("form-archive").dataset.confirm = "";
    $("form-archive").textContent = "Archive product";
    form.reset();
    const values = p || { category: products[0] ? products[0].category : "", targetCoverMonths: 3 };
    for (const name of ["name", "category", "commodityCode", "stockT", "monthlyUsageT", "costPerT", "leadTimeWeeks", "safetyStockT", "targetCoverMonths", "targetBuyPrice", "notes"]) {
      const v = values[name];
      form[name].value = v === null || v === undefined ? "" : v;
    }
    if (p && !p.safetyStockT) form.safetyStockT.value = "";
    showErrors({});
    codeHint();
    $("form-card").hidden = false;
    $("form-card").scrollIntoView({ behavior: "smooth", block: "start" });
    form.name.focus({ preventScroll: true });
  }

  function closeForm() {
    $("form-card").hidden = true;
    editing = null;
  }

  async function save(event) {
    event.preventDefault();
    const body = Object.fromEntries(new FormData(form).entries());
    $("form-save").disabled = true;
    try {
      if (editing) await api(`/api/products/${editing.id}`, { method: "PUT", body });
      else await api("/api/products", { method: "POST", body });
      toast(editing ? "Product updated" : "Product added");
      closeForm();
      await load();
    } catch (error) {
      showErrors((error.data && error.data.errors) || {});
      toast(error.message, true);
    } finally {
      $("form-save").disabled = false;
    }
  }

  async function archive() {
    const btn = $("form-archive");
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = "1";
      btn.textContent = "Click again to archive";
      return;
    }
    try {
      await api(`/api/products/${editing.id}/archive`, { method: "POST" });
      toast("Product archived");
      closeForm();
      await load();
    } catch (error) { toast(error.message, true); }
  }

  // ---------------------------------------------------------- data

  async function load() {
    try {
      const [{ products: list }, scen] = await Promise.all([
        api("/api/products"),
        api("/api/scenarios").catch(() => ({ scenarios: [] })),
      ]);
      products = list.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, "en", { numeric: true }));
      quotes = new Map();
      for (const s of scen.scenarios) {
        if (!Number.isFinite(s.expectedPerT) || ["archived", "rejected"].includes(s.status)) continue;
        const best = quotes.get(s.commodityCode);
        if (!best || s.expectedPerT < best.expectedPerT) quotes.set(s.commodityCode, s);
      }
      renderKpis();
      render();
    } catch (error) {
      $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "11", class: "empty", text: `Could not load products: ${error.message}` })));
    }
  }

  async function loadQuota() {
    try {
      quota = await api("/api/steel-quotas/live");
      renderQuota();
    } catch { /* optional panel */ }
  }

  form.addEventListener("submit", save);
  form.commodityCode.addEventListener("input", codeHint);
  $("add-btn").addEventListener("click", () => openForm(null));
  $("form-cancel").addEventListener("click", closeForm);
  $("form-archive").addEventListener("click", archive);
  ["q", "f-status"].forEach((id) => $(id).addEventListener("input", render));

  loadMe().then((m) => { me = m; if (!me.canEdit) $("add-btn").hidden = true; });
  load().then(loadQuota);
})();
