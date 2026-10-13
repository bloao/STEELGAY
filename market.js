(function () {
  "use strict";
  const { api, fmt, el, toast, loadMe } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  const drawer = $("drawer");
  const form = $("view-form");
  const field = (n) => form.elements.namedItem(n);
  const SYM = { GBP: "£", EUR: "€", USD: "$" };
  // Categorical slots, fixed order (reference palette, light mode).
  const SERIES_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
  const XLSX_URL = "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js";

  let data = null;
  let me = { canEdit: true };
  let group = null;
  let rangeDays = 365;
  let mode = null;
  let detailId = null;
  let lastFocus = null;
  let dirty = false;

  const money = (v, cur = "GBP") => (Number.isFinite(v) ? `${SYM[cur] || ""}${Math.round(v).toLocaleString("en-GB")}` : "—");
  const perT = (v, cur) => (Number.isFinite(v) ? `${money(v, cur)}/t` : "—");
  const signed = (v) => `${v < 0 ? "−" : "+"}${money(Math.abs(v))}`;
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const gbp = (price, cur) => (data && data.fx[cur || "GBP"] ? price * data.fx[cur || "GBP"] : null);
  const allSeries = () => (data ? [...data.series, ...data.competition] : []);
  const groupSeries = () => allSeries().filter((s) => s.group === group);
  // Colours follow the series, assigned in a fixed order per product group:
  // outside sources first (by name), then the competition series.
  let colorMap = new Map();
  function assignColors() {
    colorMap = new Map();
    const groups = [...new Set(allSeries().map((x) => x.group))];
    for (const g of groups) {
      const list = allSeries().filter((x) => x.group === g).sort((a, b) => Number(Boolean(a.computed)) - Number(Boolean(b.computed)) || a.name.localeCompare(b.name));
      list.forEach((x, i) => colorMap.set(x.id, SERIES_COLORS[Math.min(i, SERIES_COLORS.length - 1)]));
    }
  }
  const colorOf = (id) => colorMap.get(id) || "#8a8f98";
  const ago = (iso) => { if (!iso) return "—"; const d = Math.round((Date.parse(todayIso()) - Date.parse(iso)) / 86_400_000); return d <= 0 ? "today" : d === 1 ? "yesterday" : d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`; };
  const chev = () => { const td = el("td", { class: "chev", "aria-hidden": "true" }); td.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>'; return td; };

  // ---------------------------------------------------------------- feeds
  function renderFeeds() {
    const quoteCount = data.suppliers.reduce((n, s) => n + s.quotes.length, 0);
    const show = data.feeds.filter((f) => ["MEPS", "Kallanish", "Market intel"].includes(f.source) || f.series || (f.feed && f.feed.configured));
    const cards = show.map((f) => {
      const live = f.feed && f.feed.configured;
      const status = f.lastDate
        ? [`Latest price ${fmt.date(f.lastDate)}`, Date.parse(todayIso()) - Date.parse(f.lastDate) > 45 * 86_400_000 ? "is-warn" : "is-good"]
        : ["No prices yet", "is-muted"];
      const run = live ? el("button", { class: "btn btn-sm", type: "button", text: "Fetch now", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { const r = await api(`/api/benchmarks/feeds/${encodeURIComponent(f.source)}/run`, { method: "POST" }); toast(r.ok ? `${f.source}: ${r.added} new prices` : `${f.source}: ${r.error}`, !r.ok); await load(); } catch (error) { toast(error.message, true); }
      } }) : null;
      return el("article", { class: "feed-card" },
        el("div", { class: "feed-head" },
          el("strong", { text: f.label }),
          f.url ? el("a", { href: f.url, target: "_blank", rel: "noopener", class: "small", text: "Website ↗" }) : null),
        el("span", { class: `feed-status ${status[1]}`, text: status[0] }),
        el("p", { class: "feed-meta", text: `${f.series} series · ${f.points} prices${live ? " · API feed connected" : ""}` }),
        f.feed && f.feed.lastRun ? el("p", { class: `feed-meta ${f.feed.lastRun.ok ? "" : "is-bad"}`, text: f.feed.lastRun.ok ? `Last fetch ${fmt.dateTime(f.feed.lastRun.at)}: ${f.feed.lastRun.added} new` : `Last fetch failed: ${f.feed.lastRun.error}` }) : null,
        el("p", { class: "feed-how", text: live ? "Fetched automatically every 6 hours." : f.method }),
        me.canEdit ? el("div", { class: "feed-actions" },
          f.source === "Market intel"
            ? el("button", { class: "btn btn-sm", type: "button", text: "Add price", onclick: () => openAddPrice({ source: "Market intel" }) })
            : el("button", { class: "btn btn-sm", type: "button", text: "Upload export", onclick: () => openImport({ source: f.source }) }),
          run) : null);
    });
    cards.push(el("article", { class: "feed-card is-auto" },
      el("div", { class: "feed-head" }, el("strong", { text: "Competition (UK & imports)" })),
      el("span", { class: "feed-status is-good", text: "Automatic" }),
      el("p", { class: "feed-meta", text: `${data.competition.length} series · from ${quoteCount} logged quote${quoteCount === 1 ? "" : "s"}` }),
      el("p", { class: "feed-how", text: "Average of your UK and import suppliers' latest quotes — updates whenever you log a quote." }),
      el("div", { class: "feed-actions" }, el("a", { class: "btn btn-sm", href: "suppliers.html", text: "Log a quote" }))));
    $("feeds").replaceChildren(...cards);
  }

  // ---------------------------------------------------------------- groups
  function renderGroups() {
    const groups = data.groups.length ? data.groups : ["Merchant Bar"];
    if (!group || !groups.includes(group)) group = groups[0];
    $("group-tabs").replaceChildren(...groups.map((g) => el("button", {
      type: "button", role: "tab", class: "group-tab", "aria-selected": String(g === group),
      onclick: () => { group = g; renderGroups(); renderCompare(); renderChart(); },
    }, g, el("span", { class: "count", text: allSeries().filter((s) => s.group === g).length }))));
    $("group-tabs").hidden = groups.length < 2;
  }

  // ---------------------------------------------------------------- comparison
  function renderCompare() {
    const series = groupSeries();
    const suppliers = data.suppliers.filter((s) => s.supplies.includes(group) && Number.isFinite(s.metrics.pricePerT))
      .sort((a, b) => gbp(a.metrics.pricePerT, a.metrics.currency) - gbp(b.metrics.pricePerT, b.metrics.currency));
    const external = series.filter((s) => !s.computed);
    $("cmp-sub").textContent = `${group} · each supplier's latest quote against the latest price in each series${external.length ? "" : " — add MEPS or Kallanish prices for an outside view"}`;
    if (!suppliers.length) { $("cmp").replaceChildren(el("div", { class: "empty-state" }, el("h3", { text: "No supplier quotes for this group" }), el("p", { text: "Log quotes on the Suppliers page." }))); return; }
    const cols = series.filter((s) => s.latest);
    const head = el("tr", {}, el("th", { text: "Supplier" }), el("th", { class: "num", text: "Quoted" }),
      ...cols.map((s) => el("th", { class: "num bench-head" },
        el("span", { class: "bench-name" }, el("span", { class: "swatch", style: `background:${colorOf(s.id)}`, "aria-hidden": "true" }), s.computed ? s.source : s.name),
        el("span", { class: "bench-val", text: `${Number.isFinite(gbp(s.latest.price, s.currency)) ? perT(gbp(s.latest.price, s.currency)) : `${perT(s.latest.price, s.currency)} (no FX rate)`} · ${fmt.date(s.latest.date)}` }))),
      external.length ? null : el("th", { class: "bench-head is-empty" }, el("span", { class: "bench-name", text: "MEPS / Kallanish" }), el("span", { class: "bench-val", text: "no prices yet" })));
    const rows = suppliers.map((sup) => {
      const q = gbp(sup.metrics.pricePerT, sup.metrics.currency);
      return el("tr", {},
        el("td", {}, el("a", { href: `suppliers.html?supplier=${sup.id}`, class: "sup-link", text: sup.name }), el("div", { class: "row-sub", text: `${sup.origin || "origin?"} · ${({ everything: "all-in", "except-duty": "+ duty" })[sup.metrics.covers] || ""}` })),
        el("td", { class: "num" }, el("strong", { text: perT(q) })),
        ...cols.map((s) => {
          const b = gbp(s.latest.price, s.currency);
          if (!Number.isFinite(b)) return el("td", { class: "num", text: "—" });
          const diff = q - b;
          const pct = (diff / b) * 100;
          const cls = Math.abs(pct) < 0.5 ? "is-flat" : diff > 0 ? "is-above" : "is-below";
          return el("td", { class: `num diff ${cls}`, title: `${sup.name} ${perT(q)} vs ${s.name} ${perT(b)}` },
            el("strong", { text: Math.abs(pct) < 0.5 ? "In line" : `${signed(diff)}` }), el("div", { class: "row-sub", text: `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%` }));
        }),
        external.length ? null : el("td", { class: "num muted", text: "—" }));
    });
    $("cmp").replaceChildren(
      el("div", { class: "table-scroll" }, el("table", { class: "quota-table cmp-table" }, el("thead", {}, head), el("tbody", {}, ...rows))),
      el("p", { class: "small muted", style: "margin:10px 0 0", text: "Green = below the benchmark, amber = above. Check the basis matches (delivered vs ex-works, duty paid vs not) before reading too much into small gaps." }));
  }

  // ---------------------------------------------------------------- chart
  function renderChart() {
    const box = $("chart");
    const series = groupSeries().filter((s) => s.points && s.points.length);
    const from = rangeDays ? new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 10) : "0000";
    const quotes = data.suppliers.filter((s) => s.supplies.includes(group)).flatMap((s) => s.quotes.map((q) => ({ ...q, supplier: s.name, gbp: gbp(q.pricePerT, q.currency) }))).filter((q) => q.date >= from && Number.isFinite(q.gbp));
    const lines = series.map((s) => ({ s, pts: s.points.filter((p) => p.date >= from).map((p) => ({ date: p.date, v: gbp(p.price, s.currency) })).filter((p) => Number.isFinite(p.v)) })).filter((l) => l.pts.length);
    if (!lines.length && !quotes.length) { box.replaceChildren(el("div", { class: "empty-state" }, el("h3", { text: "Nothing to chart yet" }), el("p", { text: "Import MEPS or Kallanish prices, or log supplier quotes." }))); return; }
    const all = [...lines.flatMap((l) => l.pts), ...quotes.map((q) => ({ date: q.date, v: q.gbp }))];
    const t = (d) => Date.parse(`${d}T00:00:00Z`);
    let x0 = Math.min(...all.map((p) => t(p.date))), x1 = Math.max(...all.map((p) => t(p.date)));
    if (x0 === x1) { x0 -= 15 * 86_400_000; x1 += 15 * 86_400_000; }
    let y0 = Math.min(...all.map((p) => p.v)), y1 = Math.max(...all.map((p) => p.v));
    const pad = Math.max((y1 - y0) * 0.12, 15);
    y0 = Math.floor((y0 - pad) / 10) * 10; y1 = Math.ceil((y1 + pad) / 10) * 10;
    const W = 900, H = 280, L = 56, R = 120, T = 12, B = 30;
    const X = (d) => L + ((t(d) - x0) / (x1 - x0)) * (W - L - R);
    const Y = (v) => T + (1 - (v - y0) / (y1 - y0)) * (H - T - B);
    const ticksY = 4;
    const grid = Array.from({ length: ticksY + 1 }, (_, i) => y0 + ((y1 - y0) * i) / ticksY);
    const months = [];
    const d = new Date(x0); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + 1);
    const stepM = (x1 - x0) / 86_400_000 > 240 ? 2 : 1;
    while (d.getTime() <= x1) { months.push(new Date(d)); d.setUTCMonth(d.getUTCMonth() + stepM); }
    const fmtM = (dt) => dt.toLocaleDateString("en-GB", { month: "short", year: "2-digit", timeZone: "UTC" });
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Price history for ${group}">`;
    svg += grid.map((g) => `<line x1="${L}" x2="${W - R}" y1="${Y(g).toFixed(1)}" y2="${Y(g).toFixed(1)}" class="mk-grid"/><text x="${L - 8}" y="${(Y(g) + 4).toFixed(1)}" class="mk-axis" text-anchor="end">£${Math.round(g)}</text>`).join("");
    svg += months.map((m) => `<text x="${X(m.toISOString().slice(0, 10)).toFixed(1)}" y="${H - 8}" class="mk-axis" text-anchor="middle">${fmtM(m)}</text>`).join("");
    const labels = [];
    for (const l of lines) {
      const c = colorOf(l.s.id);
      const path = l.pts.map((p, i) => `${i ? "L" : "M"}${X(p.date).toFixed(1)},${Y(p.v).toFixed(1)}`).join(" ");
      svg += `<path d="${path}" fill="none" stroke="${c}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${l.s.computed ? ' stroke-dasharray="5 4"' : ""}/>`;
      if (l.pts.length <= 30) svg += l.pts.map((p) => `<circle cx="${X(p.date).toFixed(1)}" cy="${Y(p.v).toFixed(1)}" r="4" fill="${c}" stroke="var(--surface)" stroke-width="2"/>`).join("");
      const last = l.pts[l.pts.length - 1];
      labels.push({ y: Y(last.v), text: l.s.computed ? l.s.source.replace("Competition – ", "Comp. ") : l.s.name, c, x: X(last.date) });
    }
    // direct labels at line ends, nudged apart (only when few series)
    if (labels.length <= 4) {
      labels.sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
      svg += labels.map((lb) => `<text x="${(lb.x + 8).toFixed(1)}" y="${(lb.y + 4).toFixed(1)}" class="mk-label">${lb.text.length > 18 ? `${lb.text.slice(0, 17)}…` : lb.text}</text>`).join("");
    }
    svg += quotes.map((q) => `<rect x="${(X(q.date) - 4).toFixed(1)}" y="${(Y(q.gbp) - 4).toFixed(1)}" width="8" height="8" rx="2" class="mk-quote"/>`).join("");
    svg += `<line class="mk-cross" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/><rect class="mk-hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
    const legend = el("div", { class: "mk-legend" },
      ...lines.map((l) => el("span", { class: "mk-key" }, el("span", { class: `swatch${l.s.computed ? " is-dashed" : ""}`, style: `background:${colorOf(l.s.id)}` }), l.s.computed ? l.s.source : `${l.s.name} (${l.s.source})`)),
      quotes.length ? el("span", { class: "mk-key" }, el("span", { class: "swatch is-quote" }), "Supplier quotes") : null);
    const wrap = el("div", { class: "mk-plot" });
    wrap.innerHTML = svg;
    const tip = el("div", { class: "mk-tip", hidden: "" });
    wrap.append(tip);
    box.replaceChildren(legend, wrap);
    // hover: snap to nearest date
    const dates = [...new Set(all.map((p) => p.date))].sort();
    const svgEl = wrap.querySelector("svg"), cross = wrap.querySelector(".mk-cross");
    const show = (evt) => {
      const r = svgEl.getBoundingClientRect();
      const sx = ((evt.clientX - r.left) / r.width) * W;
      const target = x0 + ((sx - L) / (W - L - R)) * (x1 - x0);
      const near = dates.reduce((a, b) => (Math.abs(t(b) - target) < Math.abs(t(a) - target) ? b : a), dates[0]);
      const xs = X(near);
      cross.setAttribute("x1", xs); cross.setAttribute("x2", xs); cross.setAttribute("visibility", "visible");
      const items = [
        ...lines.map((l) => { const p = [...l.pts].reverse().find((p) => p.date <= near); return p ? { c: colorOf(l.s.id), name: l.s.computed ? l.s.source : l.s.name, v: p.v, exact: p.date === near } : null; }).filter(Boolean),
        ...quotes.filter((q) => q.date === near).map((q) => ({ c: "var(--ink)", name: q.supplier, v: q.gbp, exact: true, quote: true })),
      ];
      tip.replaceChildren(el("strong", { text: fmt.date(near) }), ...items.map((i) => el("div", { class: "mk-tip-row" }, el("span", { class: `swatch${i.quote ? " is-quote" : ""}`, style: i.quote ? "" : `background:${i.c}` }), el("span", { text: i.name }), el("b", { text: `${perT(i.v)}${i.exact ? "" : "*"}` }))));
      tip.hidden = false;
      const px = (xs / W) * r.width;
      tip.style.left = `${Math.min(Math.max(px + 12, 0), r.width - 220)}px`;
    };
    svgEl.addEventListener("pointermove", show);
    svgEl.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
  }

  // ---------------------------------------------------------------- series table
  function renderSeries() {
    const list = [...data.series].sort((a, b) => a.group.localeCompare(b.group) || a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
    $("series-count").textContent = `${list.length} series`;
    if (!list.length) {
      $("series-rows").replaceChildren(el("tr", {}, el("td", { colspan: "7", class: "empty" },
        el("span", {}, "No market price series yet. "), me.canEdit ? el("button", { class: "btn btn-primary btn-sm", type: "button", style: "margin-left:8px", text: "Import prices", onclick: () => openImport({}) }) : null)));
      return;
    }
    $("series-rows").replaceChildren(...list.map((s) => {
      const l = s.latest;
      return el("tr", { class: "product-row", tabindex: "0", onclick: () => openSeries(s.id), onkeydown: (e) => { if (e.key === "Enter") openSeries(s.id); } },
        el("td", {}, el("div", { class: "p-name" }, el("span", { class: "swatch", style: `background:${colorOf(s.id)};margin-right:8px` }), s.name), el("div", { class: "p-meta" }, el("span", { text: s.group }), s.region ? el("span", { text: s.region }) : null, s.basis ? el("span", { text: s.basis }) : null)),
        el("td", { text: s.source }),
        el("td", { class: "num" }, el("strong", { text: l ? perT(l.price, s.currency) : "—" })),
        el("td", { class: `num ${l && l.change ? (l.change > 0 ? "is-up-txt" : "is-down-txt") : ""}`, text: l && l.change !== null ? `${l.change > 0 ? "▲" : l.change < 0 ? "▼" : ""} ${money(Math.abs(l.change), s.currency)}` : "—" }),
        el("td", { text: l ? ago(l.date) : "—" }),
        el("td", { class: "num", text: (s.points || []).length }),
        chev());
    }));
  }

  // ---------------------------------------------------------------- drawer
  function showDrawer(newMode, title, eyebrow) {
    mode = newMode;
    if (drawer.hidden) lastFocus = document.activeElement;
    $("drawer-title").textContent = title;
    $("drawer-eyebrow").textContent = eyebrow || "";
    $("drawer-avatar").hidden = true;
    $("drawer-tags").hidden = true;
    $("profile-tabs").hidden = true;
    $("view-detail").hidden = newMode !== "detail";
    form.hidden = newMode === "detail";
    drawer.hidden = false;
    $("backdrop").hidden = false;
    document.body.classList.add("drawer-open");
    dirty = false;
  }
  function closeDrawer(force) {
    if (!force && mode !== "detail" && dirty) {
      const b = $("drawer-foot").querySelector("[data-cancel]");
      if (b && !b.dataset.confirm) { b.dataset.confirm = "1"; b.textContent = "Discard changes?"; b.classList.add("btn-danger"); b.focus(); return; }
    }
    drawer.hidden = true; $("backdrop").hidden = true; document.body.classList.remove("drawer-open"); mode = null; dirty = false;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  const footer = (...n) => $("drawer-foot").replaceChildren(...n.filter(Boolean));
  const cancelBtn = (fn) => el("button", { class: "btn", type: "button", "data-cancel": "", text: "Cancel", onclick: fn || (() => closeDrawer()) });
  const fieldWrap = (name, label, control, hint) => el("div", { class: "field", "data-field": name }, el("label", { for: `f-${name}`, text: label }), control, hint ? el("span", { class: "hint", text: hint }) : null, el("span", { class: "error" }));
  const select = (name, opts, value, empty) => {
    const s = el("select", { id: `f-${name}`, name }, ...(empty !== undefined ? [el("option", { value: "", text: empty })] : []), ...opts.map((o) => (Array.isArray(o) ? el("option", { value: o[0], text: o[1] }) : el("option", { value: o, text: o }))));
    s.value = value ?? "";
    return s;
  };
  function showErrors(errors = {}) {
    form.querySelectorAll("[data-field]").forEach((f) => { const m = errors[f.dataset.field]; f.classList.toggle("has-error", Boolean(m)); const e = f.querySelector(":scope > .error"); if (e) e.textContent = m || ""; });
  }
  function seriesFields(v = {}) {
    const c = data.choices;
    return [
      fieldWrap("name", "Series name", el("input", { id: "f-name", name: "name", value: v.name || "", maxlength: "120", placeholder: "e.g. UK merchant bar, delivered" })),
      el("div", { class: "grid-2" },
        fieldWrap("source", "Source", select("source", c.sources, v.source || "", "Choose")),
        fieldWrap("group", "Benchmarks", select("group", c.groups, v.group || group || "", "Choose product group")),
        fieldWrap("region", "Region", select("region", c.regions, v.region || "", "Not set")),
        fieldWrap("basis", "Price basis", select("basis", c.bases, v.basis || "", "Not set")),
        fieldWrap("currency", "Currency", select("currency", c.currencies, v.currency || "GBP"))),
    ];
  }
  const readSeries = () => ({ name: field("name").value, source: field("source").value, group: field("group").value, region: field("region").value, basis: field("basis").value, currency: field("currency").value });

  // ---- series detail
  function openSeries(id) {
    const s = data.series.find((x) => x.id === id);
    if (!s) return;
    detailId = id;
    showDrawer("detail", s.name, `${s.source} · ${s.group}`);
    const pts = [...(s.points || [])].sort((a, b) => b.date.localeCompare(a.date));
    const add = el("form", { class: "inline-add", novalidate: "" },
      el("input", { type: "date", name: "date", value: todayIso(), max: todayIso(), "aria-label": "Date" }),
      el("span", { class: "input-unit input-unit-pre" }, el("span", { text: SYM[s.currency] }), el("input", { type: "number", name: "price", min: "0", step: "0.01", placeholder: "Price", "aria-label": "Price per tonne" }), el("span", { text: "/t" })),
      el("button", { class: "btn btn-primary btn-sm", type: "submit", text: "Add" }));
    add.addEventListener("submit", async (e) => {
      e.preventDefault();
      try { await api(`/api/benchmarks/${s.id}/points`, { method: "POST", body: { date: add.elements.date.value, price: add.elements.price.value } }); toast("Price added"); await load(); openSeries(s.id); }
      catch (error) { toast(error.message, true); }
    });
    $("view-detail").replaceChildren(el("div", { class: "profile-panel" },
      el("div", { class: "metric-row" },
        el("div", { class: "metric" }, el("span", { text: "Latest" }), el("strong", { text: s.latest ? perT(s.latest.price, s.currency) : "—" }), el("small", { text: s.latest ? fmt.date(s.latest.date) : "no prices" })),
        el("div", { class: "metric" }, el("span", { text: "Change" }), el("strong", { text: s.latest && s.latest.change !== null ? `${s.latest.change > 0 ? "+" : s.latest.change < 0 ? "−" : ""}${money(Math.abs(s.latest.change), s.currency)}` : "—" }), el("small", { text: s.latest && s.latest.prevDate ? `since ${fmt.date(s.latest.prevDate)}` : "" })),
        el("div", { class: "metric" }, el("span", { text: "Basis" }), el("strong", { style: "font-size:15px", text: s.basis || "—" }), el("small", { text: s.region || "" })),
        el("div", { class: "metric" }, el("span", { text: "Prices" }), el("strong", { text: pts.length }), el("small", { text: s.currency }))),
      me.canEdit ? el("section", { class: "p-sec" }, el("div", { class: "p-sec-head" }, el("h3", { text: "Add a price" })), add) : null,
      el("section", { class: "p-sec" }, el("div", { class: "p-sec-head" }, el("h3", { text: "Prices" })),
        pts.length ? el("div", { class: "table-scroll" }, el("table", { class: "quota-table" },
          el("thead", {}, el("tr", {}, el("th", { text: "Date" }), el("th", { class: "num", text: "Price" }), el("th", { text: "From" }), me.canEdit ? el("th", {}, el("span", { class: "sr-only", text: "Remove" })) : null)),
          el("tbody", {}, ...pts.map((p) => el("tr", {}, el("td", { text: fmt.date(p.date) }), el("td", { class: "num" }, el("strong", { text: perT(p.price, s.currency) })),
            el("td", { text: `${({ manual: "Added by hand", import: "Imported", feed: "API feed" })[p.via] || p.via || ""}${p.by && !String(p.by).startsWith("feed") ? ` · ${p.by}` : ""}` }),
            me.canEdit ? el("td", {}, el("button", { class: "link-btn", type: "button", text: "Remove", onclick: async (e) => {
              if (e.currentTarget.dataset.confirm !== "1") { e.currentTarget.dataset.confirm = "1"; e.currentTarget.textContent = "Remove?"; return; }
              try { await api(`/api/benchmarks/${s.id}/points/${p.date}`, { method: "DELETE" }); await load(); openSeries(s.id); } catch (error) { toast(error.message, true); }
            } })) : null)))))
          : el("p", { class: "muted small", text: "No prices yet." })),
      (s.keys || []).length > 1 ? el("p", { class: "small muted", style: "margin:0", text: `Matches imported columns named: ${s.keys.join(", ")}` }) : null));
    const archive = el("button", { class: "btn btn-danger-quiet", type: "button", text: "Archive series", onclick: async () => {
      if (archive.dataset.confirm !== "1") { archive.dataset.confirm = "1"; archive.textContent = "Archive this series?"; archive.classList.add("btn-danger"); return; }
      try { await api(`/api/benchmarks/${s.id}/archive`, { method: "POST" }); toast("Series archived"); closeDrawer(true); await load(); } catch (error) { toast(error.message, true); }
    } });
    footer(me.canEdit ? archive : null, el("span", { class: "spacer" }), me.canEdit ? el("button", { class: "btn", type: "button", text: "Edit series", onclick: () => openSeriesForm(s) }) : null);
  }

  function openSeriesForm(s) {
    showDrawer("form", s ? `Edit ${s.name}` : "New price series", "Price series");
    form.replaceChildren(el("fieldset", {}, el("legend", { text: "Series" }), ...seriesFields(s || {})));
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const saved = s ? await api(`/api/benchmarks/${s.id}`, { method: "PUT", body: readSeries() }) : await api("/api/benchmarks", { method: "POST", body: readSeries() });
        toast(s ? "Series updated" : "Series added"); dirty = false; await load(); closeDrawer(true); openSeries(saved.id);
      } catch (error) { showErrors((error.data && error.data.errors) || {}); toast(error.message, true); }
    };
    footer(el("span", { class: "spacer" }), cancelBtn(s ? () => { closeDrawer(true); openSeries(s.id); } : null), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", text: s ? "Save" : "Add series" }));
    field("name").focus();
  }

  // ---- add price (manual / market intel)
  function openAddPrice({ source } = {}) {
    showDrawer("form", "Add a price", source || "Market price");
    const options = data.series.filter((s) => !source || s.source === source);
    const sel = el("select", { id: "f-series", name: "series" },
      ...options.map((s) => el("option", { value: s.id, text: `${s.name} (${s.source})` })), el("option", { value: "new", text: "New series…" }));
    const newBox = el("div", { class: "new-series", hidden: "" }, ...seriesFields({ source: source || "", group }));
    form.replaceChildren(el("fieldset", {}, el("legend", { text: "Price" }),
      fieldWrap("series", "Series", sel),
      newBox,
      el("div", { class: "grid-2" },
        fieldWrap("date", "Date", el("input", { id: "f-date", name: "date", type: "date", value: todayIso(), max: todayIso() })),
        fieldWrap("price", "Price per tonne", el("input", { id: "f-price", name: "price", type: "number", min: "0", step: "0.01", inputmode: "decimal" }))),
      fieldWrap("note", "Note", el("input", { id: "f-note", name: "note", maxlength: "200", placeholder: "e.g. heard from trader, Turkish rebar offer" }))));
    const sync = () => { newBox.hidden = sel.value !== "new"; };
    if (!options.length) sel.value = "new";
    sync();
    sel.addEventListener("change", sync);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        let id = sel.value;
        if (id === "new") id = (await api("/api/benchmarks", { method: "POST", body: readSeries() })).id;
        await api(`/api/benchmarks/${id}/points`, { method: "POST", body: { date: field("date").value, price: field("price").value, note: field("note").value } });
        toast("Price added"); dirty = false; await load(); closeDrawer(true);
      } catch (error) { showErrors((error.data && error.data.errors) || {}); toast(error.message, true); }
    };
    footer(el("span", { class: "spacer" }), cancelBtn(), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", text: "Add price" }));
    (sel.value === "new" ? field("name") : field("price")).focus();
  }

  // ---- import (upload export / paste)
  let xlsxLoading = null;
  const loadXlsx = () => xlsxLoading || (xlsxLoading = new Promise((res, rej) => {
    if (window.XLSX) return res(window.XLSX);
    const sc = document.createElement("script"); sc.src = XLSX_URL; sc.onload = () => res(window.XLSX); sc.onerror = () => rej(new Error("Couldn't load the Excel reader — save the sheet as CSV and upload that instead."));
    document.head.append(sc);
  }));

  function openImport({ source } = {}) {
    showDrawer("form", "Import market prices", "Upload or paste");
    let payload = null; // {rows} or {text}
    const file = el("input", { type: "file", id: "f-file", accept: ".csv,.tsv,.txt,.xlsx,.xls", class: "file-input" });
    const drop = el("label", { class: "dropzone", for: "f-file" }, el("strong", { text: "Choose a file" }), el("span", { text: "Excel (.xlsx) or CSV — e.g. Kallanish Price Analyser → Export to Excel, or a MEPS price table" }), file);
    const text = el("textarea", { id: "f-text", name: "text", rows: "6", placeholder: "…or paste rows copied from Excel, including the header row" });
    const status = el("p", { class: "small muted", id: "file-status" });
    form.replaceChildren(
      el("fieldset", {}, el("legend", { text: "1. Where it's from" }),
        el("div", { class: "grid-2" },
          fieldWrap("source", "Source", select("source", data.choices.sources, source || "", "Choose")),
          fieldWrap("group", "Product group", select("group", data.choices.groups, group || "", "Choose")))),
      el("fieldset", {}, el("legend", { text: "2. The prices" }), drop, status, fieldWrap("text", "Paste instead", text,
        "Either one row per price (Date, Series, Price, Currency) or one column per series (Date, then a column for each).")),
      el("details", { class: "help" }, el("summary", { text: "Example layouts" }),
        el("pre", { text: "Date\tUK merchant bar delivered (GBP/t)\tEU merchant bar ex-works (EUR/t)\n01/09/2026\t760\t655\n01/10/2026\t748\t648" }),
        el("pre", { text: "date,series,price,currency\n2026-09-30,MEPS UK merchant bar,745,GBP" })));
    file.addEventListener("change", async () => {
      const f = file.files[0];
      if (!f) return;
      status.textContent = `Reading ${f.name}…`;
      try {
        if (/\.xlsx?$/i.test(f.name)) {
          const XLSX = await loadXlsx();
          const wb = XLSX.read(await f.arrayBuffer(), { type: "array", cellDates: false });
          const sheet = wb.Sheets[wb.SheetNames[0]];
          payload = { rows: XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: "" }) };
          status.textContent = `${f.name} · ${wb.SheetNames[0]} · ${payload.rows.length} rows`;
        } else {
          payload = { text: await f.text() };
          status.textContent = `${f.name} · ${payload.text.split(/\n/).length} lines`;
        }
        text.value = "";
      } catch (error) { status.textContent = error.message; payload = null; }
    });
    text.addEventListener("input", () => { if (text.value.trim()) { payload = { text: text.value }; file.value = ""; status.textContent = ""; } });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const errs = {};
      if (!field("source").value) errs.source = "Pick where these prices come from.";
      if (!field("group").value) errs.group = "Pick the product group they benchmark.";
      if (!payload) errs.text = "Choose a file or paste some rows.";
      showErrors(errs);
      if (Object.keys(errs).length) return;
      try {
        const preview = await api("/api/benchmarks/import", { method: "POST", body: { ...payload, commit: false } });
        reviewImport(payload, preview, { source: field("source").value, group: field("group").value });
      } catch (error) { toast(error.message, true); }
    };
    footer(el("span", { class: "spacer" }), cancelBtn(), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", text: "Check prices" }));
  }

  function reviewImport(payload, preview, ctx) {
    $("drawer-title").textContent = "Check and map the series";
    if (!preview.plan.length) {
      form.replaceChildren(el("div", { class: "callout is-warn" }, el("div", {}, el("strong", { text: "No prices found" }), el("ul", { class: "plain-list" }, ...preview.errors.map((x) => el("li", { text: x }))))));
      footer(el("button", { class: "btn", type: "button", text: "Back", onclick: () => openImport(ctx) }), el("span", { class: "spacer" }));
      return;
    }
    const existing = data.series;
    const rows = preview.plan.map((g) => {
      const sel = el("select", { "data-key": g.key, "aria-label": `Where ${g.name} goes` },
        el("option", { value: "new", text: "Create a new series" }),
        existing.length ? el("optgroup", { label: "Add to existing" }, ...existing.map((s) => el("option", { value: s.id, text: `${s.name} (${s.source})` }))) : null,
        el("option", { value: "skip", text: "Skip" }));
      sel.value = g.seriesId || "new";
      return el("tr", {},
        el("td", {}, el("strong", { text: g.name }), el("div", { class: "row-sub", text: `${g.count} price${g.count === 1 ? "" : "s"} · ${fmt.date(g.from)}${g.to !== g.from ? ` – ${fmt.date(g.to)}` : ""}` })),
        el("td", { class: "num", text: `${SYM[g.currency] || ""}${g.latestPrice}` }),
        el("td", {}, sel));
    });
    form.replaceChildren(
      el("p", { class: "muted", style: "margin:0", text: `Found ${preview.count} prices in ${preview.plan.length} series (${preview.format === "wide" ? "one column per series" : "one row per price"}). New series are saved as ${ctx.source} · ${ctx.group}; you can rename them later.` }),
      el("div", { class: "table-scroll" }, el("table", { class: "quota-table" }, el("thead", {}, el("tr", {}, el("th", { text: "Series in the file" }), el("th", { class: "num", text: "Latest" }), el("th", { text: "Goes into" }))), el("tbody", {}, ...rows))),
      ...(preview.errors.length ? [el("details", { class: "help" }, el("summary", { text: `${preview.errors.length} row${preview.errors.length === 1 ? "" : "s"} skipped` }), el("ul", { class: "plain-list" }, ...preview.errors.map((x) => el("li", { text: x }))))] : []));
    form.onsubmit = async (e) => {
      e.preventDefault();
      const mapping = {};
      form.querySelectorAll("select[data-key]").forEach((s) => {
        const g = preview.plan.find((x) => x.key === s.dataset.key);
        mapping[s.dataset.key] = s.value === "new"
          ? { create: { name: g.name, source: ctx.source, group: ctx.group, currency: g.currency || "GBP", region: /\buk\b/i.test(g.name) ? "UK" : /\beu\b|europe/i.test(g.name) ? "EU" : /turk/i.test(g.name) ? "Turkey" : "", basis: /deliver/i.test(g.name) ? "Delivered UK" : /ex.?works|exw/i.test(g.name) ? "Ex-works" : /fob/i.test(g.name) ? "FOB" : /cfr/i.test(g.name) ? "CFR UK" : "" } }
          : s.value;
      });
      try {
        const res = await api("/api/benchmarks/import", { method: "POST", body: { ...payload, commit: true, mapping } });
        toast(`Imported ${res.series.reduce((n, x) => n + x.prices, 0)} prices into ${res.series.length} series${res.skipped.length ? ` · ${res.skipped.length} skipped` : ""}`);
        dirty = false; await load(); closeDrawer(true);
      } catch (error) { toast(error.message, true); }
    };
    footer(el("button", { class: "btn", type: "button", text: "Back", onclick: () => openImport(ctx) }), el("span", { class: "spacer" }), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", text: "Import prices" }));
  }

  // ---------------------------------------------------------------- data
  async function load() {
    try {
      data = await api("/api/benchmarks");
      assignColors();
      renderFeeds(); renderGroups(); renderCompare(); renderChart(); renderSeries();
    } catch (error) {
      $("feeds").replaceChildren(el("p", { class: "muted", text: `Could not load market prices: ${error.message}` }));
    }
  }

  form.addEventListener("input", () => { dirty = true; });
  $("import-btn").addEventListener("click", () => openImport({}));
  $("add-price-btn").addEventListener("click", () => openAddPrice({}));
  $("drawer-close").addEventListener("click", () => closeDrawer());
  $("backdrop").addEventListener("click", () => closeDrawer());
  $("drawer-size").addEventListener("click", () => { drawer.classList.toggle("is-large"); });
  document.addEventListener("keydown", (e) => { if (!drawer.hidden && e.key === "Escape") { e.preventDefault(); closeDrawer(); } });
  $("range").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    rangeDays = Number(b.dataset.range);
    $("range").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderChart();
  }));
  loadMe().then((m) => { me = m; if (!me.canEdit) { $("import-btn").hidden = true; $("add-price-btn").hidden = true; } });
  load();
})();
