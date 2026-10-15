(function () {
  "use strict";
  const { api, fmt, el, toast } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let data = null;
  let exposure = new Map();

  const RISK = {
    exhausted: ["Exhausted", "badge-bad"],
    critical: ["Runs out this quarter", "badge-bad"],
    watch: ["Under 30% left", "badge-warn"],
    blocked: ["Blocked", "badge-bad"],
    open: ["Open", "badge-good"],
    unknown: ["No data", ""],
  };

  function riskBadge(line) {
    const [label, cls] = RISK[line.risk] || [line.risk, ""];
    return el("span", { class: `badge ${cls}`, text: label });
  }

  function usageCell(line) {
    if (!line.found || line.usedShare === null) return el("td", { class: "muted", text: "—" });
    const share = Math.max(0, Math.min(1, line.usedShare));
    const cls = line.risk === "exhausted" || line.risk === "critical" ? "is-bad" : line.risk === "watch" ? "is-warn" : "";
    return el("td", {},
      el("div", { class: "usage" },
        el("div", { class: `bar ${cls}`, role: "img", "aria-label": `${Math.round(share * 100)}% used` },
          el("div", { style: `width:${(share * 100).toFixed(1)}%` })),
        el("span", { text: `${Math.round(share * 100)}%` })),
      el("div", { class: "row-sub", text: `${fmt.tonnesRound(line.usedT)} used` }));
  }

  function runOutCell(line) {
    if (!line.found) return el("td", { class: "muted", text: "—" });
    if (line.risk === "exhausted") return el("td", {}, el("strong", { text: "Used up" }));
    if (!line.runOutDate) return el("td", { class: "muted", text: "No use yet" });
    const inQuarter = line.runOutDate <= line.endDate;
    return el("td", {},
      el(inQuarter ? "strong" : "span", { text: fmt.date(line.runOutDate) }),
      el("div", { class: "row-sub", text: inQuarter ? "this quarter" : "after quarter end" }));
  }

  function filtered() {
    const q = $("q").value.trim().toLowerCase();
    const cat = $("f-category").value;
    const origin = $("f-origin").value;
    const risk = $("f-risk").value;
    let lines = data.lines.filter((l) => {
      if (cat && l.categoryId !== cat) return false;
      if (origin && l.origin !== origin) return false;
      if (risk === "atrisk" && !["watch", "critical", "exhausted", "blocked"].includes(l.risk)) return false;
      if (risk === "critical" && !["critical", "exhausted"].includes(l.risk)) return false;
      if (risk === "exhausted" && l.risk !== "exhausted") return false;
      if (risk === "mine" && !exposure.has(l.orderNumber)) return false;
      if (!q) return true;
      return [l.orderNumber, l.categoryId, l.categoryName, l.origin].some((v) => String(v).toLowerCase().includes(q));
    });
    const sort = $("f-sort").value;
    if (sort === "left") lines = [...lines].sort((a, b) => (1 - (a.usedShare ?? 0)) - (1 - (b.usedShare ?? 0)));
    if (sort === "runout") lines = [...lines].sort((a, b) => (a.runOutDate || "9999") .localeCompare(b.runOutDate || "9999"));
    return lines;
  }

  function render() {
    const lines = filtered();
    const rows = [];
    let lastCat = null;
    const grouped = $("f-sort").value === "order";
    for (const l of lines) {
      if (grouped && l.categoryId !== lastCat) {
        lastCat = l.categoryId;
        rows.push(el("tr", { class: "cat-row" }, el("td", { colspan: "10", text: `Category ${l.categoryId} · ${l.categoryName}` })));
      }
      const mine = exposure.get(l.orderNumber);
      rows.push(el("tr", {},
        el("td", {},
          el("a", { href: `quota.html?order=${l.orderNumber}`, style: "font-weight:600;font-variant-numeric:tabular-nums", text: l.orderNumber }),
          l.source === "dbt" ? el("span", { class: "src", title: "From the DBT daily dataset", text: "daily" }) : null),
        el("td", {}, el("span", { class: "badge badge-info", text: l.categoryId }), grouped ? null : el("div", { class: "row-sub", text: l.categoryName })),
        el("td", {}, l.residual ? el("span", { title: "Every origin not named for this category" }, "Residual", el("div", { class: "row-sub", text: "all other origins" })) : l.origin),
        el("td", { class: "num" }, l.found ? fmt.tonnesRound(l.initialT) : "—", el("div", { class: "row-sub", text: `${fmt.tonnesRound(l.annualTonnes)} a year` })),
        usageCell(l),
        el("td", { class: "num" }, el("strong", { text: l.found ? fmt.tonnesRound(l.balanceT) : "—" })),
        el("td", { class: "num", text: l.found && l.burnPerDayT !== null ? fmt.tonnesRound(l.burnPerDayT) : "—" }),
        runOutCell(l),
        el("td", {}, riskBadge(l)),
        el("td", { class: "num" }, mine
          ? el("a", { href: `orders.html`, title: mine.titles.join("\n"), text: `${mine.count} · ${fmt.tonnesRound(mine.tonnes)}` })
          : el("span", { class: "muted", text: "—" }))));
    }
    if (!lines.length) rows.push(el("tr", {}, el("td", { colspan: "10", class: "empty", text: "No quota lines match these filters." })));
    $("rows").replaceChildren(...rows);
  }

  function renderSummary() {
    const found = data.lines.filter((l) => l.found);

    const tariffLines = data.sources.tariff.lines;
    const status = $("feed-status");
    status.textContent = tariffLines
      ? `HMRC Trade Tariff${data.sources.tariff.auth === "registered" ? " (registered)" : ""} · ${data.quarter.label} · updated ${fmt.time(data.fetchedAt)}`
      : `DBT daily dataset · ${data.quarter.label} · updated ${fmt.time(data.fetchedAt)}`;
    status.classList.toggle("is-stale", !tariffLines);

    const warn = $("feed-warning");
    const missing = data.lines.length - found.length;
    const msgs = [];
    if (!tariffLines) msgs.push("HMRC's Trade Tariff quota service could not be reached, so balances come from the DBT dataset, which updates once a day.");
    else if (data.sources.dbt.lines && tariffLines < data.lines.length) msgs.push(`${data.lines.length - tariffLines} lines came from the DBT daily dataset because HMRC did not return them.`);
    if (data.errors && data.errors.some((e) => /rate limit/i.test(e))) msgs.push(data.errors.find((e) => /rate limit/i.test(e)));
    if (missing) msgs.push(`${missing} quota lines have no data for ${data.quarter.label} yet.`);
    warn.hidden = msgs.length === 0;
    warn.textContent = msgs.join(" ");
  }

  function fillFilters() {
    const cats = [...new Map(data.lines.map((l) => [l.categoryId, l.categoryName])).entries()];
    $("f-category").replaceChildren(el("option", { value: "", text: "All categories" }),
      ...cats.map(([id, name]) => el("option", { value: id, text: `${id} · ${name}` })));
    const origins = [...new Set(data.lines.map((l) => l.origin))].sort((a, b) => (a === "Residual") - (b === "Residual") || a.localeCompare(b));
    $("f-origin").replaceChildren(el("option", { value: "", text: "All origins" }), ...origins.map((o) => el("option", { value: o, text: o })));
  }

  async function loadExposure() {
    try {
      const { scenarios } = await api("/api/scenarios");
      exposure = new Map();
      for (const s of scenarios) {
        if (!s.quotaOrderNumber || ["archived", "rejected"].includes(s.status)) continue;
        const e = exposure.get(s.quotaOrderNumber) || { count: 0, tonnes: 0, titles: [] };
        e.count += 1;
        e.tonnes += s.tonnage || 0;
        e.titles.push(s.title);
        exposure.set(s.quotaOrderNumber, e);
      }
    } catch { /* exposure is optional */ }
  }

  async function load(force) {
    const btn = $("refresh-btn");
    btn.disabled = true;
    $("feed-status").textContent = "Loading live balances…";
    try {
      const [live] = await Promise.all([api(`/api/steel-quotas/live${force ? "?refresh=1" : ""}`), loadExposure()]);
      data = live;
      if (!$("f-category").options.length || $("f-category").options.length === 1) {
        fillFilters();
        const wanted = new URLSearchParams(window.location.search).get("category");
        if (wanted && [...$("f-category").options].some((o) => o.value === wanted)) $("f-category").value = wanted;
      }
      renderSummary();
      render();
    } catch (error) {
      $("feed-status").textContent = "Live quota feed unavailable";
      $("feed-status").classList.add("is-stale");
      $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "10", class: "empty", text: `Could not load quota balances: ${error.message}` })));
      toast(`Live quotas: ${error.message}`, true);
    } finally {
      btn.disabled = false;
    }
  }

  ["q", "f-category", "f-origin", "f-risk", "f-sort"].forEach((id) => $(id).addEventListener("input", () => data && render()));
  $("refresh-btn").addEventListener("click", () => load(true));
  load(false);
  setInterval(() => { if (document.visibilityState === "visible") load(false); }, 10 * 60 * 1000);
})();
