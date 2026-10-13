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
  let serverErrors = {};
  let allScenarios = [];
  let profileTab = "overview";
  let auditFilter = "all";
  const SIZE_KEY = "agx-profile-size";
  let large = false;
  try { large = localStorage.getItem(SIZE_KEY) === "large"; } catch { /* storage unavailable */ } // errors from the last save, kept until that field is edited

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

    const urgent = products.filter(needsOrder).sort((a, b) => (a.metrics.stockOutDate || "9999").localeCompare(b.metrics.stockOutDate || "9999"));
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
    $("profile-tabs").hidden = newMode !== "detail";
    drawer.classList.toggle("is-large", large);
    syncSizeButton();
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

  function syncSizeButton() {
    const btn = $("drawer-size");
    btn.setAttribute("aria-label", large ? "Switch to small view" : "Switch to large view");
    btn.title = large ? "Small view" : "Large view";
  }

  function setSize(toLarge) {
    large = toLarge;
    try { localStorage.setItem(SIZE_KEY, large ? "large" : "small"); } catch { /* ignore */ }
    drawer.classList.toggle("is-large", large);
    syncSizeButton();
  }

  const fmtVal = (field, v) => {
    if (v === null || v === undefined || v === "") return "—";
    if (["stockT", "monthlyUsageT", "moqT", "safetyStockT"].includes(field)) return t(Number(v));
    if (["costPerT", "targetBuyPrice"].includes(field)) return `${fmt.money(Number(v), true)}/t`;
    if (field === "stockAsOf") return fmt.date(v);
    if (field === "commodityCode") return fmtCode(v);
    if (field === "leadTimeWeeks") return `${v} weeks`;
    if (field === "targetCoverMonths") return `${v} months`;
    return String(v);
  };

  function productQuotes(p) {
    return allScenarios.filter((sc) => sc.commodityCode === p.commodityCode && sc.status !== "archived");
  }

  function overviewPanel(p) {
    const m = p.metrics;
    const best = quotes.get(p.commodityCode);
    return el("div", { class: "profile-panel profile-overview" },
      el("div", { class: "span-all" }, statusDot(m.status), el("span", { class: "small muted", style: "margin-left:8px", text: m.reason })),
      el("div", { class: "kv-head span-all" },
        el("div", {}, el("span", { text: m.estimated ? "Stock now (est.)" : "Stock" }), el("strong", { text: t(m.stockNowT) })),
        el("div", {}, el("span", { text: "Cover" }), el("strong", { text: months(m.coverMonths) })),
        el("div", {}, el("span", { text: "Runs out" }), el("strong", { text: m.stockOutDate ? fmt.date(m.stockOutDate) : "—" })),
        el("div", {}, el("span", { text: "Suggested order" }), el("strong", { text: m.suggestedOrderT ? `${m.suggestedOrderT} t` : "None" }))),
      el("section", { class: "detail-section" }, el("h3", { text: "Product" }), kv([
        ["Description", p.name],
        ["Category", p.category],
        ["Specification", p.spec],
        ["Commodity code", fmtCode(p.commodityCode)],
        ["Steel quota category", p.steelCategory ? `Category ${p.steelCategory.id}` : "Not covered", p.steelCategory ? p.steelCategory.name : "No steel quota — ordinary duty only"],
      ])),
      el("section", { class: "detail-section" }, el("h3", { text: "Stock & demand" }), kv([
        ["Current stock (recorded)", t(p.stockT), p.stockAsOf ? `as of ${fmt.date(p.stockAsOf)}` : null],
        ["Estimated stock today", t(m.stockNowT), m.estimated ? "recorded stock less usage since then" : null],
        ["Monthly usage", `${t(p.monthlyUsageT)}/month`],
        ["Months of cover", months(m.coverMonths)],
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
        ["Best saved quote", best ? el("a", { href: `order-tool.html?id=${best.id}`, text: fmt.perT(best.expectedPerT) }) : null,
          best ? `${best.supplier || best.title} · ${best.expectedPerT > (p.targetBuyPrice || p.costPerT) ? "above" : "below"} ${p.targetBuyPrice ? "target" : "cost"}` : "No saved quotes for this code"],
      ])),
      p.notes ? el("section", { class: "detail-section span-all" }, el("h3", { text: "Notes" }), el("p", { style: "margin:0;white-space:pre-wrap", text: p.notes })) : null);
  }

  function quotasPanel(p) {
    if (!p.steelCategory) {
      return el("div", { class: "profile-panel" }, el("div", { class: "empty-state" },
        el("h3", { text: "No steel quota applies" }),
        el("p", { text: `${fmtCode(p.commodityCode)} isn't in a UK steel-measure category, so imports pay ordinary duty only.` })));
    }
    if (!quota) {
      return el("div", { class: "profile-panel" }, el("div", { class: "empty-state" }, el("h3", { text: "Loading live quota balances…" })));
    }
    const lines = quota.lines.filter((l) => l.categoryId === p.steelCategory.id);
    const named = lines.filter((l) => !l.residual).map((l) => l.origin);
    const riskMap = { exhausted: ["Used up", "is-bad"], critical: ["Runs out this quarter", "is-bad"], watch: ["Under 30% left", "is-warn"], open: ["Open", ""], blocked: ["Blocked", "is-bad"], unknown: ["No data", "is-muted"] };
    const totalLeft = lines.reduce((sum, l) => sum + (l.balanceT || 0), 0);
    return el("div", { class: "profile-panel" },
      el("div", {},
        el("h3", { style: "margin:0 0 2px;font-size:15px", text: `Category ${p.steelCategory.id} · ${p.steelCategory.name}` }),
        el("p", { class: "small muted", style: "margin:0", text: `${quota.quarter.label} · live from ${quota.sources.tariff.lines ? "HMRC Trade Tariff" : "DBT daily dataset"} at ${fmt.time(quota.fetchedAt)} · ${fmt.tonnesRound(totalLeft)} left across ${lines.length} lines` })),
      el("div", { class: "table-scroll" }, el("table", { class: "quota-table" },
        el("thead", {}, el("tr", {},
          el("th", { text: "Origin" }), el("th", { text: "Order no." }),
          el("th", { class: "num wide-only", text: "Annual" }), el("th", { class: "num", text: "This quarter" }),
          el("th", { class: "wide-only", text: "Used" }), el("th", { class: "num", text: "Left" }),
          el("th", { class: "num wide-only", text: "Burn/day" }), el("th", { text: "Runs out" }), el("th", { text: "Status" }),
          el("th", { class: "num wide-only", text: "Next quarter" }))),
        el("tbody", {}, ...lines.map((l) => {
          const [label, cls] = riskMap[l.risk] || [l.risk, ""];
          const share = l.usedShare !== null && l.usedShare !== undefined ? Math.max(0, Math.min(1, l.usedShare)) : null;
          return el("tr", {},
            el("td", {}, el("strong", { text: l.residual ? "Other origins" : l.origin })),
            el("td", {}, el("a", { href: `https://www.trade-tariff.service.gov.uk/quota_search?order_number=${l.orderNumber}`, target: "_blank", rel: "noopener", text: l.orderNumber })),
            el("td", { class: "num wide-only", text: fmt.tonnesRound(l.annualTonnes) }),
            el("td", { class: "num", text: l.found ? fmt.tonnesRound(l.initialT) : "—" }),
            el("td", { class: "wide-only" }, share === null ? "—" : el("div", { class: "usage" },
              el("div", { class: `bar ${cls}`, "aria-hidden": "true" }, el("div", { style: `width:${(share * 100).toFixed(1)}%` })),
              el("span", { text: `${Math.round(share * 100)}%` }))),
            el("td", { class: "num" }, el("strong", { text: l.found ? fmt.tonnesRound(l.balanceT) : "—" })),
            el("td", { class: "num wide-only", text: l.found && l.burnPerDayT !== null ? fmt.tonnesRound(l.burnPerDayT) : "—" }),
            el("td", { text: l.risk === "exhausted" ? "Used up" : l.runOutDate ? fmt.date(l.runOutDate) : "—" }),
            el("td", {}, el("span", { class: `status-dot ${cls}`, style: "font-size:12px", text: label })),
            el("td", { class: "num wide-only", text: l.nextOpeningT ? fmt.tonnesRound(l.nextOpeningT) : "—" }));
        })))),
      el("p", { class: "small muted", style: "margin:0" },
        `"Other origins" covers every country not named for this category${named.length ? ` (named: ${named.join(", ")})` : ""}. Ukraine is excluded from the measure. Within quota there's no steel duty; once a line is used up, the 50% steel duty applies on top of ordinary duty. `,
        el("a", { href: `quotas.html?category=${encodeURIComponent(p.steelCategory.id)}`, text: "Open in Live quotas →" })),
      large ? null : el("p", { class: "small muted", style: "margin:0", text: "Switch to the large view for annual allocation, usage, burn rate and next quarter." }));
  }

  // Suppliers that supply this product's group, cheapest worst case first.
  let supplierList = null;
  function suppliersFor(p) { return (supplierList || []).filter((s) => (s.supplies || []).includes(p.category)); }
  function suppliersPanel(p) {
    const panel = el("div", { class: "profile-panel" });
    if (!supplierList) {
      panel.append(el("div", { class: "empty-state" }, el("h3", { text: "Loading suppliers…" })));
      return panel;
    }
    const list = suppliersFor(p).sort((a, b) => (a.metrics.worstCasePerT ?? 1e9) - (b.metrics.worstCasePerT ?? 1e9));
    if (!list.length) {
      const box = el("div", { class: "empty-state" });
      box.innerHTML = '<svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 21V10l5 3V10l5 3V6l8 4v11z"/><path d="M3 21h18"/></svg>';
      box.append(el("h3", { text: "No suppliers linked yet" }), el("p", {}, `No supplier is marked as supplying ${p.category}. `, el("a", { href: "suppliers.html", text: "Open Suppliers →" })));
      panel.append(box);
      return panel;
    }
    const sym = { GBP: "£", EUR: "€", USD: "$" };
    const price = (v, c) => (Number.isFinite(v) ? `${sym[c] || ""}${Math.round(v).toLocaleString("en-GB")}/t` : "—");
    const covers = { everything: "all-in", "except-duty": "+ duty", "ex-works": "ex works", port: "to port" };
    const target = p.targetBuyPrice || p.costPerT;
    panel.append(
      el("p", { class: "small muted", style: "margin:0", text: `${list.length} supplier${list.length === 1 ? "" : "s"} supply ${p.category}. Prices are their latest quotes; "worst case" adds the 50% steel duty where you'd carry it.` }),
      el("div", { class: "supplier-matches" }, ...list.map((s) => {
        const m = s.metrics;
        const lead = s.leadTimeMin === null ? null : `${s.leadTimeMin}${s.leadTimeMax && s.leadTimeMax !== s.leadTimeMin ? `–${s.leadTimeMax}` : ""} ${s.leadTimeUnit}`;
        return el("div", { class: "supplier-match" },
          el("div", {}, el("strong", { text: s.name }), el("div", { class: "small muted", text: [s.origin || "origin not set", s.type].filter(Boolean).join(" · ") })),
          el("div", { class: "sm-price" },
            el("strong", { text: price(m.pricePerT, m.currency) }),
            el("div", { class: "small muted", text: `${covers[m.covers] || ""}${m.dutyExposed ? ` · worst case ${price(m.worstCasePerT, m.currency)}` : ""}` })),
          el("div", { class: "sm-meta" },
            Number.isFinite(m.pricePerT) && target ? el("span", { text: `${m.pricePerT <= target ? "below" : "above"} your ${p.targetBuyPrice ? "target" : "cost"} (${fmt.money(target)})` }) : null,
            lead ? el("span", { text: `Lead ${lead}` }) : null,
            s.onTimePct !== null ? el("span", { text: `${s.onTimePct}% on time` }) : null,
            el("span", { text: s.moqNote || (s.moqMinT !== null ? `MOQ ${s.moqMinT}${s.moqMaxT && s.moqMaxT !== s.moqMinT ? `–${s.moqMaxT}` : ""} t` : "") }),
            m.awaitingQuote ? el("span", { class: "status-dot is-warn", text: "awaiting reply" }) : m.priceDate ? el("span", { text: m.priceChannel === "list" ? "price from supplier list" : `quoted ${fmt.date(m.priceDate)}` }) : null),
          el("div", { class: "sm-actions" },
            el("a", { class: "link-btn", href: `suppliers.html?supplier=${s.id}`, text: "Open supplier" }),
            me.canEdit ? el("a", { class: "link-btn", href: `suppliers.html?rfq=${p.id}`, text: "Request quote" }) : null));
      })));
    return panel;
  }

  function auditPanel(p) {
    const entries = (p.activity || []).map((a) => ({ kind: "change", at: a.at, a }));
    const priced = productQuotes(p);
    const events = [...entries, ...priced.map((sc) => ({ kind: "quote", at: sc.updatedAt, sc }))]
      .sort((x, y) => String(y.at).localeCompare(String(x.at)));
    const edits = entries.filter((e) => e.a.action === "edited").length;
    const stockUpdates = entries.filter((e) => ["stock updated", "updated by import"].includes(e.a.action) || (e.a.changes || []).some((c) => c.field === "stockT")).length;
    const created = entries.find((e) => e.a.action === "created");
    const shown = events.filter((e) => auditFilter === "all" || (auditFilter === "changes" && e.kind === "change") || (auditFilter === "quotes" && e.kind === "quote"));

    const filterBtn = (key, label) => el("button", { class: "chip", type: "button", "aria-pressed": String(auditFilter === key), text: label,
      onclick: () => { auditFilter = key; renderProfileBody(p); } });

    return el("div", { class: "profile-panel" },
      el("div", { class: "audit-summary" },
        el("div", {}, el("span", { text: "Created" }), el("strong", { style: "font-size:15px", text: created ? fmt.date(created.a.at) : "—" }), el("span", { text: created ? `by ${created.a.by}` : "" })),
        el("div", {}, el("span", { text: "Times edited" }), el("strong", { text: edits })),
        el("div", {}, el("span", { text: "Stock updates" }), el("strong", { text: stockUpdates })),
        el("div", {}, el("span", { text: "Times priced" }), el("strong", { text: priced.length }), el("span", { text: priced.length ? `${priced.filter((x) => x.status === "approved").length} approved` : "quotes for this code" }))),
      el("div", { class: "audit-filters", role: "group", "aria-label": "Filter history" },
        filterBtn("all", `All (${events.length})`), filterBtn("changes", `Changes (${entries.length})`), filterBtn("quotes", `Quotes (${priced.length})`)),
      shown.length
        ? el("ul", { class: "timeline" }, ...shown.map((e) => {
            if (e.kind === "quote") {
              const sc = e.sc;
              return el("li", {}, el("span", { class: "dot is-quote", "aria-hidden": "true" }),
                el("div", { class: "t-head" }, el("strong", { text: "Priced" }), el("span", { text: `${sc.createdBy || ""} · ${fmt.dateTime(sc.updatedAt)}` })),
                el("p", { class: "t-note" }, el("a", { href: `order-tool.html?id=${sc.id}`, text: sc.title }),
                  ` — ${sc.supplier || "no supplier"}, ${sc.origin}, ${t(sc.tonnage)} at ${fmt.perT(sc.expectedPerT)} · ${sc.status}`));
            }
            const a = e.a;
            const [label, cls] = ACTION[a.action] || [a.action.charAt(0).toUpperCase() + a.action.slice(1), ""];
            return el("li", {}, el("span", { class: `dot ${cls}`, "aria-hidden": "true" }),
              el("div", { class: "t-head" }, el("strong", { text: label }), el("span", { text: `${a.by} · ${fmt.dateTime(a.at)}` })),
              a.changes && a.changes.length
                ? el("dl", { class: "t-changes" }, ...a.changes.flatMap((c) => [
                    el("dt", { text: c.label }),
                    el("dd", {}, el("del", { text: fmtVal(c.field, c.from) }), " → ", el("strong", { text: fmtVal(c.field, c.to) }))]))
                : a.detail ? el("p", { class: "t-note", text: a.detail }) : null);
          }))
        : el("p", { class: "muted", text: "Nothing to show yet." }));
  }

  function renderProfileBody(p) {
    const body = profileTab === "quotas" ? quotasPanel(p)
      : profileTab === "suppliers" ? suppliersPanel(p)
      : profileTab === "audit" ? auditPanel(p)
      : overviewPanel(p);
    $("view-detail").replaceChildren(body);
    $("view-detail").setAttribute("aria-labelledby", `tab-${profileTab}`);
  }

  function renderTabs(p) {
    const lines = quota && p.steelCategory ? quota.lines.filter((l) => l.categoryId === p.steelCategory.id).length : 0;
    const tabs = [
      ["overview", "Overview", null],
      ["quotas", "Quotas", p.steelCategory ? lines || null : 0],
      ["suppliers", "Suppliers", supplierList ? suppliersFor(p).length : null],
      ["audit", "Audit trail", (p.activity || []).length + productQuotes(p).length],
    ];
    $("profile-tabs").replaceChildren(...tabs.map(([key, label, count]) => el("button", {
      class: "profile-tab", type: "button", role: "tab", id: `tab-${key}`, "aria-selected": String(profileTab === key), "aria-controls": "view-detail",
      tabindex: profileTab === key ? "0" : "-1",
      onclick: () => { profileTab = key; renderTabs(p); renderProfileBody(p); },
      onkeydown: (e) => {
        if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
        const i = tabs.findIndex((x) => x[0] === key);
        const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0];
        profileTab = next; renderTabs(p); renderProfileBody(p); $(`tab-${next}`).focus();
      },
    }, label, count !== null && count !== undefined ? el("span", { class: "count", text: count }) : null)));
  }

  function openDetail(id, tab) {
    const p = products.find((x) => x.id === id);
    if (!p) return;
    if (detailId !== id) { profileTab = tab || "overview"; auditFilter = "all"; }
    if (tab) profileTab = tab;
    detailId = id;
    const m = p.metrics;
    showDrawer("detail", p.name, `${p.category}${p.spec ? ` · ${p.spec}` : ""} · ${fmtCode(p.commodityCode)}`);
    renderTabs(p);
    renderProfileBody(p);
    const archiveBtn = el("button", { class: "btn btn-danger", type: "button", text: "Archive", onclick: () => archive(p, archiveBtn) });
    footer(
      me.canEdit ? archiveBtn : null,
      el("span", { class: "spacer" }),
      me.canEdit ? el("button", { class: "btn", type: "button", text: "Edit", onclick: () => openForm(p) }) : null,
      el("a", { class: "btn btn-primary", href: `order-tool.html?product=${p.id}`, text: m.suggestedOrderT ? `Price ${m.suggestedOrderT} t` : "Price an order" }));
    if (!drawer.contains(document.activeElement)) $(`tab-${profileTab}`).focus();
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

  const CAT = window.STEEL_CATALOGUE;
  let settings = null; // workspace defaults (Settings page)
  let pick = null; // { family, values } from the catalogue, or null
  let customMode = false; // "Other steel product" — typed by hand
  let comboItems = [];
  let comboActive = -1;

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

  const tariffLine = (code) => window.STEEL_COMMODITIES && window.STEEL_COMMODITIES.commodities.find((c) => c.code === code);

  function codeHint() {
    let code = field("commodityCode").value.replace(/[\s.]/g, "");
    if (/^\d{8}$/.test(code)) code += "00";
    const hint = $("code-hint");
    const known = tariffLine(code);
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
    renderResolved();
  }

  // ---- preset dropdowns (lead time, MOQ, safety stock, cover)
  function buildPresets() {
    form.querySelectorAll("select.preset").forEach((sel) => {
      const unit = sel.dataset.unit;
      const opts = [];
      if (sel.dataset.empty) opts.push(el("option", { value: "", text: sel.dataset.empty }));
      for (const v of sel.dataset.options.split(",")) opts.push(el("option", { value: v, text: `${v} ${Number(v) === 1 && unit !== "t" ? unit.replace(/s$/, "") : unit}` }));
      opts.push(el("option", { value: "other", text: "Other…" }));
      sel.replaceChildren(...opts);
      sel.addEventListener("change", () => {
        const input = field(sel.dataset.for);
        const box = input.closest(".input-unit");
        if (sel.value === "other") {
          box.hidden = false;
          input.focus();
        } else {
          box.hidden = true;
          input.value = sel.value;
          input.dataset.touched = "1";
          delete serverErrors[input.name];
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
    });
  }

  function setPreset(name, value) {
    const input = field(name);
    const sel = form.querySelector(`select.preset[data-for="${name}"]`);
    const v = value === null || value === undefined ? "" : String(value);
    input.value = v;
    if (!sel) return;
    const has = [...sel.options].some((o) => o.value === v && o.value !== "other");
    sel.value = has ? v : "other";
    input.closest(".input-unit").hidden = has;
  }

  // ---- category dropdown
  function fillCategories(selected) {
    const groups = CAT ? CAT.groups : [];
    const mine = products.map((p) => p.category);
    const all = [...new Set([...groups, ...mine, selected].filter(Boolean))];
    const sel = $("category-select");
    sel.replaceChildren(
      el("option", { value: "", text: "Choose a category" }),
      ...all.map((c) => el("option", { value: c, text: c })),
      el("option", { value: "Uncategorised", text: "Uncategorised" }),
    );
    sel.value = selected || "";
  }

  // ---- product picker (combobox over the catalogue)
  const allowedGroups = () => (settings && settings.catalogueGroups && settings.catalogueGroups.length ? settings.catalogueGroups : null);

  function comboOpen(open) {
    $("picker-list").hidden = !open;
    $("picker-q").setAttribute("aria-expanded", String(open));
    if (!open) { comboActive = -1; $("picker-q").removeAttribute("aria-activedescendant"); }
  }

  function renderCombo() {
    if (!CAT) return;
    const q = $("picker-q").value;
    const hits = CAT.search(q, { limit: 60, groups: allowedGroups() });
    comboItems = [...hits, { custom: true }];
    const list = $("picker-list");
    const frag = document.createDocumentFragment();
    let lastGroup = null;
    comboItems.forEach((item, i) => {
      if (item.custom) {
        frag.append(el("li", { class: "combo-group", role: "presentation", text: hits.length ? "Not listed?" : "No match" }));
      } else if (item.group !== lastGroup) {
        lastGroup = item.group;
        frag.append(el("li", { class: "combo-group", role: "presentation", text: item.group }));
      }
      let sub = "";
      if (item.custom) sub = "Type the description and commodity code yourself";
      else if (item.size) {
        const r = CAT.resolve(item.family, { size: item.size });
        const cat = r && r.commodityCode ? categoryFor(r.commodityCode) : null;
        sub = r && r.commodityCode ? `${fmtCode(r.commodityCode)}${cat ? ` · Cat ${cat.id}` : ""}` : "Pick tariff line after";
      } else {
        const fam = CAT.familyById(item.family);
        sub = `${fam.fields[0].values.length} sizes`;
      }
      const li = el("li", { class: `combo-option${item.size ? "" : " is-family"}${item.custom ? " is-custom" : ""}`, role: "option", id: `combo-${i}`, "aria-selected": "false", "data-i": String(i) },
        el("span", { class: "combo-label", text: item.custom ? "Other steel product" : item.label }),
        el("span", { class: "combo-sub", text: sub }));
      li.addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the input
      li.addEventListener("click", () => chooseItem(item));
      frag.append(li);
    });
    list.replaceChildren(frag);
    comboActive = -1;
    comboOpen(true);
  }

  function moveActive(delta) {
    if ($("picker-list").hidden) renderCombo();
    const n = comboItems.length;
    if (!n) return;
    comboActive = (comboActive + delta + n) % n;
    $("picker-list").querySelectorAll(".combo-option").forEach((li) => {
      const on = Number(li.dataset.i) === comboActive;
      li.setAttribute("aria-selected", String(on));
      li.classList.toggle("is-active", on);
      if (on) li.scrollIntoView({ block: "nearest" });
    });
    $("picker-q").setAttribute("aria-activedescendant", `combo-${comboActive}`);
  }

  function chooseItem(item) {
    comboOpen(false);
    dirty = true;
    if (item.custom) { setCustom(true); field("name").focus(); return; }
    setPick(item.family, { size: item.size || "" });
    if (!item.size) { const s = $("picked-fields").querySelector("select"); if (s) s.focus(); }
  }

  function setCustom(on) {
    customMode = on;
    if (on) pick = null;
    $("picked").hidden = true;
    $("resolved").hidden = on || !pick;
    $("name-field").hidden = !on;
    $("spec-field").hidden = !on;
    $("code-field").hidden = !on;
    $("choose-field").hidden = true;
    $("picker-q").closest(".field").hidden = on && Boolean(editing && !pick);
    $("picker-q").value = on ? "Other steel product" : "";
    $("picker-hint").textContent = on ? "Fill in the description and commodity code below — or search again to pick from the list." : "Search by size or product, or open the list to browse every steel product.";
    loadCodeList();
    codeHint();
  }

  // Show the dropdowns for one catalogue family and apply its result.
  function setPick(familyId, values, { initial = false } = {}) {
    const fam = CAT && CAT.familyById(familyId);
    if (!fam) return;
    customMode = false;
    const defaults = CAT.defaults(fam);
    pick = { family: fam.id, values: { ...defaults, ...(values || {}) } };
    $("picker-q").closest(".field").hidden = false;
    $("picker-q").value = "";
    $("picker-hint").textContent = "Search again to switch to a different product.";
    $("picked").hidden = false;
    $("picked-group").textContent = fam.group;
    $("picked-family").textContent = fam.label;
    $("picked-fields").replaceChildren(...fam.fields.map((f) => {
      const id = `pf-${f.key}`;
      const sel = el("select", { id, "data-key": f.key }, ...(f.key === "size" ? [el("option", { value: "", text: `Choose ${f.label.toLowerCase().replace(/ \(mm\)$/, "")}` })] : []), ...f.values.map((v) => el("option", { value: v, text: v })));
      const current = pick.values[f.key];
      if (current && !f.values.includes(current)) sel.append(el("option", { value: current, text: current }));
      sel.value = current || "";
      sel.addEventListener("change", () => {
        pick.values[f.key] = sel.value;
        applyResolved(false);
      });
      const wrap = el("label", { class: `field${f.key === "size" ? " field-size" : ""}`, for: id }, el("span", { class: "label-text", text: f.label }), sel);
      return wrap;
    }));
    applyResolved(initial);
  }

  function applyResolved(initial) {
    const r = pick ? CAT.resolve(pick.family, pick.values) : null;
    $("name-field").hidden = !customMode && !$("name-field").dataset.renamed;
    $("spec-field").hidden = !customMode;
    if (!r) {
      $("resolved").hidden = true;
      $("choose-field").hidden = true;
      if (!initial) { field("name").value = ""; field("commodityCode").value = ""; }
      codeHint();
      schedulePreview();
      return;
    }
    if (!initial) {
      if (!$("name-field").dataset.renamed) field("name").value = r.name;
      field("spec").value = r.spec;
      if (r.category) { fillCategories(r.category); }
      delete serverErrors.name;
      delete serverErrors.commodityCode;
    }
    // Ambiguous tariff split: ask which line.
    if (r.choosePrefix) {
      const lines = window.STEEL_COMMODITIES ? window.STEEL_COMMODITIES.commodities.filter((c) => c.code.startsWith(r.choosePrefix)) : [];
      const sel = $("code-choose");
      const keep = field("commodityCode").value;
      sel.replaceChildren(el("option", { value: "", text: "Choose the tariff line" }), ...lines.map((c) => el("option", { value: c.code, text: `${fmtCode(c.code)} — ${c.description.length > 90 ? `${c.description.slice(0, 88)}…` : c.description}`, title: c.description })));
      sel.value = lines.some((c) => c.code === keep) ? keep : "";
      if (!initial && !sel.value) field("commodityCode").value = "";
      $("choose-field").hidden = false;
    } else {
      $("choose-field").hidden = true;
      if (!initial || !field("commodityCode").value) field("commodityCode").value = r.commodityCode;
    }
    $("resolved").hidden = false;
    codeHint();
    if (!initial) schedulePreview();
  }

  function renderResolved() {
    if ($("resolved").hidden) return;
    const code = field("commodityCode").value.trim();
    $("r-name").textContent = field("name").value || "—";
    $("r-spec").textContent = field("spec").value || "—";
    const line = tariffLine(code);
    const desc = line ? (/^other$/i.test(line.description) ? line.headingDescription : line.description) : "";
    $("r-code").textContent = code ? `${fmtCode(code)}${desc ? ` · ${desc.slice(0, 60)}${desc.length > 60 ? "…" : ""}` : ""}` : "Choose the tariff line above";
    const cat = categoryFor(code);
    $("r-cat").replaceChildren(code
      ? (cat ? el("span", { class: "quota-pill", text: `Category ${cat.id} — ${cat.name}` }) : el("span", { class: "muted", text: "Not in a quota category — ordinary duty only" }))
      : "—");
    $("rename-btn").hidden = !$("name-field").hidden;
    $("code-btn").hidden = !$("code-field").hidden;
  }

  function readForm() {
    const body = {};
    for (const f of FIELDS) body[f] = field(f).value;
    if (pick) body.catalog = { family: pick.family, values: pick.values };
    else if (editing && editing.catalog) body.catalog = null;
    return body;
  }

  function showErrors(errors = {}, onlyTouched) {
    // Name and code live behind the picker until there's a problem with them.
    const pickerErr = errors.name && $("name-field").hidden ? (pick ? errors.name : "Search for and pick a product.") : null;
    if (errors.name && pick && $("name-field").hidden && /already/.test(errors.name)) { $("name-field").hidden = false; $("name-field").dataset.renamed = "1"; }
    const all = { ...errors, picker: pickerErr && !/already/.test(errors.name) ? pickerErr : null };
    if (errors.commodityCode && !$("choose-field").hidden) all.picker = all.picker || "Choose the tariff line for this product.";
    form.querySelectorAll("[data-field]").forEach((f) => {
      const key = f.dataset.field;
      const input = key === "picker" ? $("picker-q") : field(key);
      const msg = all[key];
      const touched = key === "picker" ? !onlyTouched : input && input.dataset.touched;
      const show = msg && (!onlyTouched || touched);
      f.classList.toggle("has-error", Boolean(show));
      const slot = f.querySelector(":scope > .error");
      if (slot) slot.textContent = show ? msg : "";
      if (input) input.setAttribute("aria-invalid", show ? "true" : "false");
    });
    renderResolved();
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
    pick = null;
    customMode = false;
    delete $("name-field").dataset.renamed;
    showDrawer("form", p ? `Edit ${p.name}` : "Add product", p ? p.category : "New product");
    form.reset();
    form.querySelectorAll("input, textarea, select").forEach((i) => { delete i.dataset.touched; });
    const s = settings || {};
    const values = p || {
      stockAsOf: todayIso(),
      leadTimeWeeks: s.defaultLeadTimeWeeks ?? null,
      moqT: s.defaultMoqT ?? null,
      safetyStockT: s.defaultSafetyStockT || null,
      targetCoverMonths: s.defaultTargetCoverMonths || 3,
    };
    for (const f of FIELDS) {
      let v = values[f];
      if (f === "safetyStockT" && !v) v = "";
      field(f).value = v === null || v === undefined ? "" : v;
    }
    ["leadTimeWeeks", "moqT", "safetyStockT", "targetCoverMonths"].forEach((n) => setPreset(n, field(n).value));
    fillCategories(p ? p.category : (s.defaultCategory || ""));
    field("stockAsOf").max = todayIso();
    $("picked").hidden = true;
    $("resolved").hidden = true;
    $("choose-field").hidden = true;
    $("name-field").hidden = true;
    $("spec-field").hidden = true;
    $("code-field").hidden = true;
    $("picker-q").closest(".field").hidden = false;
    $("picker-q").value = "";
    comboOpen(false);
    if (p) {
      const link = (p.catalog && CAT && CAT.familyById(p.catalog.family)) ? p.catalog : (CAT ? CAT.match(p.name, p.commodityCode) : null);
      if (link) setPick(link.family, link.values, { initial: true });
      else { setCustom(true); $("picker-q").closest(".field").hidden = false; $("picker-q").value = ""; }
      $("name-field").hidden = !customMode;
    }
    showErrors({});
    codeHint();
    runPreview();
    const cancel = el("button", { class: "btn", type: "button", "data-cancel": "", text: "Cancel", onclick: () => closeDrawer() });
    const save = el("button", { class: "btn btn-primary", type: "submit", form: "view-form", id: "form-save", text: p ? "Save changes" : "Add product" });
    footer(el("span", { class: "spacer" }), cancel, save);
    if (p) field("stockT").focus();
    else $("picker-q").focus();
  }

  async function submitForm(event) {
    event.preventDefault();
    form.querySelectorAll("input, textarea, select").forEach((i) => { i.dataset.touched = "1"; });
    const body = readForm();
    if (editing && body.stockT !== String(editing.stockT) && body.stockAsOf === editing.stockAsOf) body.stockAsOf = todayIso();
    const btn = $("form-save");
    btn.disabled = true;
    try {
      const saved = editing
        ? await api(`/api/products/${editing.id}`, { method: "PUT", body })
        : await api("/api/products", { method: "POST", body });
      highlightId = saved.id;
      const wasEditing = Boolean(editing);
      toast(wasEditing ? `${saved.name} updated` : `${saved.name} added`);
      closeDrawer(true);
      await load();
      if (wasEditing) openDetail(saved.id);
      setTimeout(() => { highlightId = null; }, 2500);
    } catch (error) {
      const errors = (error.data && error.data.errors) || {};
      serverErrors = errors;
      clearTimeout(previewTimer);
      showErrors(errors);
      const first = form.querySelector(".has-error input:not([hidden]), .has-error select, .has-error textarea");
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
      allScenarios = scen.scenarios;
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
      if (mode === "detail" && detailId) openDetail(detailId);
    } catch { /* optional */ }
  }

  // ---------------------------------------------------------------- events

  form.addEventListener("submit", submitForm);
  form.addEventListener("input", (e) => {
    dirty = true;
    if (e.target.name) { e.target.dataset.touched = "1"; delete serverErrors[e.target.name]; }
    if (e.target.name === "commodityCode") codeHint();
    if (e.target.name === "name" || e.target.name === "spec") renderResolved();
    const cancel = $("drawer-foot").querySelector("[data-cancel]");
    if (cancel && cancel.dataset.confirm) { delete cancel.dataset.confirm; cancel.textContent = "Cancel"; cancel.classList.remove("btn-danger"); }
    schedulePreview();
  });
  form.addEventListener("focusin", () => loadCodeList(), { once: true });
  buildPresets();
  const pq = $("picker-q");
  pq.addEventListener("input", (e) => { e.stopPropagation(); renderCombo(); });
  pq.addEventListener("focus", () => renderCombo());
  pq.addEventListener("click", () => { if ($("picker-list").hidden) renderCombo(); });
  pq.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== pq) comboOpen(false); }, 120));
  pq.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); moveActive(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); moveActive(-1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if ($("picker-list").hidden) return renderCombo();
      const item = comboItems[comboActive >= 0 ? comboActive : 0];
      if (item) chooseItem(item);
    } else if (e.key === "Escape" && !$("picker-list").hidden) { e.preventDefault(); e.stopPropagation(); comboOpen(false); }
  });
  $("picked-change").addEventListener("click", () => { pq.value = ""; pq.focus(); renderCombo(); });
  $("rename-btn").addEventListener("click", () => { $("name-field").hidden = false; $("name-field").dataset.renamed = "1"; renderResolved(); field("name").focus(); });
  $("code-btn").addEventListener("click", () => { loadCodeList(); $("code-field").hidden = false; $("choose-field").hidden = true; renderResolved(); field("commodityCode").focus(); });
  $("code-choose").addEventListener("change", (e) => {
    field("commodityCode").value = e.target.value;
    field("commodityCode").dataset.touched = "1";
    delete serverErrors.commodityCode;
    codeHint();
  });
  $("add-btn").addEventListener("click", () => openForm(null));
  $("import-btn").addEventListener("click", openImport);
  $("drawer-close").addEventListener("click", () => closeDrawer());
  $("drawer-size").addEventListener("click", () => {
    setSize(!large);
    if (mode === "detail" && detailId) { const p = products.find((x) => x.id === detailId); if (p) renderProfileBody(p); }
  });
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

  api("/api/settings").then((r) => { settings = r.settings; }).catch(() => { /* defaults */ });
  api("/api/suppliers").then((r) => {
    supplierList = r.suppliers;
    if (mode === "detail" && detailId) { const p = products.find((x) => x.id === detailId); if (p) { renderTabs(p); renderProfileBody(p); } }
  }).catch(() => { supplierList = []; });
  loadMe().then((m) => {
    me = m;
    if (!me.canEdit) { $("add-btn").hidden = true; $("import-btn").hidden = true; }
  });
  load().then(() => {
    const deep = new URLSearchParams(window.location.search).get("product");
    if (deep && products.some((p) => p.id === deep)) openDetail(deep);
    return loadQuota();
  });
})();
