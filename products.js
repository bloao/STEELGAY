(function () {
  "use strict";
  const { api, fmt, el, toast, loadMe } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  const form = $("view-form");
  // form.name / form.reset etc. are properties of the <form> itself — always
  // look fields up through form.elements.
  const field = (n) => form.elements.namedItem(n);
  const drawer = $("drawer");
  const categories = (window.STEEL_TRADE_MEASURE && window.STEEL_TRADE_MEASURE.categories) || [];

  let products = [];
  let quotes = new Map();
  let quota = null;
  let me = { canEdit: true };
  let mode = null; // "detail" | "form" | "import"
  let editing = null;
  let detailId = null;
  let dirty = false;
  let lastFocus = null;
  let previewTimer = null;
  let importResults = null;
  let highlightId = null;
  let serverErrors = {}; // errors from the last save, kept until that field is edited

  const FIELDS = ["name", "category", "spec", "commodityCode", "stockT", "stockAsOf", "monthlyUsageT", "costPerT", "leadTimeWeeks", "moqT", "safetyStockT", "targetCoverMonths", "targetBuyPrice", "notes"];
  const STATUS = {
    critical: ["Order now", "is-bad"],
    reorder: ["Order now", "is-bad"],
    low: ["Order soon", "is-warn"],
    ok: ["OK", ""],
    "no-usage": ["No usage", "is-muted"],
  };
  const needsOrder = (p) => ["critical", "reorder", "low"].includes(p.metrics.status);
  const fmtCode = (c) => String(c || "").replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4");
  const months = (m) => (m === null || m === undefined ? "—" : m >= 24 ? `${(m / 12).toFixed(1)} yrs` : `${m.toFixed(1)} mo`);
  const t = (v) => (Number.isFinite(v) ? `${v.toLocaleString("en-GB", { maximumFractionDigits: v < 10 ? 2 : 1 })} t` : "—");
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const statusDot = (status) => {
    const [label, cls] = STATUS[status] || [status, ""];
    return el("span", { class: `status-dot ${cls}`, text: label });
  };
  const categoryFor = (code) => (/^\d{10}$/.test(code) ? categories.find((c) => c.commodityPrefixes.some((p) => code.startsWith(p))) : null);

  // ---------------------------------------------------------------- list

  function coverCell(p) {
    const m = p.metrics;
    if (m.coverMonths === null) return el("td", { class: "muted", text: "—" });
    const target = Math.max(p.targetCoverMonths || 3, 1);
    const share = Math.min(m.coverMonths / (target * 1.5), 1);
    const cls = ["critical", "reorder"].includes(m.status) ? "is-bad" : m.status === "low" ? "is-warn" : "";
    return el("td", {},
      el("div", { class: "cover-bar" },
        el("div", { class: `bar ${cls}`, "aria-hidden": "true" }, el("div", { style: `width:${(share * 100).toFixed(1)}%` })),
        el("span", { text: months(m.coverMonths) })),
      el("div", { class: "row-sub", text: m.stockOutDate ? `runs out ${fmt.date(m.stockOutDate)}` : "" }));
  }

  function renderTable() {
    const q = $("q").value.trim().toLowerCase();
    const cat = $("f-category").value;
    const st = $("f-status").value;
    const list = products.filter((p) => {
      if (cat && p.category !== cat) return false;
      if (st === "order" && !needsOrder(p)) return false;
      if (st === "ok" && needsOrder(p)) return false;
      if (!q) return true;
      return [p.name, p.commodityCode, p.category, p.spec].some((v) => String(v || "").toLowerCase().includes(q));
    });
    const rows = [];
    let lastCat = null;
    for (const p of list) {
      if (p.category !== lastCat) {
        lastCat = p.category;
        const inCat = products.filter((x) => x.category === p.category);
        rows.push(el("tr", { class: "cat-row" }, el("td", { colspan: "6" }, p.category,
          el("span", { class: "small muted", style: "font-family:var(--font-sans);font-weight:500;margin-left:10px",
            text: `${inCat.length} · ${t(inCat.reduce((s, x) => s + x.metrics.stockNowT, 0))} · ${fmt.money(inCat.reduce((s, x) => s + x.metrics.stockValue, 0))}` }))));
      }
      const m = p.metrics;
      const row = el("tr", {
        class: `product-row${p.id === highlightId ? " is-new" : ""}`,
        tabindex: "0",
        "aria-label": `${p.name}, ${STATUS[m.status] ? STATUS[m.status][0] : m.status}. Open details`,
        onclick: () => openDetail(p.id),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(p.id); } },
      },
        el("td", {},
          el("div", { class: "p-name", text: p.name }),
          el("div", { class: "p-meta" },
            p.spec ? el("span", { text: p.spec }) : null,
            el("span", { text: fmtCode(p.commodityCode) }),
            p.steelCategory ? el("span", { class: "tag", title: p.steelCategory.name, text: `Cat ${p.steelCategory.id}` }) : el("span", { class: "tag", style: "background:var(--neutral-bg);color:var(--ink-soft)", text: "No quota" }))),
        el("td", { class: "num" }, el("strong", { text: t(m.stockNowT) }), el("div", { class: "row-sub", text: `${t(p.monthlyUsageT)}/mo` })),
        coverCell(p),
        el("td", { class: "num" }, el("span", { text: fmt.money(m.stockValue) }), el("div", { class: "row-sub", text: `${fmt.money(p.costPerT)}/t` })),
        el("td", {}, statusDot(m.status), m.suggestedOrderT > 0 ? el("div", { class: "row-sub", text: `order ${m.suggestedOrderT} t` }) : null),
        el("td", { class: "chev", "aria-hidden": "true" }));
      row.lastChild.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>';
      rows.push(row);
    }
    if (!list.length) {
      rows.push(el("tr", {}, el("td", { colspan: "6", class: "empty" },
        products.length ? "No products match these filters." : el("span", {}, "No products yet. ", me.canEdit ? el("button", { class: "btn btn-primary", type: "button", style: "margin-left:8px", text: "Add your first product", onclick: () => openForm(null) }) : null))));
    }
    $("rows").replaceChildren(...rows);
  }

  function renderSummary() {
    $("kpi-count").textContent = products.length;
    $("kpi-stock").textContent = t(products.reduce((s, p) => s + p.metrics.stockNowT, 0));
    $("kpi-value").textContent = fmt.money(products.reduce((s, p) => s + p.metrics.stockValue, 0));
    const urgent = products.filter(needsOrder).sort((a, b) => (a.metrics.stockOutDate || "9999").localeCompare(b.metrics.stockOutDate || "9999"));
    $("kpi-order").textContent = urgent.length;
    $("kpi-order").parentElement.classList.toggle("is-zero", urgent.length === 0);
    $("attention").hidden = urgent.length === 0;
    $("attention-list").replaceChildren(...urgent.map((p) => {
      const m = p.metrics;
      return el("li", {},
        el("div", { class: "who" }, el("strong", { text: p.name }), el("span", { text: m.reason })),
        el("div", { class: "when", text: m.latestOrderDate ? `order by ${fmt.date(m.latestOrderDate)}` : `runs out ${fmt.date(m.stockOutDate)}` }),
        el("div", { class: "qty", text: `${m.suggestedOrderT} t · ${fmt.money(m.suggestedOrderValue)}` }),
        el("a", { class: "btn", href: `order-tool.html?product=${p.id}`, text: "Price it" }));
    }));
    const cats = [...new Set(products.map((p) => p.category))].sort();
    const current = $("f-category").value;
    $("f-category").replaceChildren(el("option", { value: "", text: "All categories" }), ...cats.map((c) => el("option", { value: c, text: c })));
    $("f-category").value = cats.includes(current) ? current : "";
    $("category-list").replaceChildren(...cats.map((c) => el("option", { value: c })));
  }

  function renderQuota() {
    const cats = [...new Set(products.map((p) => p.steelCategory && p.steelCategory.id).filter(Boolean))];
    if (!quota || !cats.length) { $("quota-card").hidden = true; return; }
    $("quota-card").hidden = false;
    $("quota-src").textContent = `${quota.sources.tariff.lines ? "HMRC Trade Tariff" : "DBT daily dataset"} · ${quota.quarter.label} · ${fmt.time(quota.fetchedAt)}`;
    $("quota-groups").replaceChildren(...cats.map((id) => {
      const lines = quota.lines.filter((l) => l.categoryId === id);
      const names = products.filter((p) => p.steelCategory && p.steelCategory.id === id).map((p) => p.name);
      return el("div", { class: "quota-group" },
        el("h3", { text: `Category ${id} · ${lines[0] ? lines[0].categoryName : ""}` }),
        el("p", { class: "small muted", style: "margin:0 0 8px", text: names.join(", ") }),
        ...lines.map((l) => el("div", { class: "line" },
          el("span", {}, el("strong", { text: l.residual ? "Other origins" : l.origin }), el("div", { class: "row-sub", text: l.orderNumber })),
          el("span", { style: "text-align:right" },
            el("strong", { text: l.found ? `${fmt.tonnesRound(l.balanceT)} left` : "—" }),
            el("div", {}, quotaRisk(l))))));
    }));
  }

  function quotaRisk(l) {
    const map = { exhausted: ["Used up", "is-bad"], critical: ["Runs out this quarter", "is-bad"], watch: ["Under 30% left", "is-warn"], open: ["Open", ""], blocked: ["Blocked", "is-bad"], unknown: ["No data", "is-muted"] };
    const [label, cls] = map[l.risk] || [l.risk, ""];
    return el("span", { class: `status-dot ${cls}`, style: "font-size:12px", text: label });
  }

  // ---------------------------------------------------------------- drawer

  function showDrawer(newMode, title, eyebrow) {
    mode = newMode;
    if (drawer.hidden) lastFocus = document.activeElement;
    $("drawer-title").textContent = title;
    $("drawer-eyebrow").textContent = eyebrow || "";
    $("view-detail").hidden = newMode !== "detail";
    form.hidden = newMode !== "form";
    $("view-import").hidden = newMode !== "import";
    drawer.hidden = false;
    $("backdrop").hidden = false;
    document.body.classList.add("drawer-open");
  }

  function closeDrawer(force) {
    if (!force && mode === "form" && dirty) {
      const btn = $("drawer-foot").querySelector("[data-cancel]");
      if (btn && !btn.dataset.confirm) {
        btn.dataset.confirm = "1";
        btn.textContent = "Discard changes?";
        btn.classList.add("btn-danger");
        btn.focus();
        return;
      }
    }
    drawer.hidden = true;
    $("backdrop").hidden = true;
    document.body.classList.remove("drawer-open");
    mode = null;
    editing = null;
    dirty = false;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  function footer(...buttons) { $("drawer-foot").replaceChildren(...buttons); }

  function kv(rows) {
    const dl = el("dl", { class: "kv" });
    for (const [label, value, sub] of rows) {
      dl.append(el("dt", { text: label }), el("dd", {}, value === null || value === undefined || value === "" ? "—" : value, sub ? el("small", { text: sub }) : null));
    }
    return dl;
  }

  function openDetail(id) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    detailId = id;
    const m = p.metrics;
    const best = quotes.get(p.commodityCode);
    const lines = quota && p.steelCategory ? quota.lines.filter((l) => l.categoryId === p.steelCategory.id) : [];
    const [label] = STATUS[m.status] || [m.status];
    showDrawer("detail", p.name, `${p.category}${p.spec ? ` · ${p.spec}` : ""}`);
    $("view-detail").replaceChildren(
      el("div", {}, statusDot(m.status), el("span", { class: "small muted", style: "margin-left:8px", text: m.reason })),
      el("div", { class: "kv-head" },
        el("div", {}, el("span", { text: m.estimated ? "Stock now (est.)" : "Stock" }), el("strong", { text: t(m.stockNowT) })),
        el("div", {}, el("span", { text: "Cover" }), el("strong", { text: months(m.coverMonths) })),
        el("div", {}, el("span", { text: "Runs out" }), el("strong", { text: m.stockOutDate ? fmt.date(m.stockOutDate) : "—" })),
        el("div", {}, el("span", { text: "Suggested order" }), el("strong", { text: m.suggestedOrderT ? `${m.suggestedOrderT} t` : "None" }))),
      el("section", { class: "detail-section" }, el("h3", { text: "Product" }), kv([
        ["Category", p.category],
        ["Specification", p.spec],
        ["Commodity code", fmtCode(p.commodityCode)],
        ["Steel quota category", p.steelCategory ? `Category ${p.steelCategory.id}` : "Not covered", p.steelCategory ? p.steelCategory.name : "No steel quota — ordinary duty only"],
      ])),
      el("section", { class: "detail-section" }, el("h3", { text: "Stock & demand" }), kv([
        ["Stock recorded", t(p.stockT), p.stockAsOf ? `as of ${fmt.date(p.stockAsOf)}` : null],
        ["Estimated stock today", t(m.stockNowT), m.estimated ? "recorded stock less usage since then" : null],
        ["Monthly usage", `${t(p.monthlyUsageT)}/month`],
        ["Projected stock-out", m.stockOutDate ? fmt.date(m.stockOutDate) : null],
      ])),
      el("section", { class: "detail-section" }, el("h3", { text: "Buying rules" }), kv([
        ["Lead time", p.leadTimeWeeks ? `${p.leadTimeWeeks} weeks` : null, p.leadTimeWeeks ? null : "Add one to get an order-by date"],
        ["Safety stock", p.safetyStockT ? t(p.safetyStockT) : null],
        ["Minimum order (MOQ)", p.moqT ? t(p.moqT) : null],
        ["Cover after delivery", `${p.targetCoverMonths || 3} months`],
        ["Reorder point", m.reorderPointT !== null ? t(m.reorderPointT) : null],
        ["Order by", m.latestOrderDate ? fmt.date(m.latestOrderDate) : null],
        ["Suggested order", m.suggestedOrderT ? `${m.suggestedOrderT} t` : "None needed", m.moqApplied ? "rounded up to the MOQ" : m.suggestedOrderT ? `≈ ${fmt.money(m.suggestedOrderValue)} at ${p.targetBuyPrice ? "target" : "cost"} price` : null],
      ])),
      el("section", { class: "detail-section" }, el("h3", { text: "Commercials" }), kv([
        ["Stock cost price", `${fmt.money(p.costPerT, true)}/t`],
        ["Stock value", fmt.money(m.stockValue)],
        ["Target buy price", p.targetBuyPrice ? `${fmt.money(p.targetBuyPrice, true)}/t` : null],
        ["Best saved quote", best ? el("a", { href: `order-tool.html?id=${best.id}`, text: `${fmt.perT(best.expectedPerT)}` }) : null,
          best ? `${best.supplier || best.title} · ${best.expectedPerT > (p.targetBuyPrice || p.costPerT) ? "above" : "below"} ${p.targetBuyPrice ? "target" : "cost"}` : "No saved quotes for this code"],
      ])),
      lines.length ? el("section", { class: "detail-section" }, el("h3", { text: `Quota · Category ${p.steelCategory.id}` }), kv(lines.map((l) => [
        l.residual ? "Other origins" : l.origin, l.found ? `${fmt.tonnesRound(l.balanceT)} left` : "—", `${l.orderNumber} · ${({ exhausted: "used up", critical: "runs out this quarter", watch: "under 30% left", open: "open" })[l.risk] || l.risk}`]))) : null,
      p.notes ? el("section", { class: "detail-section" }, el("h3", { text: "Notes" }), el("p", { style: "margin:0;white-space:pre-wrap", text: p.notes })) : null,
      el("section", { class: "detail-section" }, el("h3", { text: "History" }),
        el("ul", { class: "history" }, ...[...(p.activity || [])].reverse().map((a) =>
          el("li", {}, el("strong", { text: a.by }), ` ${a.action}`, a.detail ? ` — ${a.detail}` : "", el("time", { datetime: a.at, text: fmt.dateTime(a.at) }))))),
    );
    const archiveBtn = el("button", { class: "btn btn-danger", type: "button", text: "Archive", onclick: () => archive(p, archiveBtn) });
    footer(
      me.canEdit ? archiveBtn : null,
      el("span", { class: "spacer" }),
      me.canEdit ? el("button", { class: "btn", type: "button", text: "Edit", onclick: () => openForm(p) }) : null,
      el("a", { class: "btn btn-primary", href: `order-tool.html?product=${p.id}`, text: m.suggestedOrderT ? `Price ${m.suggestedOrderT} t` : "Price an order" }));
    $("drawer-close").focus();
  }

  async function archive(p, btn) {
    if (!btn.dataset.confirm) {
      btn.dataset.confirm = "1";
      btn.textContent = `Archive ${p.name}?`;
      return;
    }
    try {
      await api(`/api/products/${p.id}/archive`, { method: "POST" });
      closeDrawer(true);
      toast(`${p.name} archived`);
      await load();
    } catch (error) { toast(error.message, true); }
  }

  // ---------------------------------------------------------------- form

  let codesLoaded = false;
  function loadCodeList() {
    if (codesLoaded || !window.STEEL_COMMODITIES) return;
    codesLoaded = true;
    const frag = document.createDocumentFragment();
    for (const c of window.STEEL_COMMODITIES.commodities) {
      frag.append(el("option", { value: c.code, label: `${c.description} — ${c.headingDescription}`.slice(0, 120) }));
    }
    $("code-list").replaceChildren(frag);
  }

  function codeHint() {
    let code = field("commodityCode").value.replace(/[\s.]/g, "");
    if (/^\d{8}$/.test(code)) code += "00";
    const hint = $("code-hint");
    const known = window.STEEL_COMMODITIES && window.STEEL_COMMODITIES.commodities.find((c) => c.code === code);
    const cat = categoryFor(code);
    if (!field("commodityCode").value.trim()) {
      hint.textContent = "10-digit UK tariff code — sets the steel quota category.";
      hint.classList.remove("is-match");
    } else if (/^\d{10}$/.test(code)) {
      hint.textContent = `${known ? `${known.description} · ` : ""}${cat ? `Steel quota Category ${cat.id} — ${cat.name}` : "Not in a steel quota category (ordinary duty only)"}`;
      hint.classList.toggle("is-match", Boolean(cat));
    } else {
      hint.textContent = "Keep typing — codes are 8 or 10 digits.";
      hint.classList.remove("is-match");
    }
  }

  function readForm() {
    const body = {};
    for (const f of FIELDS) body[f] = field(f).value;
    return body;
  }

  function showErrors(errors = {}, onlyTouched) {
    form.querySelectorAll("[data-field]").forEach((f) => {
      const key = f.dataset.field;
      const input = field(key);
      const msg = errors[key];
      const show = msg && (!onlyTouched || (input && input.dataset.touched));
      f.classList.toggle("has-error", Boolean(show));
      const slot = f.querySelector(".error");
      if (slot) slot.textContent = show ? msg : "";
      if (input) input.setAttribute("aria-invalid", show ? "true" : "false");
    });
  }

  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(runPreview, 250);
  }

  async function runPreview() {
    try {
      const res = await api("/api/products/preview", { method: "POST", body: readForm() });
      showErrors({ ...res.errors, ...serverErrors }, true);
      const m = res.metrics;
      $("pv-cover").textContent = m ? months(m.coverMonths) : "—";
      $("pv-out").textContent = m && m.stockOutDate ? fmt.date(m.stockOutDate) : "—";
      $("pv-status").replaceChildren(m ? statusDot(m.status) : "—");
      $("pv-order").textContent = m ? (m.suggestedOrderT ? `${m.suggestedOrderT} t` : "None") : "—";
      $("pv-note").textContent = m
        ? [m.reason, m.latestOrderDate ? `Order by ${fmt.date(m.latestOrderDate)}.` : null, m.moqApplied ? "Rounded up to the MOQ." : null].filter(Boolean).join(" · ")
        : "Fill in stock, usage and cost to see cover and reorder timing.";
    } catch { /* preview is best-effort */ }
  }

  function openForm(p) {
    editing = p || null;
    dirty = false;
    serverErrors = {};
    loadCodeList();
    showDrawer("form", p ? `Edit ${p.name}` : "Add product", p ? p.category : "New product");
    form.reset();
    form.querySelectorAll("input, textarea").forEach((i) => { delete i.dataset.touched; });
    const values = p || { category: $("f-category").value || (products[0] ? products[0].category : ""), stockAsOf: todayIso(), targetCoverMonths: 3 };
    for (const f of FIELDS) {
      let v = values[f];
      if (f === "safetyStockT" && !v) v = "";
      field(f).value = v === null || v === undefined ? "" : v;
    }
    field("stockAsOf").max = todayIso();
    showErrors({});
    codeHint();
    runPreview();
    const cancel = el("button", { class: "btn", type: "button", "data-cancel": "", text: "Cancel", onclick: () => closeDrawer() });
    const save = el("button", { class: "btn btn-primary", type: "submit", form: "view-form", id: "form-save", text: p ? "Save changes" : "Add product" });
    footer(el("span", { class: "spacer" }), cancel, save);
    setTimeout(() => field("name").focus(), 30);
  }

  async function submitForm(event) {
    event.preventDefault();
    form.querySelectorAll("input, textarea").forEach((i) => { i.dataset.touched = "1"; });
    const body = readForm();
    if (editing && body.stockT !== String(editing.stockT) && body.stockAsOf === editing.stockAsOf) body.stockAsOf = todayIso();
    const btn = $("form-save");
    btn.disabled = true;
    try {
      const saved = editing
        ? await api(`/api/products/${editing.id}`, { method: "PUT", body })
        : await api("/api/products", { method: "POST", body });
      highlightId = saved.id;
      toast(editing ? `${saved.name} updated` : `${saved.name} added`);
      closeDrawer(true);
      await load();
      setTimeout(() => { highlightId = null; }, 2500);
    } catch (error) {
      const errors = (error.data && error.data.errors) || {};
      serverErrors = errors;
      clearTimeout(previewTimer);
      showErrors(errors);
      const first = form.querySelector(".has-error input, .has-error textarea");
      if (first) first.focus();
      toast(Object.keys(errors).length ? "Check the highlighted fields" : error.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- import

  function openImport() {
    importResults = null;
    showDrawer("import", "Import products", "Paste from a spreadsheet");
    $("import-step1").hidden = false;
    $("import-step2").hidden = true;
    footer(el("span", { class: "spacer" }),
      el("button", { class: "btn", type: "button", text: "Cancel", onclick: () => closeDrawer(true) }),
      el("button", { class: "btn btn-primary", type: "button", text: "Check rows", onclick: checkImport }));
    setTimeout(() => $("import-text").focus(), 30);
  }

  async function checkImport() {
    const text = $("import-text").value;
    try {
      const res = await api("/api/products/import", { method: "POST", body: { text } });
      importResults = res.results;
      const ok = res.results.filter((r) => r.valid);
      const creates = ok.filter((r) => r.action === "create").length;
      const updates = ok.filter((r) => r.action === "update").length;
      const bad = res.results.length - ok.length;
      $("import-summary").textContent = `${res.results.length} rows found · ${creates} new · ${updates} update${updates === 1 ? "" : "s"}${bad ? ` · ${bad} with problems (skipped)` : ""}${res.unmatched.length ? ` · ignored columns: ${res.unmatched.join(", ")}` : ""}`;
      $("import-rows").replaceChildren(...res.results.map((r) => {
        const p = r.product;
        const errs = Object.values(r.errors);
        return el("tr", { class: r.valid ? "" : "row-error" },
          el("td", {}, r.valid ? el("span", { class: `status-dot ${r.action === "update" ? "is-warn" : ""}`, text: r.action === "update" ? "Update" : "New" }) : el("span", { class: "status-dot is-bad", text: "Skip" })),
          el("td", {}, p.name || "—", errs.length ? el("div", { class: "err", text: errs.join(" ") }) : null),
          el("td", { text: p.category }),
          el("td", { text: fmtCode(p.commodityCode) }),
          el("td", { class: "num", text: t(p.stockT) }),
          el("td", { class: "num", text: t(p.monthlyUsageT) }),
          el("td", { class: "num", text: p.costPerT !== null ? fmt.money(p.costPerT) : "—" }));
      }));
      $("import-step1").hidden = true;
      $("import-step2").hidden = false;
      footer(
        el("button", { class: "btn", type: "button", text: "Back", onclick: () => { $("import-step1").hidden = false; $("import-step2").hidden = true; openImportFooter(); } }),
        el("span", { class: "spacer" }),
        el("button", { class: "btn btn-primary", type: "button", disabled: ok.length ? null : true, text: ok.length ? `Import ${ok.length} product${ok.length === 1 ? "" : "s"}` : "Nothing to import", onclick: commitImport }));
    } catch (error) {
      toast((error.data && error.data.error) || error.message, true);
    }
  }

  function openImportFooter() {
    footer(el("span", { class: "spacer" }),
      el("button", { class: "btn", type: "button", text: "Cancel", onclick: () => closeDrawer(true) }),
      el("button", { class: "btn btn-primary", type: "button", text: "Check rows", onclick: checkImport }));
  }

  async function commitImport(event) {
    event.target.disabled = true;
    try {
      const res = await api("/api/products/import", { method: "POST", body: { text: $("import-text").value, commit: true } });
      closeDrawer(true);
      toast(`Imported: ${res.created} added, ${res.updated} updated${res.skipped ? `, ${res.skipped} skipped` : ""}`);
      $("import-text").value = "";
      await load();
    } catch (error) {
      toast((error.data && error.data.error) || error.message, true);
      event.target.disabled = false;
    }
  }

  // ---------------------------------------------------------------- data

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
      renderSummary();
      renderTable();
      renderQuota();
      if (mode === "detail" && detailId) openDetail(detailId);
    } catch (error) {
      $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "6", class: "empty", text: `Could not load products: ${error.message}` })));
    }
  }

  async function loadQuota() {
    try {
      quota = await api("/api/steel-quotas/live");
      renderQuota();
    } catch { /* optional */ }
  }

  // ---------------------------------------------------------------- events

  form.addEventListener("submit", submitForm);
  form.addEventListener("input", (e) => {
    dirty = true;
    if (e.target.name) { e.target.dataset.touched = "1"; delete serverErrors[e.target.name]; }
    if (e.target.name === "commodityCode") codeHint();
    const cancel = $("drawer-foot").querySelector("[data-cancel]");
    if (cancel && cancel.dataset.confirm) { delete cancel.dataset.confirm; cancel.textContent = "Cancel"; cancel.classList.remove("btn-danger"); }
    schedulePreview();
  });
  form.addEventListener("focusin", () => loadCodeList(), { once: true });
  $("add-btn").addEventListener("click", () => openForm(null));
  $("import-btn").addEventListener("click", openImport);
  $("drawer-close").addEventListener("click", () => closeDrawer());
  $("backdrop").addEventListener("click", () => closeDrawer());
  document.addEventListener("keydown", (e) => {
    if (drawer.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeDrawer(); }
    if (e.key === "Tab") { // keep focus inside the panel
      const items = [...drawer.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex='0']")].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  ["q", "f-category", "f-status"].forEach((id) => $(id).addEventListener("input", renderTable));

  loadMe().then((m) => {
    me = m;
    if (!me.canEdit) { $("add-btn").hidden = true; $("import-btn").hidden = true; }
  });
  load().then(loadQuota);
})();
