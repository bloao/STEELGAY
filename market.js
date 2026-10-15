(function () {
  "use strict";
  const { api, fmt, el, toast, loadMe } = window.OrderTool;
  // Lives inside the Suppliers page (Market prices sub-tab) with its own drawer.
  const ID = { drawer: "mk-drawer", backdrop: "mk-backdrop", "view-form": "mk-form", "view-detail": "mk-detail", "drawer-title": "mk-title", "drawer-eyebrow": "mk-eyebrow",
    "drawer-foot": "mk-foot", "drawer-close": "mk-close", "drawer-size": "mk-size", "drawer-avatar": "mk-avatar", "drawer-tags": "mk-tags", "profile-tabs": "mk-tabs" };
  const $ = (id) => document.getElementById(ID[id] || id);
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
  const isPulse = (s) => s.kind === "index" || s.kind === "input";
  const groupSeries = () => allSeries().filter((s) => s.group === group && !isPulse(s));
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
    const show = data.feeds.filter((f) => ["MEPS", "Kallanish", "Market intel"].includes(f.source) || ((f.series || (f.feed && f.feed.configured)) && !["ONS", "LME"].includes(f.source)));
    const liveCard = (key, title, url, sub) => {
      const run = data.live[key] || {};
      const f = data.feeds.find((x) => x.source === key) || {};
      const needsKey = key === "LME" && !run.hasKey;
      const status = needsKey ? ["Needs a key", "is-muted"] : run.ok ? ["Live", "is-live"] : run.at ? ["Last update failed", "is-warn"] : ["Connecting…", "is-muted"];
      const go = el("button", { class: "btn btn-sm", type: "button", text: "Update now", onclick: async (e) => {
        const b = e.currentTarget; b.disabled = true; b.textContent = "Updating…";
        try { const r = await api(`/api/benchmarks/live/${key}/run`, { method: "POST" }); toast(r.ok ? (r.added ? `${title}: ${r.added} new values` : `${title}: already up to date`) : r.error, !r.ok); await load(); }
        catch (error) { toast(error.message, true); b.disabled = false; b.textContent = "Update now"; }
      } });
      return el("article", { class: `feed-card is-live-card${run.ok ? " is-on" : ""}` },
        el("div", { class: "feed-head" }, el("strong", { text: title }), url ? el("a", { href: url, target: "_blank", rel: "noopener", class: "small", text: "Source ↗" }) : null),
        el("span", { class: `feed-status ${status[1]}` }, status[1] === "is-live" ? el("span", { class: "live-dot", "aria-hidden": "true" }) : null, status[0]),
        el("p", { class: "feed-meta", text: `${f.series || 0} series · ${f.points || 0} values${f.lastDate ? ` · latest ${fmt.date(f.lastDate)}` : ""}` }),
        run.at ? el("p", { class: `feed-meta ${run.ok ? "" : "is-bad"}`, text: run.ok ? `Checked ${fmt.dateTime(run.at)}${run.added ? ` · ${run.added} new` : ""}` : run.error }) : null,
        el("p", { class: "feed-how", text: sub }),
        me.canEdit ? el("div", { class: "feed-actions" }, needsKey ? el("a", { class: "btn btn-sm btn-primary", href: "settings.html#connections", text: "Add API key" }) : go) : null);
    };
    const cards = [
      liveCard("ONS", "ONS steel prices", "https://www.ons.gov.uk/economy/inflationandpriceindices", "Official UK steel price indices (domestic, imported, import prices). Free — pulled automatically every day."),
      liveCard("LME", "LME steel (daily)", "https://metals-api.com", data.live.LME && data.live.LME.hasKey ? `Daily LME prices (${(data.live.LME.symbols || []).join(", ")}) in USD/t — refreshed every 12 hours.` : "Daily LME rebar and scrap prices via Metals-API. Sign up at metals-api.com and paste the key in Settings."),
      ...show.map((f) => {
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
      }),
    ];
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
      onclick: () => { group = g; renderGroups(); renderGlance(); renderCompare(); renderChart(); },
    }, g, el("span", { class: "count", text: allSeries().filter((s) => s.group === g).length }))));
    $("group-tabs").hidden = groups.length < 2;
  }

  // ---------------------------------------------------------------- shared bits
  const pctTxt = (c) => (c ? `${c.pct > 0 ? "+" : c.pct < 0 ? "−" : ""}${Math.abs(c.pct).toFixed(1)}%` : "—");
  const pctCls = (c) => (!c || Math.abs(c.pct) < 0.05 ? "is-flat" : c.pct > 0 ? "is-up" : "is-down");
  const monthYear = (iso) => (iso ? new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : "");
  let animated = false; // draw-in animations only on the first render
  function spark(points, color, { w = 160, h = 40, labels = false } = {}) {
    const pts = [...points].sort((a, b) => a.date.localeCompare(b.date)).slice(-24);
    if (pts.length < 2) return el("span", { class: "muted small", text: "Not enough history yet" });
    const lo = Math.min(...pts.map((p) => p.price)), hi = Math.max(...pts.map((p) => p.price)), r = hi - lo || 1;
    const xy = (p, i) => [((i / (pts.length - 1)) * (w - 8) + 4), (h - 5 - ((p.price - lo) / r) * (h - 10))];
    const d = pts.map((p, i) => { const [x, y] = xy(p, i); return `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");
    const [ex, ey] = xy(pts[pts.length - 1], pts.length - 1);
    const area = `${d} L${ex.toFixed(1)},${h} L4,${h} Z`;
    const box = el("span", { class: "spark" });
    box.innerHTML = `<svg viewBox="0 0 ${w} ${h}" width="100%" aria-hidden="true"><path d="${area}" fill="${color}" opacity="0.08"/><path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" pathLength="1"${animated ? "" : ' class="spark-path"'}/><circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3.5" fill="${color}"/></svg>`;
    if (labels) box.append(el("span", { class: "spark-axis" }, el("span", { text: monthYear(pts[0].date) }), el("span", { text: monthYear(pts[pts.length - 1].date) })));
    return box;
  }
  const trendWord = (c) => (!c ? null : c.pct <= -0.5 ? ["Easing", "is-down"] : c.pct >= 0.5 ? ["Rising", "is-up"] : ["Steady", "is-flat"]);
  const moveWords = (c, span) => (!c ? "" : Math.abs(c.pct) < 0.05 ? `unchanged over ${span}` : `${c.pct > 0 ? "up" : "down"} ${Math.abs(c.pct).toFixed(1)}% over ${span}`);

  // ---------------------------------------------------------------- where prices are heading
  const PULSE_TEXT = {
    "ons:GHAV": ["UK-made steel", "What UK producers charge for steel sold in the UK."],
    "ons:GHCZ": ["Imported steel (UK buyers)", "What UK firms pay for steel brought in from abroad."],
    "ons:EZWP": ["Steel import prices", "Price of basic steel at the UK border, before it's sold on."],
  };
  function renderPulse() {
    const list = data.series.filter((x) => isPulse(x) || x.source === "LME");
    const box = $("pulse");
    if (!list.length) {
      const ons = data.live.ONS || {};
      box.replaceChildren(el("div", { class: "pulse-empty" }, el("span", { class: "spinner sm", "aria-hidden": "true" }),
        el("span", { text: ons.at && !ons.ok ? `Couldn't reach the ONS yet (${ons.error}). It will retry automatically.` : "Fetching the latest official steel price indices…" })));
      return;
    }
    const colors = ["#2a78d6", "#eb6834", "#1baf7a", "#6250d6", "#e34948"];
    box.replaceChildren(el("div", { class: "pulse-grid" }, ...list.map((x, i) => {
      const c = x.changes || {};
      const [title, what] = PULSE_TEXT[x.feedKey] || [x.name.replace(/\s*\((ONS|LME)\)\s*$/, ""), x.note || (x.kind === "input" ? "An input cost that feeds through to steel prices." : "")];
      const tw = trendWord(c.m3);
      const chip = (label, v) => el("span", { class: `pchip ${pctCls(v)}` }, el("span", { class: "pchip-k", text: label }), el("b", { text: pctTxt(v) }));
      const val = x.latest ? (x.kind === "index" ? x.latest.price.toFixed(1) : perT(x.latest.price, x.currency)) : "—";
      return el("article", { class: "pulse-card", style: `--d:${i * 70}ms` },
        el("div", { class: "pulse-top" },
          el("div", {}, el("h3", { text: title }), el("p", { text: what })),
          tw ? el("span", { class: `trend-tag ${tw[1]}`, text: tw[0] }) : null),
        el("div", { class: "pulse-val" }, el("strong", { text: val }),
          el("span", { text: x.kind === "index" ? `index · ${monthYear(x.latest && x.latest.date)}` : `${x.latest ? fmt.date(x.latest.date) : ""}` })),
        spark(x.points || [], colors[i % colors.length], { w: 260, h: 56, labels: true }),
        el("div", { class: "pchips" }, chip("1 month", c.m1), chip("3 months", c.m3), chip("1 year", c.m12)),
        el("p", { class: "pulse-src", text: `${x.source}${x.kind === "index" ? " · 2015 = 100" : ""}` }));
    })));
  }

  // Market movement since a supplier's quote, from the ONS index that fits them.
  function moveSinceQuote(sup) {
    const key = sup.origin === "UK" ? "ons:GHAV" : "ons:GHCZ";
    const idx = data.series.find((x) => x.feedKey === key);
    if (!idx || !sup.metrics.priceDate || !(idx.points || []).length) return null;
    const pts = [...idx.points].sort((a, b) => a.date.localeCompare(b.date));
    const start = [...pts].reverse().find((p) => p.date <= sup.metrics.priceDate);
    const end = pts[pts.length - 1];
    if (!start || start.date === end.date) return { pct: 0, from: start ? start.date : end.date, to: end.date, same: true };
    return { pct: Math.round(((end.price - start.price) / start.price) * 1000) / 10, from: start.date, to: end.date };
  }

  // ---------------------------------------------------------------- what "the market" means
  let refMode = "auto";
  const refLabel = (s) => (s.computed ? (/imports/i.test(s.source) ? "Average of your import quotes" : "Average of your UK quotes") : `${s.name} (${s.source})`);
  const refShort = (s) => (s.computed ? (/imports/i.test(s.source) ? "imports average" : "UK average") : `${s.source} price`);
  function refs() {
    return groupSeries().filter((s) => s.latest && Number.isFinite(gbp(s.latest.price, s.currency)))
      .sort((a, b) => Number(Boolean(a.computed)) - Number(Boolean(b.computed)) || a.name.localeCompare(b.name))
      .map((s) => ({ s, v: gbp(s.latest.price, s.currency) }));
  }
  // The benchmark a supplier is judged against: chosen one, or like-for-like.
  function refFor(sup, list) {
    if (refMode !== "auto") return list.find((r) => r.s.id === refMode) || null;
    const ext = list.find((r) => !r.s.computed);
    if (ext) return ext;
    if (!sup.origin) return null; // can't tell UK from import yet
    const imp = sup.origin !== "UK";
    return list.find((r) => r.s.computed && /imports/i.test(r.s.source) === Boolean(imp)) || list[0] || null;
  }
  const groupSuppliers = () => data.suppliers.filter((s) => s.supplies.includes(group) && Number.isFinite(gbp(s.metrics.pricePerT, s.metrics.currency)))
    .sort((a, b) => gbp(a.metrics.pricePerT, a.metrics.currency) - gbp(b.metrics.pricePerT, b.metrics.currency));
  const gapWords = (diff, ref) => (Math.abs(diff) < 2 ? ["In line with", "is-flat"] : diff < 0 ? [`${money(-diff)}/t below`, "is-below"] : [`${money(diff)}/t above`, "is-above"]);

  // ---------------------------------------------------------------- comparison ladder
  function renderCompare() {
    const list = refs();
    const sel = $("cmp-ref");
    const hasExt = list.some((r) => !r.s.computed);
    if (refMode !== "auto" && !list.some((r) => r.s.id === refMode)) refMode = "auto";
    sel.replaceChildren(el("option", { value: "auto", text: hasExt ? "Outside benchmark" : "Like for like (UK vs UK, imports vs imports)" }),
      ...list.map((r) => el("option", { value: r.s.id, text: `${refLabel(r.s)} · ${perT(r.v)}` })));
    sel.value = refMode;
    sel.closest(".ref-pick").hidden = !list.length;
    const sups = groupSuppliers();
    $("cmp-sub").textContent = hasExt
      ? `${group} · each quote against outside market prices.`
      : `${group} · with no MEPS or Kallanish prices yet, quotes are compared with the average of your own suppliers.`;
    if (!sups.length) { $("cmp").replaceChildren(el("div", { class: "empty-state" }, el("h3", { text: "No supplier quotes for this product group" }), el("p", { text: "Log a quote on the Suppliers tab and it appears here." }))); return; }

    const vals = [...sups.map((s) => gbp(s.metrics.pricePerT, s.metrics.currency)), ...list.map((r) => r.v)];
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max((hi - lo) * 0.12, 10);
    lo = Math.floor((lo - pad) / 10) * 10; hi = Math.ceil((hi + pad) / 10) * 10;
    const P = (v) => ((v - lo) / (hi - lo)) * 100;
    const shown = refMode === "auto" ? list : list.filter((r) => r.s.id === refMode);

    const legend = el("div", { class: "lad-legend" },
      ...shown.map((r) => el("span", { class: "lad-key" }, el("span", { class: "lad-key-line", style: `--c:${colorOf(r.s.id)}` }), `${refLabel(r.s)} `, el("b", { text: perT(r.v) }), el("span", { class: "muted", text: ` · ${fmt.date(r.s.latest.date)}` }))),
      el("span", { class: "lad-key" }, el("span", { class: "lad-key-dot" }), "Supplier quote"));
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    const axis = el("div", { class: "lad-row lad-axis", "aria-hidden": "true" }, el("span"), el("span"),
      el("div", { class: "lad-track is-axis" }, ...ticks.map((t) => el("span", { class: "lad-tick", style: `left:${P(t)}%`, text: `£${Math.round(t)}` }))), el("span"));

    const rows = sups.map((sup, i) => {
      const q = gbp(sup.metrics.pricePerT, sup.metrics.currency);
      const ref = refFor(sup, list);
      const diff = ref ? q - ref.v : null;
      const [gw, gcls] = ref ? gapWords(diff, ref) : ["", ""];
      const mv = moveSinceQuote(sup);
      const covers = ({ everything: "all-in", "except-duty": "+ duty" })[sup.metrics.covers] || "";
      const track = el("div", { class: "lad-track" },
        ...shown.map((r) => el("span", { class: `lad-ref${ref && r.s.id === ref.s.id ? " is-mine" : ""}`, style: `left:${P(r.v)}%;--c:${colorOf(r.s.id)}`, title: `${refLabel(r.s)} ${perT(r.v)}` })),
        ref && Math.abs(diff) >= 2 ? el("span", { class: `lad-gap ${gcls}`, style: `left:${Math.min(P(q), P(ref.v))}%;width:0%`, "data-w": String(Math.abs(P(q) - P(ref.v))) }) : null,
        el("span", { class: `lad-dot ${gcls}`, style: `left:${P(q)}%`, title: `${sup.name} ${perT(q)}` }));
      const second = mv && !mv.same
        ? `Market ${mv.pct > 0 ? "up" : "down"} ${Math.abs(mv.pct).toFixed(1)}% since this quote${mv.pct < -0.4 ? " — worth asking for a better price" : mv.pct > 0.4 ? " — this price may not last" : ""}`
        : mv ? "" : `Quoted ${fmt.date(sup.metrics.priceDate)}`;
      return el("div", { class: "lad-row", style: `--d:${i * 60}ms` },
        el("div", { class: "lad-who" }, el("a", { href: `suppliers.html?supplier=${sup.id}`, class: "sup-link", text: sup.name }),
          el("span", { class: "row-sub" }, sup.origin || "origin not set", covers ? el("span", { class: `tag ${covers === "+ duty" ? "tag-warn" : ""}`, text: covers }) : null)),
        el("strong", { class: "lad-q", text: perT(q) }),
        track,
        el("div", { class: "lad-verdict" },
          ref ? el("strong", { class: gcls, text: gcls === "is-flat" ? `In line with the ${refShort(ref.s)}` : `${gw} the ${refShort(ref.s)}` }) : el("strong", { class: "muted", text: sup.origin ? "No benchmark yet" : "Set the origin to compare" }),
          el("span", { class: "row-sub", text: second })));
    });
    const anyDuty = sups.some((s) => s.metrics.covers === "except-duty");
    $("cmp").replaceChildren(legend, el("div", { class: "ladder" }, axis, ...rows),
      el("p", { class: "lad-note" },
        hasExt ? "Check the basis matches (delivered vs ex-works) before reading much into small gaps." : "UK suppliers are compared with your UK average and importers with your import average, so it's like for like.",
        anyDuty ? " Quotes marked “+ duty” leave out the steel duty: the Suppliers tab shows what they really cost once quota risk is counted." : ""));
    requestAnimationFrame(() => requestAnimationFrame(() => $("cmp").querySelectorAll(".lad-gap").forEach((g) => { g.style.width = `${g.dataset.w}%`; })));
  }

  // ---------------------------------------------------------------- at a glance
  function renderGlance() {
    const ons = data.series.find((x) => x.feedKey === "ons:GHAV");
    const c = ons && ons.changes;
    const tw = c ? trendWord(c.m3) : null;
    const card = (cls, label, big, bigCls, text, extra) => el("article", { class: `glance ${cls}` },
      el("span", { class: "glance-l", text: label }),
      el("strong", { class: `glance-big ${bigCls || ""}`, text: big }),
      el("p", { class: "glance-t" }, ...[].concat(text)), extra || null);

    const trend = ons && c && c.m3
      ? card("is-trend", "UK steel prices", tw[0], tw[1],
          [`${moveWords(c.m3, "3 months")[0].toUpperCase()}${moveWords(c.m3, "3 months").slice(1)}`, c.m12 ? `, ${moveWords(c.m12, "the year")}.` : "."],
          el("div", { class: "glance-foot" }, spark(ons.points || [], "#2a78d6", { w: 320, h: 56 }), el("span", { class: "glance-src", text: `ONS official index · ${monthYear(ons.latest.date)}` })))
      : card("is-trend", "UK steel prices", "Loading…", "is-muted", "Fetching the official ONS steel price index.");

    const list = refs();
    const sups = groupSuppliers();
    let best;
    if (sups.length) {
      const sup = sups[0];
      const q = gbp(sup.metrics.pricePerT, sup.metrics.currency);
      const ref = refFor(sup, list);
      const diff = ref ? q - ref.v : null;
      const [gw, gcls] = ref ? gapWords(diff, ref) : ["", ""];
      best = card("is-best", `Cheapest ${group} quote`, perT(q), "",
        [el("b", { text: sup.name }), ref ? ` is ${gcls === "is-flat" ? "in line with" : gw} the ${refShort(ref.s)} (${perT(ref.v)}).` : "."],
        el("p", { class: "glance-src", text: sup.metrics.covers === "except-duty" ? "Quoted before steel duty, so check the Suppliers tab for the real cost." : `${sups.length} supplier quote${sups.length === 1 ? "" : "s"} in this group` }));
    } else best = card("is-best", `Cheapest ${group} quote`, "—", "is-muted", "No quotes logged for this product group yet.");

    const ext = list.filter((r) => !r.s.computed);
    const bench = ext.length
      ? card("is-bench", "Outside benchmark", perT(ext[0].v), "", [`${ext[0].s.name}, ${fmt.date(ext[0].s.latest.date)}.`, ext.length > 1 ? ` Plus ${ext.length - 1} more.` : ""],
          el("p", { class: "glance-src", text: `${ext[0].s.source}${ext[0].s.basis ? ` · ${ext[0].s.basis}` : ""}` }))
      : card("is-bench is-setup", "Outside benchmark", "Not set up", "is-muted",
          "",
          me.canEdit ? el("div", { class: "glance-actions" },
            el("button", { class: "btn btn-sm btn-primary", type: "button", text: "Import MEPS prices", onclick: () => openImport({ source: "MEPS" }) }),
            el("button", { class: "btn btn-sm", type: "button", text: "Add a price you've heard", onclick: () => openAddPrice({ source: "Market intel" }) })) : null);
    $("glance").replaceChildren(trend, best, bench);
  }

  function renderSourcesSummary() {
    const liveOn = ["ONS", "LME"].filter((k) => (data.live[k] && data.live[k].ok) || ((data.feeds.find((f) => f.source === k) || {}).points > 0)).length;
    const withData = data.feeds.filter((f) => f.points > 0 && !["ONS", "LME"].includes(f.source)).length;
    const needs = (data.live.LME && !data.live.LME.hasKey ? 1 : 0) + ["MEPS", "Kallanish"].filter((s) => !(data.feeds.find((f) => f.source === s) || {}).points).length;
    $("sources-sum").replaceChildren(...[
      el("span", { class: "src-chip is-on", text: `${liveOn} live` }),
      withData ? el("span", { class: "src-chip", text: `${withData} with prices` }) : null,
      el("span", { class: "src-chip is-auto", text: "your quotes" }),
      needs ? el("span", { class: "src-chip is-todo", text: `${needs} to set up` }) : null].filter(Boolean));
  }

  // ---------------------------------------------------------------- chart
  function renderChart() {
    const box = $("chart");
    const series = groupSeries().filter((s) => s.points && s.points.length);
    const from = rangeDays ? new Date(Date.now() - rangeDays * 86_400_000).toISOString().slice(0, 10) : "0000";
    const quotes = data.suppliers.filter((s) => s.supplies.includes(group)).flatMap((s) => s.quotes.map((q) => ({ ...q, supplier: s.name, gbp: gbp(q.pricePerT, q.currency) }))).filter((q) => q.date >= from && Number.isFinite(q.gbp));
    const lines = series.map((s) => ({ s, pts: s.points.filter((p) => p.date >= from).map((p) => ({ date: p.date, v: gbp(p.price, s.currency) })).filter((p) => Number.isFinite(p.v)) })).filter((l) => l.pts.length);
    const all = [...lines.flatMap((l) => l.pts), ...quotes.map((q) => ({ date: q.date, v: q.gbp }))];
    const dateCount = new Set(all.map((p) => p.date)).size;
    if (dateCount < 2) {
      box.replaceChildren(el("div", { class: "chart-wait" },
        el("svg"),
        el("div", {}, el("strong", { text: all.length ? "History builds up from here" : "Nothing to chart yet" }),
          el("p", { text: all.length ? `Everything so far is from ${fmt.date(all[0].date)}. Each quote you log and each price you import adds a point, and the trend lines appear once there are two dates.` : "Import MEPS or Kallanish prices, or log supplier quotes, to start a price history." }))));
      box.querySelector(".chart-wait svg").outerHTML = '<svg width="56" height="40" viewBox="0 0 56 40" fill="none" aria-hidden="true"><path d="M2 34h52" stroke="var(--line-strong)" stroke-width="2" stroke-linecap="round"/><path d="M6 28 18 22l10 6 12-14 10 4" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="4 4"/><circle cx="6" cy="28" r="3.5" fill="var(--accent)"/></svg>';
      return;
    }
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
      for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 16) labels[i].y = labels[i - 1].y + 16;
      const over = labels.length ? labels[labels.length - 1].y - (H - B - 4) : 0;
      if (over > 0) for (const lb of labels) lb.y -= over;
      for (let i = labels.length - 2; i >= 0; i--) if (labels[i + 1].y - labels[i].y < 16) labels[i].y = labels[i + 1].y - 16;
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
      window.OrderTool.placeTip(tip, (xs / W) * r.width, r.width);
    };
    svgEl.addEventListener("pointermove", show);
    svgEl.addEventListener("pointerdown", show);
    svgEl.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
  }

  // ---------------------------------------------------------------- series table
  function renderSeries() {
    const list = [...data.series].filter((x) => !isPulse(x)).sort((a, b) => a.group.localeCompare(b.group) || a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
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
    footer(el("span", { class: "spacer" }), cancelBtn(s ? () => { closeDrawer(true); openSeries(s.id); } : null), el("button", { class: "btn btn-primary", type: "submit", form: "mk-form", text: s ? "Save" : "Add series" }));
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
    footer(el("span", { class: "spacer" }), cancelBtn(), el("button", { class: "btn btn-primary", type: "submit", form: "mk-form", text: "Add price" }));
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
    footer(el("span", { class: "spacer" }), cancelBtn(), el("button", { class: "btn btn-primary", type: "submit", form: "mk-form", text: "Check prices" }));
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
    footer(el("button", { class: "btn", type: "button", text: "Back", onclick: () => openImport(ctx) }), el("span", { class: "spacer" }), el("button", { class: "btn btn-primary", type: "submit", form: "mk-form", text: "Import prices" }));
  }

  // ---------------------------------------------------------------- data
  async function load() {
    try {
      data = await api("/api/benchmarks");
      assignColors();
      renderFeeds(); renderGroups(); renderGlance(); renderCompare(); renderPulse(); renderChart(); renderSeries(); renderSourcesSummary();
      renderLivePill();
      setTimeout(() => { animated = true; }, 1500);
    } catch (error) {
      $("glance").replaceChildren(el("p", { class: "muted", text: `Could not load market prices: ${error.message}` }));
    }
  }

  form.addEventListener("input", () => { dirty = true; });
  $("import-btn").addEventListener("click", () => openImport({}));
  $("add-price-btn").addEventListener("click", () => openAddPrice({}));
  $("drawer-close").addEventListener("click", () => closeDrawer());
  $("backdrop").addEventListener("click", () => closeDrawer());
  $("drawer-size").addEventListener("click", () => { drawer.classList.toggle("is-large"); });
  document.addEventListener("keydown", (e) => { if (!drawer.hidden && e.key === "Escape") { e.preventDefault(); closeDrawer(); } });
  $("cmp-ref").addEventListener("change", (e) => { refMode = e.target.value; renderCompare(); renderGlance(); });
  $("range").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    rangeDays = Number(b.dataset.range);
    $("range").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    renderChart();
  }));
  // ---- live updates: the server pushes an event when prices or quotes change
  let liveState = "connecting";
  let lastPush = null;
  function renderLivePill() {
    const pill = $("live-pill");
    if (!pill) return;
    pill.hidden = false;
    pill.className = `live-pill is-${liveState}`;
    pill.replaceChildren(el("span", { class: "live-dot", "aria-hidden": "true" }),
      liveState === "on" ? `Live${lastPush ? ` · updated ${fmt.time(lastPush)}` : ""}` : liveState === "off" ? "Reconnecting…" : "Connecting…");
  }
  let es = null;
  let refreshTimer = null;
  function connectLive() {
    if (!window.EventSource || es) return;
    es = new EventSource((window.OrderTool.apiBase || "") + "/api/benchmarks/events", { withCredentials: Boolean(window.OrderTool.apiBase) });
    es.addEventListener("hello", () => { liveState = "on"; renderLivePill(); });
    const onChange = (e) => {
      lastPush = new Date().toISOString();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { if (started) load(); window.dispatchEvent(new CustomEvent("agx:live", { detail: e.type })); }, 300);
      renderLivePill();
    };
    es.addEventListener("prices", (e) => { onChange(e); if (started) toast("New market prices in"); });
    es.addEventListener("quotes", onChange);
    es.onerror = () => { liveState = "off"; renderLivePill(); };
    es.onopen = () => { liveState = "on"; renderLivePill(); };
  }
  connectLive();
  setInterval(() => { if (started && !document.hidden && liveState !== "on") load(); }, 5 * 60 * 1000);

  let started = false;
  window.MarketTab = {
    open() {
      if (started) return;
      started = true;
      loadMe().then((m) => { me = m; if (!me.canEdit) { $("import-btn").hidden = true; $("add-price-btn").hidden = true; } });
      load();
    },
    refresh() { if (started) load(); },
  };
  // opened straight to suppliers.html#market (this script loads after the tab was shown)
  const pane = document.getElementById("pane-market");
  if (pane && !pane.hidden) window.MarketTab.open();
})();
