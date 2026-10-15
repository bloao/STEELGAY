// Live quotas → History & outlook: every past quarter per line, how full it
// got, when it ran out, the pace of use, and when this quarter should fill.
(function () {
  "use strict";
  const { api, fmt, el } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let data = null;
  let mine = new Set();
  let scope = "mine";

  const t = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-GB")} t` : "—");
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "—");
  const qLabel = (iso) => { const [y, m] = iso.split("-").map(Number); return `${["Jan–Mar", "Apr–Jun", "Jul–Sep", "Oct–Dec"][Math.floor((m - 1) / 3)]} ${y}`; };
  const VERDICT = {
    full: ["Full", "badge-bad"], imminent: ["Fills within 2 weeks", "badge-bad"], fills: ["Fills this quarter", "badge-warn"],
    tight: ["Tight", "badge-warn"], lasts: ["Lasts the quarter", "badge-good"],
  };

  function bars(history) {
    const box = el("div", { class: "qh-bars", role: "img", "aria-label": history.map((h) => `${qLabel(h.startDate)} ${Math.round(Math.min(100, h.fillPct))}%${h.exhausted ? " ran out" : ""}`).join(", ") });
    for (const h of history) {
      box.append(el("span", { class: `${h.exhausted ? "is-out" : h.fillPct >= 85 ? "is-high" : ""}${h.current ? " is-now" : ""}${h.regime === "measure" ? " is-measure" : ""}`,
        style: `height:${Math.max(3, Math.min(100, h.fillPct) * 0.32)}px`, title: `${qLabel(h.startDate)}: ${pct(Math.min(100, h.fillPct))}${h.exhausted ? ` · ran out day ${h.dayFull}` : ""}${h.current ? " · so far" : ""}` }));
    }
    return box;
  }

  function verdictCell(o) {
    if (!o) return el("td", { class: "muted", text: "—" });
    const [label, cls] = VERDICT[o.verdict] || [o.verdict, ""];
    return el("td", {}, el("span", { class: `badge ${cls}`, text: label }), o.fullOn ? el("div", { class: "row-sub", text: `~${fmt.date(o.fullOn)}` }) : null);
  }

  function safeCell(o) {
    if (!o || !o.safeUntil) return el("td", { class: "num muted", text: "—" });
    if (o.verdict === "full" || o.safeUntil < data.asOf) return el("td", { class: "num" }, el("span", { class: "badge badge-bad", text: "Risky now" }));
    return el("td", { class: "num" }, el("strong", { text: fmt.date(o.safeUntil) }));
  }

  function render() {
    if (!data) return;
    const lines = data.lines.filter((l) => l.quarters || (l.outlook && l.outlook.initialT)).filter((l) => scope === "all" || mine.has(l.categoryId));
    const ofMine = data.lines.filter((l) => mine.has(l.categoryId) && l.outlook);
    const filling = ofMine.filter((l) => l.outlook && ["full", "imminent", "fills"].includes(l.outlook.verdict));
    const soonest = ofMine.filter((l) => l.outlook && l.outlook.fullOn).sort((a, b) => a.outlook.fullOn.localeCompare(b.outlook.fullOn))[0];
    const tile = (k, v, sub, cls) => el("div", { class: `qh-tile ${cls || ""}` }, el("span", { text: k }), el("strong", { text: v }), sub ? el("small", { text: sub }) : null);
    $("qh-summary").replaceChildren(
      tile("Your lines filling this quarter", `${filling.length} of ${ofMine.length}`, null, filling.length ? "is-bad" : "is-good"),
      tile("Fills first", soonest ? `${soonest.categoryId} ${soonest.origin}` : "None", soonest ? `~${fmt.date(soonest.outlook.fullOn)}` : null),
      tile("History", data.firstPeriod ? (() => { const n = Math.max(...data.lines.map((l) => l.quarters)); return `${n} quarter${n === 1 ? "" : "s"}`; })() : "—", data.firstPeriod ? `from ${qLabel(data.firstPeriod)}` : null));
    const order = { full: 0, imminent: 1, fills: 2, tight: 3, lasts: 4 };
    lines.sort((a, b) => (order[a.outlook?.verdict] ?? 5) - (order[b.outlook?.verdict] ?? 5) || (a.outlook?.fullOn || "9").localeCompare(b.outlook?.fullOn || "9") || a.orderNumber.localeCompare(b.orderNumber));
    const rows = [];
    for (const l of lines) {
      const go = () => { location.href = `quota.html?order=${l.orderNumber}`; };
      rows.push(el("tr", { class: "qh-row", tabindex: "0", role: "link", "aria-label": `Open ${l.categoryId} ${l.origin} quota`, onclick: go,
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } } },
        el("td", {}, el("strong", { text: l.categoryId }), el("div", { class: "row-sub", text: l.orderNumber })),
        el("td", { text: l.origin }),
        el("td", { class: "num", text: String(l.quarters || "—") }),
        el("td", { class: "num", text: pct(l.avgFillPct) }),
        el("td", { class: `num${l.exhaustedCount ? " is-bad" : ""}`, text: l.recentQuarters ? `${l.exhaustedCount}/${l.recentQuarters}` : "—" }),
        el("td", { class: "num", text: l.dayFullMedian ? `day ${Math.round(l.dayFullMedian)}` : "—" }),
        el("td", { class: "num", text: l.paceT ? t(l.paceT) : "—" }),
        el("td", {}, bars(l.history)),
        verdictCell(l.outlook),
        safeCell(l.outlook)));
    }
    $("qh-rows").replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { colspan: "10", class: "empty", text: "No quota history for these lines yet." }))]));
    for (const b of $("qh-scope").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.scope === scope));
  }

  async function load() {
    try {
      const [h, p] = await Promise.all([api("/api/steel-quotas/history"), api("/api/products").catch(() => ({ products: [] }))]);
      data = h;
      mine = new Set((p.products || []).map((x) => x.steelCategory && x.steelCategory.id).filter(Boolean));
      if (!mine.size) scope = "all";
      render();
    } catch (error) {
      $("qh-rows").replaceChildren(el("tr", {}, el("td", { colspan: "10", class: "empty", text: `Quota history unavailable: ${error.message}` })));
    }
  }
  $("qh-scope").addEventListener("click", (e) => { const b = e.target.closest("button[data-scope]"); if (!b) return; scope = b.dataset.scope; render(); });
  load();
})();
