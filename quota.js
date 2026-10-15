// One quota line: where it stands now, when it should fill, and its history.
(function () {
  "use strict";
  const { api, fmt, el } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  const order = new URLSearchParams(location.search).get("order") || "";

  const t = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-GB")} t` : "—");
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "—");
  const qShort = (iso) => { const [y, m] = iso.split("-").map(Number); return `Q${Math.floor((m - 1) / 3) + 1} ’${String(y).slice(2)}`; };
  const day = (iso) => fmt.date(iso).replace(/ \d{4}$/, "");
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + Math.round(n) * 86400000).toISOString().slice(0, 10);
  const VERDICT = { full: ["Full", "badge-bad"], imminent: ["Fills within 2 weeks", "badge-bad"], fills: ["Fills this quarter", "badge-warn"], tight: ["Tight", "badge-warn"], lasts: ["Lasts the quarter", "badge-good"] };
  let showAll = false;

  // This quarter: used share, today, projected full and typical full day on one bar
  function quarterBar(l, o) {
    const pos = (d) => `${(Math.max(0, Math.min(o.quarterDays, d)) / o.quarterDays) * 100}%`;
    const used = o.initialT ? Math.min(1, (o.usedT || 0) / o.initialT) : 0;
    const marker = (d, cls, label) => el("span", { class: `qb-mark ${cls}`, style: `left:${pos(d)}`, title: label }, el("span", { class: "qb-label", text: label }));
    return el("div", { class: "qb" },
      el("div", { class: "qb-track", role: "img", "aria-label": `${Math.round(used * 100)}% of this quarter's quota used by day ${o.elapsed} of ${o.quarterDays}` },
        el("div", { class: `qb-fill ${used >= 0.9 ? "is-bad" : used >= 0.6 ? "is-warn" : ""}`, style: `width:${used * 100}%` }),
        marker(o.elapsed, "is-today", "Today"),
        o.fullDay ? marker(o.fullDay, "is-full", `Full ~${day(o.fullOn)}`) : null,
        l.dayFullMedian && !(o.fullDay && Math.abs(o.fullDay - l.dayFullMedian) < 8) ? marker(l.dayFullMedian, "is-typical", `Usually full · ${day(addDays(o.quarterStart, l.dayFullMedian - 1))}`) : null),
      el("div", { class: "qb-axis" }, ...[0, Math.round(o.quarterDays / 3), Math.round((2 * o.quarterDays) / 3), o.quarterDays - 1].map((d) => el("span", { text: day(addDays(o.quarterStart, d)) }))));
  }

  function historyBars(hist) {
    const hs = hist.slice(-12);
    if (!hs.length) return el("p", { class: "muted", text: "No history yet" });
    return el("div", { class: "qh2" },
      el("div", { class: "qh2-bars" }, ...hs.map((h) => el("div", { class: "qh2-col", title: `${qShort(h.startDate)} · ${pct(Math.min(100, h.fillPct))} used${h.exhausted ? ` · ran out day ${h.dayFull || "?"}` : ""}${h.current ? " · so far" : ""}` },
        el("span", { class: "qh2-val", text: h.exhausted ? `d${h.dayFull || "?"}` : pct(Math.min(100, h.fillPct)) }),
        el("div", { class: "qh2-slot" }, el("i", { class: `${h.exhausted ? "is-out" : h.fillPct >= 85 ? "is-high" : ""}${h.current ? " is-now" : ""}`, style: `height:${Math.max(2, Math.min(100, h.fillPct))}%` })),
        el("span", { class: "qh2-q", text: qShort(h.startDate) })))),
      el("div", { class: "qh2-key" }, el("span", { class: "k-out", text: "Ran out" }), el("span", { class: "k-high", text: "85%+" }), el("span", { class: "k-low", text: "Below 85%" })));
  }

  function render(r) {
    const l = r.line, o = l.outlook, live = r.live;
    $("qp-title").textContent = `Category ${l.categoryId} · ${l.origin}`;
    $("qp-sub").textContent = `${l.orderNumber} · ${l.categoryName} · ${t(l.annualTonnes)} a year · steel measure from ${fmt.date(r.since || "2026-07-01")}`;
    document.title = `${l.categoryId} ${l.origin} quota · Datafab AGX`;
    const [vl, vc] = o ? VERDICT[o.verdict] || [o.verdict, ""] : ["No live data", ""];
    $("qp-verdict").replaceChildren(el("span", { class: `badge ${vc} qp-badge`, text: vl }));
    const risky = o && o.safeUntil && (o.verdict === "full" || o.safeUntil < r.asOf);

    const hero = o ? el("section", { class: "card qp-hero" },
      el("div", { class: "qp-hero-main" },
        el("div", { class: "qp-left" }, el("strong", { text: t(o.leftT) }), el("span", { text: `left of ${t(o.initialT)}` })),
        el("dl", { class: "qp-kv" },
          el("div", {}, el("dt", { text: "Fills" }), el("dd", { class: o.fullOn ? "is-bad" : "is-good", text: o.fullOn ? `~${fmt.date(o.fullOn)}` : "Lasts the quarter" })),
          el("div", {}, el("dt", { text: "Safe to import until" }), el("dd", { class: risky ? "is-bad" : "", text: risky ? "Risky now" : o.safeUntil ? fmt.date(o.safeUntil) : "—" })),
          el("div", {}, el("dt", { text: "Pace" }), el("dd", { text: o.livePaceT ? `${t(o.livePaceT)}/day` : "—" }, o.historicPaceT ? el("small", { text: ` past ${t(o.historicPaceT)}/day` }) : null)))),
      quarterBar(l, o),
      live && live.nextStartDate ? el("p", { class: "qp-next", text: `Next quarter opens ${fmt.date(live.nextStartDate)}${live.nextOpeningT ? ` · ${t(live.nextOpeningT)}` : ""}` }) : null)
      : el("section", { class: "card qp-hero" }, el("p", { class: "muted", text: "No live balance for this quarter." }));

    const enough = l.allQuarters >= 4;
    const facts = [
      l.recentQuarters ? ["Ran out", `${l.exhaustedCount} of ${l.recentQuarters === l.quarters ? "" : "last "}${l.recentQuarters} quarter${l.recentQuarters === 1 ? "" : "s"}`, l.exhaustedCount ? "is-bad" : "is-good"] : null,
      l.dayFullMedian ? ["Usually full by", `day ${Math.round(l.dayFullMedian)}`] : null,
      l.recentQuarters ? ["Average used", pct(l.avgFillPct)] : null,
      enough && Number.isFinite(l.paceTrendPct) && Math.abs(l.paceTrendPct) < 300 ? ["Demand vs year before", `${l.paceTrendPct >= 0 ? "+" : "−"}${Math.abs(Math.round(l.paceTrendPct))}%`, l.paceTrendPct > 10 ? "is-bad" : ""] : null,
      l.sameQuarterLastYear ? ["Same quarter last year", `${pct(Math.min(100, l.sameQuarterLastYear.fillPct))}${l.sameQuarterLastYear.exhausted ? ` · full day ${l.sameQuarterLastYear.dayFull}` : ""}`] : null,
    ].filter(Boolean);

    const exposure = r.products.length || r.suppliers.length || r.scenarios.length ? el("section", { class: "card qp-card" },
      el("h2", { text: "Your exposure" }),
      el("dl", { class: "qp-kv qp-kv-rows" },
        r.products.length ? el("div", {}, el("dt", { text: "Products" }), el("dd", {}, ...r.products.flatMap((p, i) => [i ? ", " : "", el("a", { href: `products.html?product=${p.id}`, text: p.name })]))) : null,
        r.suppliers.length ? el("div", {}, el("dt", { text: "Suppliers" }), el("dd", {}, ...r.suppliers.flatMap((s, i) => [i ? ", " : "", el("a", { href: `suppliers.html?supplier=${s.id}`, text: s.name })]))) : null,
        ...r.scenarios.map((s) => el("div", {}, el("dt", {}, el("a", { href: `order.html?id=${s.id}`, text: s.title })), el("dd", { class: s.afterSafe ? "is-bad" : "", text: `${t(s.tonnage)} · ${fmt.date(s.importDate)}${s.afterSafe ? " · after safe date" : ""}` }))))) : null;

    const rows = [...l.fullHistory].reverse();
    const shown = showAll ? rows : rows.slice(0, 6);
    const table = el("section", { class: "card qp-card" },
      el("h2", { text: "Quarters" }),
      el("div", { class: "table-scroll" }, el("table", { class: "qp-table" },
        el("thead", {}, el("tr", {}, ...["Quarter", "Opening", "Used", "", "Ran out"].map((h, i) => el("th", { class: `${i && i !== 3 ? "num" : ""}${i === 1 ? " qp-hide-sm" : ""}`, text: h })))),
        el("tbody", {}, ...shown.map((h) => el("tr", { class: h.current ? "is-now" : "" },
          el("td", {}, el("strong", { text: qShort(h.startDate) }), h.current ? el("span", { class: "qp-scheme", text: "now" }) : null),
          el("td", { class: "num qp-hide-sm", text: t(h.initialT) }),
          el("td", { class: "num", text: t(h.usedT) }),
          el("td", {}, el("div", { class: "qp-usedcell" }, el("span", { class: "qp-minibar" }, el("i", { class: h.exhausted ? "is-out" : h.fillPct >= 85 ? "is-high" : "", style: `width:${Math.min(100, h.fillPct)}%` })), el("span", { text: pct(Math.min(100, h.fillPct)) }))),
          el("td", { class: `num${h.exhausted ? " is-bad" : ""}`, text: h.exhausted ? (h.exhaustedOn ? `${day(h.exhaustedOn)} · day ${h.dayFull}` : "Yes") : "—" })))))),
      rows.length > 6 ? el("button", { type: "button", class: "link-btn qp-more", text: showAll ? "Show fewer" : `Show all ${rows.length}`, onclick: () => { showAll = !showAll; render(r); } }) : null);

    $("qp-root").replaceChildren(...[
      hero,
      el("div", { class: "qp-grid" },
        el("section", { class: "card qp-card" }, el("h2", { text: `History since ${fmt.date(r.since || "2026-07-01")}` }), historyBars(l.fullHistory)),
        ...(facts.length ? [el("section", { class: "card qp-card" }, el("h2", { text: "Key figures" }), el("dl", { class: "qp-kv qp-kv-rows" }, ...facts.map(([k, v, cls]) => el("div", {}, el("dt", { text: k }), el("dd", { class: cls || "", text: v })))))] : [])),
      exposure,
      table,
      el("p", { class: "qp-src" }, el("a", { href: r.source.url, target: "_blank", rel: "noopener", text: "DBT quota dataset" }), " · HMRC Trade Tariff")].filter(Boolean));
  }

  if (!/^\d{6}$/.test(order)) { $("qp-root").replaceChildren(el("p", { class: "muted", text: "Pick a quota line on Live quotas." })); return; }
  api(`/api/steel-quotas/line/${order}`).then(render).catch((error) => { $("qp-root").replaceChildren(el("p", { class: "muted", text: `Couldn't load this quota line: ${error.message}` })); });
})();
