// One quota line: where it stands, when it should fill, its history and
// what it means for your products, suppliers and orders.
(function () {
  "use strict";
  const { api, fmt, el } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  const order = new URLSearchParams(location.search).get("order") || "";

  const t = (v) => (Number.isFinite(v) ? `${Math.round(v).toLocaleString("en-GB")} t` : "—");
  const pct = (v) => (Number.isFinite(v) ? `${Math.round(v)}%` : "—");
  const qLabel = (iso) => { const [y, m] = iso.split("-").map(Number); return `${["Q1", "Q2", "Q3", "Q4"][Math.floor((m - 1) / 3)]} ${y}`; };
  const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + Math.round(n) * 86400000).toISOString().slice(0, 10);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const VERDICT = { full: ["Full", "badge-bad"], imminent: ["Fills within 2 weeks", "badge-bad"], fills: ["Fills this quarter", "badge-warn"], tight: ["Tight", "badge-warn"], lasts: ["Lasts the quarter", "badge-good"] };
  const svgBox = (html, label) => { const d = el("div", { class: "qp-chart", role: "img", "aria-label": label }); d.innerHTML = html; return d; };
  const card = (title, ...kids) => el("section", { class: "card qp-card" }, el("h2", { text: title }), ...kids);
  const stat = (k, v, cls, sub) => el("div", { class: `qp-stat ${cls || ""}` }, el("span", { text: k }), el("strong", { text: v }), sub ? el("small", { text: sub }) : null);

  // This quarter as a timeline: used so far, today, projected full, typical full day
  function timeline(l, live) {
    const o = l.outlook;
    if (!o) return el("p", { class: "muted", text: "No live balance for this quarter." });
    const W = 720, H = 86, L = 8, R = 8, days = o.quarterDays;
    const x = (d) => L + (Math.max(0, Math.min(days, d)) / days) * (W - L - R);
    const used = live && live.usedShare != null ? live.usedShare : o.initialT ? o.usedT / o.initialT : 0;
    const marks = [];
    marks.push(`<line x1="${x(o.elapsed)}" y1="14" x2="${x(o.elapsed)}" y2="58" stroke="var(--ink)" stroke-width="2"/><text x="${x(o.elapsed)}" y="10" text-anchor="middle" class="qp-t">Today</text>`);
    if (o.fullDay) marks.push(`<line x1="${x(o.fullDay)}" y1="20" x2="${x(o.fullDay)}" y2="58" stroke="#c2482a" stroke-width="2" stroke-dasharray="4 3"/><text x="${x(o.fullDay)}" y="74" text-anchor="middle" class="qp-t is-bad">Full ~${esc(fmt.date(o.fullOn))}</text>`);
    if (l.dayFullMedian) marks.push(`<circle cx="${x(l.dayFullMedian)}" cy="39" r="5" fill="var(--warn-line)"/><text x="${x(l.dayFullMedian)}" y="${o.fullDay && Math.abs(o.fullDay - l.dayFullMedian) < 14 ? 86 : 74}" text-anchor="middle" class="qp-t">Typical full · day ${Math.round(l.dayFullMedian)}</text>`);
    const ticks = [0, 30, 61, days].map((d) => `<text x="${x(d)}" y="${H}" text-anchor="${d === 0 ? "start" : d === days ? "end" : "middle"}" class="qp-axis">${esc(fmt.date(addDays(o.quarterStart, d)).replace(/ \d{4}$/, ""))}</text>`).join("");
    return svgBox(`<svg viewBox="0 0 ${W} ${H + 4}" preserveAspectRatio="none" width="100%" height="${H + 4}">
      <rect x="${L}" y="28" width="${W - L - R}" height="22" rx="5" fill="var(--neutral-bg)"/>
      <rect x="${L}" y="28" width="${(W - L - R) * Math.min(1, used)}" height="22" rx="5" fill="${used >= 0.9 ? "#c2482a" : used >= 0.6 ? "var(--warn-line)" : "var(--accent)"}"/>
      <text x="${L + 8}" y="44" class="qp-in">${Math.round(used * 100)}% used</text>
      ${marks.join("")}${ticks}</svg>`, `This quarter: ${Math.round(used * 100)}% used, day ${o.elapsed} of ${days}${o.fullOn ? `, projected full ${fmt.date(o.fullOn)}` : ""}`);
  }

  // Every quarter: fill bars, red where it ran out, with the day it ran out
  function historyChart(hist) {
    const hs = hist.slice(-24);
    if (!hs.length) return el("p", { class: "muted", text: "No history for this line yet." });
    const W = 720, H = 150, T = 14, B = 26, L = 30, gap = 3;
    const bw = (W - L) / hs.length - gap;
    const y = (v) => T + (1 - Math.min(100, v) / 100) * (H - T - B);
    const grid = [0, 50, 100].map((v) => `<line x1="${L}" x2="${W}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)"/><text x="${L - 4}" y="${y(v) + 4}" text-anchor="end" class="qp-axis">${v}%</text>`).join("");
    const bars = hs.map((h, i) => {
      const bx = L + i * (bw + gap);
      const fill = h.exhausted ? "#c2482a" : h.fillPct >= 85 ? "var(--warn-line)" : "var(--accent)";
      const lbl = i % Math.ceil(hs.length / 8) === 0 || i === hs.length - 1 ? `<text x="${bx + bw / 2}" y="${H - 8}" text-anchor="middle" class="qp-axis">${esc(qLabel(h.startDate))}</text>` : "";
      const day = h.exhausted && h.dayFull && bw > 14 ? `<text x="${bx + bw / 2}" y="${y(h.fillPct) - 3}" text-anchor="middle" class="qp-axis is-bad">${h.dayFull}</text>` : "";
      return `<rect x="${bx}" y="${y(h.fillPct)}" width="${bw}" height="${H - B - y(h.fillPct)}" rx="2" fill="${fill}" opacity="${h.current ? 0.5 : 1}"${h.regime === "measure" ? ` stroke="var(--ink)" stroke-width="1"` : ""}><title>${esc(qLabel(h.startDate))}: ${pct(Math.min(100, h.fillPct))}${h.exhausted ? `, ran out day ${h.dayFull}` : ""}${h.current ? " (so far)" : ""} · ${h.regime}</title></rect>${day}${lbl}`;
    }).join("");
    const firstMeasure = hs.findIndex((h) => h.regime === "measure");
    const sep = firstMeasure > 0 ? `<line x1="${L + firstMeasure * (bw + gap) - gap / 2}" x2="${L + firstMeasure * (bw + gap) - gap / 2}" y1="${T - 6}" y2="${H - B}" stroke="var(--ink)" stroke-dasharray="3 3"/><text x="${L + firstMeasure * (bw + gap) + 2}" y="${T - 2}" class="qp-axis">Measure</text>` : "";
    return svgBox(`<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">${grid}${bars}${sep}</svg>`, `Fill by quarter, last ${hs.length} quarters`);
  }

  function seasonCard(l) {
    return el("div", { class: "qp-seasons" }, ...l.seasons.map((s) => el("div", { class: "qp-season" },
      el("span", { text: s.label }),
      el("div", { class: "qp-sbar" }, el("i", { style: `height:${Math.max(4, Math.min(100, s.avgFillPct || 0))}%`, class: s.ranOut ? "is-out" : "" })),
      el("strong", { text: pct(s.avgFillPct) }),
      el("small", { text: s.periods ? `${s.ranOut}/${s.periods} ran out` : "—" }))));
  }

  function render(r) {
    const l = r.line, o = l.outlook, live = r.live;
    $("qp-title").textContent = `${l.categoryId} · ${l.origin}`;
    $("qp-sub").textContent = `${l.orderNumber} · ${l.categoryName} · ${t(l.annualTonnes)} a year`;
    document.title = `${l.categoryId} ${l.origin} quota · Datafab AGX`;
    const [vl, vc] = o ? VERDICT[o.verdict] || [o.verdict, ""] : ["No data", ""];
    $("qp-verdict").replaceChildren(el("span", { class: `badge ${vc} qp-badge`, text: vl }));
    const risky = o && o.safeUntil && (o.verdict === "full" || o.safeUntil < r.asOf);
    $("qp-root").replaceChildren(
      el("div", { class: "qp-stats" },
        stat("Left now", o ? t(o.leftT) : "—", o && o.leftT <= 0 ? "is-bad" : "", o ? `of ${t(o.initialT)}` : null),
        stat("Pace now", o && o.livePaceT ? `${t(o.livePaceT)}/day` : "—", "", l.paceT ? `past ${t(l.paceT)}/day` : null),
        stat("Fills", o ? (o.fullOn ? `~${fmt.date(o.fullOn)}` : "Lasts") : "—", o && o.fullOn ? "is-bad" : "is-good", o && o.fullDay ? `day ${o.fullDay} of ${o.quarterDays}` : null),
        stat("Safe to import until", risky ? "Risky now" : o && o.safeUntil ? fmt.date(o.safeUntil) : "—", risky ? "is-bad" : ""),
        stat("Next quarter", live && live.nextStartDate ? fmt.date(live.nextStartDate) : "—", "", live && live.nextOpeningT ? t(live.nextOpeningT) : null)),
      card("This quarter", timeline(l, live)),
      el("div", { class: "qp-grid" },
        card("History", historyChart(l.fullHistory)),
        card("Analysis",
          el("dl", { class: "qp-facts" },
            ...[["Quarters of history", String(l.allQuarters || 0)],
              ["Ran out", l.recentQuarters ? `${l.exhaustedCount} of last ${l.recentQuarters}` : "—", l.exhaustedCount ? "is-bad" : ""],
              ["Ran out, all time", l.allQuarters ? `${l.ranOutAll} of ${l.allQuarters}` : "—"],
              ["Average filled", pct(l.avgFillPct)],
              ["Typical full day", l.dayFullMedian ? `day ${Math.round(l.dayFullMedian)}` : "—"],
              ["Earliest / latest full", l.earliestFullDay ? `day ${l.earliestFullDay} / ${l.latestFullDay}` : "—"],
              ["Pace trend", Number.isFinite(l.paceTrendPct) ? `${l.paceTrendPct >= 0 ? "+" : "−"}${Math.abs(Math.round(l.paceTrendPct))}% vs year before` : "—", l.paceTrendPct > 10 ? "is-bad" : ""],
              ["Same quarter last year", l.sameQuarterLastYear ? `${pct(Math.min(100, l.sameQuarterLastYear.fillPct))}${l.sameQuarterLastYear.exhausted ? ` · full day ${l.sameQuarterLastYear.dayFull}` : ""}` : "—"],
              ["Under the new measure", l.sinceMeasure ? `${l.sinceMeasure} quarter${l.sinceMeasure === 1 ? "" : "s"}` : "None yet"]]
              .map(([k, v, cls]) => el("div", {}, el("dt", { text: k }), el("dd", { class: cls || "", text: v })))),
          el("h3", { class: "qp-h3", text: "By time of year" }), seasonCard(l))),
      el("div", { class: "qp-grid" },
        card("Your exposure",
          el("dl", { class: "qp-facts" },
            el("div", {}, el("dt", { text: "Products" }), el("dd", {}, ...(r.products.length ? r.products.map((p, i) => [i ? ", " : "", el("a", { href: `products.html?product=${p.id}`, text: p.name })]).flat() : ["—"]))),
            el("div", {}, el("dt", { text: "Suppliers on this line" }), el("dd", {}, ...(r.suppliers.length ? r.suppliers.map((s, i) => [i ? ", " : "", el("a", { href: `suppliers.html?supplier=${s.id}`, text: s.name })]).flat() : ["—"]))),
            el("div", {}, el("dt", { text: "Saved orders" }), el("dd", { text: String(r.scenarios.length) }))),
          r.scenarios.length ? el("ul", { class: "qp-orders" }, ...r.scenarios.map((s) => el("li", { class: s.afterSafe ? "is-bad" : "" },
            el("a", { href: `order.html?id=${s.id}`, text: s.title }), el("span", { text: `${t(s.tonnage)} · ${fmt.date(s.importDate)}` }), s.afterSafe ? el("span", { class: "badge badge-bad", text: "After safe date" }) : null))) : null),
        card("Quarter by quarter",
          el("div", { class: "table-scroll qp-qtable" }, el("table", { class: "qh-sub" },
            el("thead", {}, el("tr", {}, ...["Quarter", "Scheme", "Opening", "Used", "Filled", "Ran out", "t/day"].map((h, i) => el("th", { class: i > 1 ? "num" : "", text: h })))),
            el("tbody", {}, ...[...l.fullHistory].reverse().map((h) => el("tr", { class: h.current ? "is-now" : "" },
              el("td", { text: `${qLabel(h.startDate)}${h.current ? " · now" : ""}` }), el("td", { text: h.regime === "measure" ? "Measure" : "Safeguard" }),
              el("td", { class: "num", text: t(h.initialT) }), el("td", { class: "num", text: t(h.usedT) }), el("td", { class: "num", text: pct(Math.min(100, h.fillPct)) }),
              el("td", { class: `num${h.exhausted ? " is-bad" : ""}`, text: h.exhausted ? `day ${h.dayFull || "?"}` : h.partlyExhausted ? "Partly" : "—" }),
              el("td", { class: "num", text: t(h.perDayT) })))))))),
      el("p", { class: "qp-src" }, "Source: ", el("a", { href: r.source.url, target: "_blank", rel: "noopener", text: r.source.name }), " · HMRC Trade Tariff (live balance)"));
  }

  if (!/^\d{6}$/.test(order)) { $("qp-root").replaceChildren(el("p", { class: "muted", text: "Pick a quota line on Live quotas." })); return; }
  api(`/api/steel-quotas/line/${order}`).then(render).catch((error) => { $("qp-root").replaceChildren(el("p", { class: "muted", text: `Couldn't load this quota line: ${error.message}` })); });
})();
