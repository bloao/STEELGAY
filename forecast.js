(function () {
  "use strict";
  const { api, fmt, el, toast, loadMe } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let data = null;
  let me = { canEdit: true };
  let months = 3;

  const readCbam = () => { try { return localStorage.getItem("agx-cbam") === "on"; } catch { return false; } };
  const gbpT = (v) => (Number.isFinite(v) ? `£${Math.round(v).toLocaleString("en-GB")}/t` : "—");
  const gbpN = (v) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}£${Math.abs(Math.round(v)).toLocaleString("en-GB")}` : "—");
  const pct = (v, dp = 1) => (Number.isFinite(v) ? `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(dp)}%` : "—");
  const word = (v) => (!Number.isFinite(v) ? "" : v >= 3 ? "Rising" : v >= 0.75 ? "Edging up" : v > -0.75 ? "Flat" : v > -3 ? "Edging down" : "Falling");
  const cls = (v) => (!Number.isFinite(v) || Math.abs(v) < 0.75 ? "is-flat" : v > 0 ? "is-up" : "is-down");
  const monthYear = (iso) => new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  const SIGNAL = { "buy-ahead": ["Buy ahead", "is-go"], consider: ["Worth considering", "is-maybe"], "buy-as-needed": ["Buy as needed", "is-no"] };

  // ---------------------------------------------------------------- outlook
  function renderOutlook() {
    const o = data.outlook, bt = data.backtest.h3;
    const card = (c, label, big, bigCls, text, extra) => el("article", { class: `glance ${c}` }, el("span", { class: "glance-l", text: label }), el("strong", { class: `glance-big ${bigCls}`, text: big }), el("p", { class: "glance-t" }, ...[].concat(text)), extra || null);
    const beat = bt.mapePct !== null && bt.naiveMapePct !== null ? bt.mapePct <= bt.naiveMapePct : null;
    $("outlook").replaceChildren(
      card("is-trend", "Next 3 months", `${word(o.in3)} ${pct(o.in3)}`, cls(o.in3) === "is-up" ? "is-up" : cls(o.in3) === "is-down" ? "is-down" : "",
        [`Likely range ${pct(o.band3[0])} to ${pct(o.band3[1])}.`, " Prices for your products are expected to move about the same."],
        el("p", { class: "glance-src", text: `From ${monthYear(data.today)} · ONS UK steel producer prices` })),
      card("is-best", "Next 6 and 12 months", `${pct(o.in6)} · ${pct(o.in12)}`, "",
        [`${word(o.in6)} over six months.`, data.drivers.some((d) => d.kind === "cbam") ? " Includes the UK carbon border charge feeding through from January 2027." : ""],
        el("p", { class: "glance-src", text: "Further out is less certain: the trend is damped each month" })),
      card("is-bench", "How reliable", bt.mapePct === null ? "—" : `±${bt.mapePct.toFixed(1)}%`, "",
        bt.mapePct === null ? "Not enough history to test yet." : [`Average miss three months ahead, over the last ${bt.rows.length} months.`, beat === null ? "" : beat ? " That beats assuming prices stay the same." : ` A plain “no change” guess did a little better (±${bt.naiveMapePct.toFixed(1)}%), so treat it as a guide.`],
        el("p", { class: "glance-src", text: bt.directionPct === null ? "" : `Called the direction right ${Math.round(bt.directionPct)}% of the time` })));
    $("model-asof").textContent = `Latest ONS figure: ${monthYear(data.index.last.date)} · model v${data.modelVersion}`;
    $("model-version").textContent = data.modelVersion;
  }

  // ---------------------------------------------------------------- chart
  function renderChart() {
    const hist = data.index.points.slice(-36);
    const path = data.model.path.slice(0, data.model.offset + 12);
    const base = data.model.base.slice(0, path.length);
    const all = [...hist.map((p) => p.price), ...path.flatMap((p) => [p.low, p.high])];
    let y0 = Math.min(...all), y1 = Math.max(...all);
    const pad = (y1 - y0) * 0.08 || 2; y0 -= pad; y1 += pad;
    const dates = [...hist.map((p) => p.date), ...path.map((p) => p.date)];
    const t = (s) => Date.parse(`${s.slice(0, 7)}-01T00:00:00Z`);
    const x0 = t(dates[0]), x1 = t(dates[dates.length - 1]);
    const W = 960, H = 300, L = 48, R = 18, T = 14, B = 28;
    const X = (s) => L + ((t(s) - x0) / (x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const line = (pts, key) => pts.map((p, i) => `${i ? "L" : "M"}${X(p.date).toFixed(1)},${Y(p[key]).toFixed(1)}`).join(" ");
    const lastH = hist[hist.length - 1];
    const join = { date: lastH.date, mid: lastH.price, low: lastH.price, high: lastH.price };
    const fan = [join, ...path];
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="ONS UK steel price index with forecast">`;
    for (let i = 0; i <= 4; i++) { const g = y0 + ((y1 - y0) * i) / 4; svg += `<line x1="${L}" x2="${W - R}" y1="${Y(g).toFixed(1)}" y2="${Y(g).toFixed(1)}" class="mk-grid"/><text x="${L - 6}" y="${(Y(g) + 4).toFixed(1)}" class="mk-axis" text-anchor="end">${g.toFixed(0)}</text>`; }
    // year ticks
    for (const d of dates.filter((s) => s.slice(5, 7) === "01")) svg += `<text x="${X(d).toFixed(1)}" y="${H - 8}" class="mk-axis" text-anchor="middle">${d.slice(0, 4)}</text><line x1="${X(d).toFixed(1)}" x2="${X(d).toFixed(1)}" y1="${T}" y2="${H - B}" class="mk-grid" stroke-dasharray="2 4"/>`;
    // band
    svg += `<path d="${line(fan, "high")} ${[...fan].reverse().map((p) => `L${X(p.date).toFixed(1)},${Y(p.low).toFixed(1)}`).join(" ")} Z" class="fc-band"/>`;
    svg += `<path d="${line([join, ...base.map((p) => ({ ...p }))], "mid")}" class="fc-base"/>`;
    svg += `<path d="${line(hist, "price")}" class="fc-hist" pathLength="1"/>`;
    svg += `<path d="${line(fan, "mid")}" class="fc-mid"/>`;
    // today marker
    const today = data.today;
    if (t(today) <= x1) svg += `<line x1="${X(today).toFixed(1)}" x2="${X(today).toFixed(1)}" y1="${T}" y2="${H - B}" class="fc-today"/><text x="${(X(today) + 5).toFixed(1)}" y="${T + 10}" class="mk-label">Today</text>`;
    const cb = data.drivers.find((d) => d.kind === "cbam");
    if (cb && t(cb.from) <= x1) svg += `<line x1="${X(cb.from).toFixed(1)}" x2="${X(cb.from).toFixed(1)}" y1="${T + 16}" y2="${H - B}" class="fc-event"/><text x="${(X(cb.from) + 5).toFixed(1)}" y="${T + 26}" class="mk-label fc-event-l">UK CBAM</text>`;
    svg += `<circle cx="${X(lastH.date).toFixed(1)}" cy="${Y(lastH.price).toFixed(1)}" r="4" fill="#2a78d6" stroke="var(--surface)" stroke-width="2"/>`;
    svg += `<rect class="mk-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/><line class="mk-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/></svg>`;
    const wrap = el("div", { class: "mk-plot" }); wrap.innerHTML = svg;
    const tip = el("div", { class: "mk-tip", hidden: "" }); wrap.append(tip);
    const legend = el("div", { class: "mk-legend" },
      el("span", { class: "mk-key" }, el("span", { class: "swatch", style: "background:#2a78d6" }), "ONS index (actual)"),
      el("span", { class: "mk-key" }, el("span", { class: "swatch is-dashed", style: "background:#6250d6" }), "Forecast"),
      el("span", { class: "mk-key" }, el("span", { class: "swatch fc-band-key" }), "Likely range (80%)"),
      data.drivers.length ? el("span", { class: "mk-key" }, el("span", { class: "swatch is-dashed", style: "background:#a8adb5" }), "Without CBAM and team insight") : null);
    $("fc-chart").replaceChildren(legend, wrap);
    $("chart-sub").textContent = "Index, 2015 = 100. The shaded area is where prices should land four times out of five if the next months behave like the last two years.";
    const svgEl = wrap.querySelector("svg"), cross = wrap.querySelector(".mk-cross");
    const pts = [...hist.map((p) => ({ date: p.date, v: p.price, kind: "Actual" })), ...path.map((p) => ({ date: p.date, v: p.mid, low: p.low, high: p.high, kind: "Forecast" }))];
    svgEl.addEventListener("pointermove", (evt) => {
      const r = svgEl.getBoundingClientRect();
      const sx = ((evt.clientX - r.left) / r.width) * W;
      const near = pts.reduce((a, b) => (Math.abs(X(b.date) - sx) < Math.abs(X(a.date) - sx) ? b : a), pts[0]);
      cross.setAttribute("x1", X(near.date)); cross.setAttribute("x2", X(near.date)); cross.setAttribute("visibility", "visible");
      const chg = ((near.v / data.model.indexNow) - 1) * 100;
      tip.replaceChildren(el("strong", { text: monthYear(near.date) }), el("div", { class: "mk-tip-row" }, el("span", { text: near.kind }), el("b", { text: near.v.toFixed(1) })),
        near.low ? el("div", { class: "mk-tip-row" }, el("span", { text: "Range" }), el("b", { text: `${near.low.toFixed(1)}–${near.high.toFixed(1)}` })) : null,
        el("div", { class: "mk-tip-row" }, el("span", { text: "vs today" }), el("b", { text: pct(chg) })));
      tip.hidden = false;
      tip.style.left = `${Math.min(Math.max((X(near.date) / W) * r.width + 12, 0), r.width - 200)}px`;
    });
    svgEl.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
  }

  // ---------------------------------------------------------------- opportunities
  function renderOpps() {
    const rows = data.products;
    $("opp-sub").textContent = `If you bought ${months} month${months === 1 ? "" : "s"} of usage now at today's best landed price, instead of month by month. The net figure is the forecast saving minus the cost of holding the stock (${data.costOfCapitalPct}% cost of capital and £${data.settings.storagePerTMonth}/t a month storage).`;
    const pill = $("cbam-pill"); const on = readCbam();
    pill.classList.toggle("is-on", on); pill.setAttribute("aria-checked", String(on));
    if (!rows.length) { $("opps").replaceChildren(el("div", { class: "empty-state" }, el("h3", { text: "No products yet" }), el("p", { text: "Add products to see where buying ahead pays." }))); return; }
    const sorted = [...rows].sort((a, b) => ((b.buyAhead && b.buyAhead.netMid) || -1e9) - ((a.buyAhead && a.buyAhead.netMid) || -1e9));
    $("opps").replaceChildren(el("div", { class: "table-scroll" }, el("table", { class: "quota-table opp-table" },
      el("thead", {}, el("tr", {}, el("th", { text: "Product" }), el("th", { class: "num", text: "Stock" }), el("th", { class: "num", text: "Best price now" }), el("th", { class: "num", text: "In 3 months" }), el("th", { class: "num", text: `Buy ${months} mo ahead` }), el("th", { text: "Signal" }))),
      el("tbody", {}, ...sorted.map((r, i) => {
        const b = r.buyAhead;
        const [sl, sc] = b ? SIGNAL[b.signal] : ["No usage set", "is-no"];
        return el("tr", { style: `--d:${i * 50}ms`, class: "opp-row" },
          el("td", {}, el("a", { href: `products.html?product=${r.id}`, class: "sup-link", text: r.name }), el("div", { class: "row-sub", text: `${r.monthlyUsageT} t a month` })),
          el("td", { class: "num" }, el("strong", { text: `${Math.round(r.stockT)} t` }), el("div", { class: "row-sub", text: Number.isFinite(r.coverMonths) ? `${r.coverMonths.toFixed(1)} mo cover` : "" })),
          el("td", { class: "num" }, el("strong", { text: gbpT(r.priceNow) }), el("div", { class: "row-sub", text: r.priceSource })),
          el("td", { class: "num" }, el("strong", { class: r.in3 ? cls(((r.in3.mid / r.priceNow) - 1) * 100) : "", text: r.in3 ? gbpT(r.in3.mid) : "—" }), el("div", { class: "row-sub", text: r.in3 ? `${gbpT(r.in3.low).replace("/t", "")}–${gbpT(r.in3.high)}` : "" })),
          el("td", { class: "num" }, el("strong", { class: b ? (b.netMid > 0 ? "is-down" : "is-up") : "", text: b ? gbpN(b.netMid) : "—" }), el("div", { class: "row-sub", text: b ? `${Math.round(b.tonnes)} t · range ${gbpN(b.netLow)} to ${gbpN(b.netHigh)}` : "" })),
          el("td", {}, el("span", { class: `sig ${sc}`, text: sl }), b && b.signal !== "buy-as-needed" && r.suggestedOrderT ? el("div", { class: "row-sub", text: `ordering ${r.suggestedOrderT} t anyway` }) : null));
      })))),
      el("p", { class: "lad-note", text: "Buy ahead means saving even at the low end of the range. Worth considering means saving on the central forecast but not guaranteed. Buy as needed means holding costs outweigh the expected rise. Quota and cash limits aren't included, so check those before committing." }));
  }

  // ---------------------------------------------------------------- drivers & assumptions
  function renderDrivers() {
    const m = data.model;
    const item = (dir, title, value, text) => el("li", { class: `drv is-${dir}` }, el("span", { class: `drv-dot is-${dir}`, "aria-hidden": "true" }),
      el("div", { class: "drv-main" }, el("div", { class: "drv-head" }, el("strong", { text: title }), el("b", { text: value })), el("p", { text: text })));
    const dir = (v) => (Math.abs(v) < 0.05 ? "flat" : v > 0 ? "up" : "down");
    const list = [
      item(dir(m.trendPerMonthPct), "12-month trend", `${pct(m.trendPerMonthPct, 2)} a month`, "The underlying direction of the ONS index over the past year."),
      item(dir(m.momentumPerMonthPct), "Recent momentum", `${pct(m.momentumPerMonthPct, 2)} a month`, "How fast prices moved over the last three months. The forecast blends this with the trend, then fades it out the further ahead it looks."),
      item("flat", "Normal ups and downs", `±${m.volatilityPct.toFixed(1)}% a month`, "How much the index typically moves in a month. It sets how wide the likely range is."),
      ...data.drivers.map((d) => d.kind === "cbam"
        ? item("up", "UK CBAM from January 2027", pct(d.pct), `Imports pick up about £${Math.round(d.costPerT)}/t of carbon charge. The model assumes UK prices absorb ${d.passThroughPct}% of that, phased in over three months.`)
        : item(d.pct > 0 ? "up" : "down", d.label, pct(d.pct), `Market intel${d.scope === "group" ? ` for ${d.targetId}` : ""} from ${fmt.date(d.date)}${d.by ? ` (${d.by})` : ""}, built in over ${d.rampMonths} month${d.rampMonths === 1 ? "" : "s"}.`)),
    ];
    if (!data.drivers.some((d) => d.kind === "insight")) list.push(el("li", { class: "drv-empty" }, "No team insight in the forecast yet. ", el("button", { type: "button", class: "link-btn", text: "Log market intel →", onclick: () => window.MarketIntel && window.MarketIntel.open({ scope: "market" }) })));
    $("drivers").replaceChildren(...list);
    const s = data.settings;
    $("assume").replaceChildren(
      el("span", { text: `CBAM passed into UK prices ${s.cbamPassThroughPct}%` }),
      el("span", { text: `Storage £${s.storagePerTMonth}/t a month` }),
      el("a", { href: "assumptions.html", text: "Assumptions →" }));
  }

  function renderBacktest() {
    const b = data.backtest.h3;
    if (!b.rows.length) { $("backtest").replaceChildren(el("p", { class: "muted", text: "Needs a little more history to test." })); return; }
    const W = 520, H = 150, L = 8, R = 8, T = 10, B = 22;
    const vals = b.rows.flatMap((r) => [r.actual, r.low, r.high]);
    const y0 = Math.min(...vals) - 1, y1 = Math.max(...vals) + 1;
    const X = (i) => L + (i / Math.max(1, b.rows.length - 1)) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Past three-month forecasts against what happened">`;
    b.rows.forEach((r, i) => {
      svg += `<line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${Y(r.high).toFixed(1)}" y2="${Y(r.low).toFixed(1)}" class="bt-range"/>`;
      svg += `<circle cx="${X(i).toFixed(1)}" cy="${Y(r.forecast).toFixed(1)}" r="3.5" class="bt-fc"><title>Forecast for ${monthYear(r.to)}: ${r.forecast.toFixed(1)}</title></circle>`;
      svg += `<rect x="${(X(i) - 4).toFixed(1)}" y="${(Y(r.actual) - 4).toFixed(1)}" width="8" height="8" rx="2" class="bt-act ${r.inBand ? "" : "is-out"}"><title>Actual ${monthYear(r.to)}: ${r.actual.toFixed(1)}</title></rect>`;
    });
    svg += `<text x="${L}" y="${H - 6}" class="mk-axis">${monthYear(b.rows[0].to)}</text><text x="${W - R}" y="${H - 6}" class="mk-axis" text-anchor="end">${monthYear(b.rows[b.rows.length - 1].to)}</text></svg>`;
    const plot = el("div", { class: "bt-plot" }); plot.innerHTML = svg;
    const h6 = data.backtest.h6;
    $("backtest").replaceChildren(
      el("div", { class: "bt-stats" },
        el("div", {}, el("span", { text: "3 months ahead" }), el("strong", { text: `±${b.mapePct.toFixed(1)}%` }), el("small", { text: `no-change guess ±${b.naiveMapePct.toFixed(1)}%` })),
        el("div", {}, el("span", { text: "Inside the range" }), el("strong", { text: `${Math.round(b.inBandPct)}%` }), el("small", { text: "aim is about 80%" })),
        h6.mapePct !== null ? el("div", {}, el("span", { text: "6 months ahead" }), el("strong", { text: `±${h6.mapePct.toFixed(1)}%` }), el("small", { text: `no-change guess ±${h6.naiveMapePct.toFixed(1)}%` })) : null),
      el("div", { class: "mk-legend" }, el("span", { class: "mk-key" }, el("span", { class: "bt-key-fc" }), "Forecast, with range"), el("span", { class: "mk-key" }, el("span", { class: "swatch is-quote" }), "What happened"), el("span", { class: "mk-key" }, el("span", { class: "bt-key-out" }), "Outside the range")),
      plot,
      el("p", { class: "lad-note", text: "The model improves as more history and team insight build up. Logging what you hear, and when, makes it sharper." }));
  }

  async function load() {
    try {
      data = await api("/api/forecast", { method: "POST", body: { months, cbam: readCbam() } });
      if (!data.ok) {
        $("outlook").replaceChildren(el("div", { class: "pulse-empty" }, el("span", { class: "spinner sm", "aria-hidden": "true" }), el("span", { text: data.error })));
        setTimeout(load, 20_000);
        return;
      }
      renderOutlook(); renderChart(); renderOpps(); renderDrivers(); renderBacktest();
    } catch (error) {
      $("outlook").replaceChildren(el("p", { class: "muted", text: `Couldn't run the forecast: ${error.message}` }));
    }
  }

  $("months").addEventListener("change", (e) => { months = Number(e.target.value); load(); });
  $("cbam-pill").addEventListener("click", () => { try { localStorage.setItem("agx-cbam", readCbam() ? "off" : "on"); } catch { /* blocked */ } load(); });
  loadMe().then((m) => { me = m; if (data && data.ok) renderDrivers(); }).catch(() => {});
  if (window.EventSource) {
    const es = new EventSource((window.OrderTool.apiBase || "") + "/api/benchmarks/events", { withCredentials: Boolean(window.OrderTool.apiBase) });
    ["prices", "news", "quotes"].forEach((ev) => es.addEventListener(ev, () => load()));
  }
  load();
})();
