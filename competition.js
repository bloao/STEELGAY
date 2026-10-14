(function () {
  "use strict";
  const { api, fmt, el, toast } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let data = null;
  let open = new Set();
  let editing = null; // competitor being edited, or null for new

  const per = (p) => (p ? new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(4, 6)) - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" }) : "—");
  const perShort = (p) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(4, 6)) - 1, 1)).toLocaleDateString("en-GB", { month: "short", timeZone: "UTC" });
  const gbpBig = (v) => (!Number.isFinite(v) ? "—" : Math.abs(v) >= 1e6 ? `£${(v / 1e6).toFixed(1)}m` : Math.abs(v) >= 1e3 ? `£${Math.round(v / 1e3)}k` : `£${Math.round(v)}`);
  const SIGNAL = { "stepping-up": ["Stepping up", "is-up"], expanding: ["Widening range", "is-up"], steady: ["Steady", ""], slowing: ["Slowing", "is-down"], quiet: ["Gone quiet", "is-quiet"], occasional: ["Occasional", ""] };
  const productFor = (code) => (data.products || []).filter((p) => p.code.slice(0, 6) === code.slice(0, 6)).map((p) => p.name);
  const codeFmt = (c) => c.replace(/^(\d{4})(\d{2})(\d{2})$/, "$1 $2 $3");

  // ---------------------------------------------------------------- status strip
  function renderStrip() {
    const s = data.status;
    const sync = s.sync;
    const parts = [];
    if (sync.running) {
      parts.push(el("div", { class: "ds-row is-busy" }, el("span", { class: "spinner sm", "aria-hidden": "true" }),
        el("span", { text: `Loading from HMRC: ${sync.step || "starting"}${sync.total ? ` (${sync.done} of ${sync.total})` : ""}. You can keep using the page.` }),
        sync.total ? el("span", { class: "ds-bar" }, el("span", { style: `width:${Math.round((sync.done / sync.total) * 100)}%` })) : null));
    }
    parts.push(el("div", { class: "ds-row" },
      el("span", { class: `ds-item${s.importerMonths ? " is-ok" : ""}` }, el("b", { text: "Importer lists" }), s.importerMonths ? ` ${per(s.importerFrom)} to ${per(s.importerTo)} · ${s.importerMonths} months` : ` summary of ${s.summaryCompanies.toLocaleString("en-GB")} companies, 2024 to 2026`),
      el("span", { class: `ds-item${s.tradeMonths ? " is-ok" : ""}` }, el("b", { text: "Import volumes" }), s.tradeMonths ? ` ${s.tradeMonths} months` : " not loaded"),
      el("span", { class: `ds-item${s.hasChKey ? " is-ok" : ""}` }, el("b", { text: "Companies House" }), s.hasChKey ? " connected" : " ", s.hasChKey ? null : el("a", { href: "settings.html#connections", text: "add a free key" }))));
    if (!s.importerMonths && !sync.running) parts.push(el("p", { class: "ds-hint", text: "For the month-by-month view and market volumes, load the HMRC history. That's about 10 MB a month from uktradeinfo.com, and it's checked for new months daily after that." }));
    if (sync.errors && sync.errors.length && !sync.running) parts.push(el("p", { class: "ds-hint is-bad", text: `Some files couldn't be loaded: ${sync.errors.slice(-2).join("; ")}` }));
    $("data-strip").replaceChildren(...parts);
    const b = $("sync-btn");
    b.disabled = sync.running || !data.canEdit;
    b.textContent = sync.running ? "Loading…" : s.importerMonths ? "Check for new months" : "Load HMRC history";
    $("add-btn").hidden = !data.canEdit;
  }

  // ---------------------------------------------------------------- market volume
  function renderMarket() {
    const rows = data.market.filter((r) => r.tonnes > 0 || r.avg12);
    if (!rows.length) {
      $("market").replaceChildren(el("div", { class: "chart-wait" }, el("div", {}, el("strong", { text: "No import volumes loaded yet" }),
        el("p", { text: data.yourCodes.length ? `Load the HMRC history to see monthly UK imports of your ${data.yourCodes.length} product codes, and whether buyers are front-loading ahead of quota periods or the carbon border charge.` : "Add products first: the chart follows their commodity codes." }))));
      return;
    }
    const last = rows[rows.length - 1];
    const hot = rows.slice(-3).filter((r) => r.vsAvgPct !== null && r.vsAvgPct >= 25);
    const cold = rows.slice(-3).filter((r) => r.vsAvgPct !== null && r.vsAvgPct <= -25);
    const callout = hot.length
      ? el("div", { class: "miss-banner" }, el("div", {}, el("strong", { text: `Imports of your products ran ${Math.round(Math.max(...hot.map((r) => r.vsAvgPct)))}% above normal in ${hot.map((r) => per(r.p)).join(" and ")}.` }), el("p", { text: "Buyers bringing steel in early, often ahead of a new quota period, a price rise or the carbon border charge. Expect quota to run down faster and stockholders to be well covered." })))
      : cold.length ? el("div", { class: "miss-banner is-calm" }, el("div", {}, el("strong", { text: `Imports of your products ran ${Math.round(Math.abs(Math.min(...cold.map((r) => r.vsAvgPct))))}% below normal in ${cold.map((r) => per(r.p)).join(" and ")}.` }), el("p", { text: "Buyers holding back. Competitors may be running stocks down, which can mean tighter supply later." })))
      : el("div", { class: "miss-banner is-calm" }, el("div", {}, el("strong", { text: `${per(last.p)}: ${last.tonnes.toLocaleString("en-GB")} t imported, ${last.vsAvgPct === null ? "not enough history to compare" : `${last.vsAvgPct >= 0 ? "+" : "−"}${Math.abs(Math.round(last.vsAvgPct))}% against the 12-month average`}.` }), el("p", { text: "No sign of unusual stocking up in the last three months." })));
    const W = 960, H = 240, L = 54, R = 12, T = 12, B = 26;
    const max = Math.max(...rows.map((r) => Math.max(r.tonnes, r.avg12 || 0))) * 1.1 || 1;
    const bw = (W - L - R) / rows.length;
    const X = (i) => L + i * bw;
    const Y = (v) => T + (1 - v / max) * (H - T - B);
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Monthly UK import tonnes for your products">`;
    for (let i = 0; i <= 4; i++) { const g = (max * i) / 4; svg += `<line x1="${L}" x2="${W - R}" y1="${Y(g).toFixed(1)}" y2="${Y(g).toFixed(1)}" class="mk-grid"/><text x="${L - 6}" y="${(Y(g) + 4).toFixed(1)}" class="mk-axis" text-anchor="end">${g >= 1000 ? `${Math.round(g / 1000)}k` : Math.round(g)}</text>`; }
    rows.forEach((r, i) => {
      const c = r.vsAvgPct === null ? "" : r.vsAvgPct >= 25 ? " is-hot" : r.vsAvgPct <= -25 ? " is-cold" : "";
      svg += `<rect x="${(X(i) + bw * 0.15).toFixed(1)}" y="${Y(r.tonnes).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${(Y(0) - Y(r.tonnes)).toFixed(1)}" rx="3" class="vol-bar${c}" style="--d:${i * 25}ms"><title>${per(r.p)}: ${r.tonnes.toLocaleString("en-GB")} t${r.vsAvgPct === null ? "" : ` (${r.vsAvgPct >= 0 ? "+" : ""}${Math.round(r.vsAvgPct)}% vs 12-month average)`}${r.perT ? ` · avg £${Math.round(r.perT)}/t at the border` : ""}</title></rect>`;
      if (["01", "04", "07", "10"].includes(r.p.slice(4))) svg += `<text x="${(X(i) + bw / 2).toFixed(1)}" y="${H - 8}" class="mk-axis" text-anchor="middle">${perShort(r.p)}${r.p.slice(4) === "01" ? ` ${r.p.slice(0, 4)}` : ""}</text><line x1="${X(i).toFixed(1)}" x2="${X(i).toFixed(1)}" y1="${T}" y2="${H - B}" class="mk-grid" stroke-dasharray="2 4"/>`;
    });
    const avgPts = rows.map((r, i) => (r.avg12 ? `${(X(i) + bw / 2).toFixed(1)},${Y(r.avg12).toFixed(1)}` : null)).filter(Boolean);
    if (avgPts.length > 1) svg += `<polyline points="${avgPts.join(" ")}" class="vol-avg"/>`;
    svg += "</svg>";
    const plot = el("div", { class: "mk-plot vol-plot" }); plot.innerHTML = svg;
    const origins = Object.entries(last.origins || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
    const total = Object.values(last.origins || {}).reduce((a, b) => a + b, 0) || 1;
    $("market").replaceChildren(callout,
      el("div", { class: "mk-legend" }, el("span", { class: "mk-key" }, el("span", { class: "swatch", style: "background:#6190ae" }), "Tonnes imported"), el("span", { class: "mk-key" }, el("span", { class: "swatch", style: "background:#c4553a" }), "25%+ above average"), el("span", { class: "mk-key" }, el("span", { class: "swatch is-dashed", style: "background:#0c0e12" }), "12-month average")),
      plot,
      origins.length ? el("div", { class: "vol-origins" }, el("span", { text: `Where ${per(last.p)}'s imports came from:` }), ...origins.map(([o, t]) => el("span", { class: "vol-o" }, el("b", { text: o }), ` ${Math.round((t / total) * 100)}%`))) : null);
  }

  // ---------------------------------------------------------------- competitors
  function strip(a) {
    const box = el("div", { class: "act-strip", role: "img", "aria-label": `Imported in ${a.monthsActive} of the last ${a.monthsShown} months` });
    a.strip.forEach((x) => box.append(el("span", { class: `act-cell${x.n ? (x.yours ? " is-yours" : " is-on") : ""}`, title: `${per(x.p)}: ${x.n ? `${x.n} steel code${x.n === 1 ? "" : "s"}${x.yours ? `, ${x.yours} of yours` : ""}` : "no imports"}` })));
    return box;
  }
  function stockBlock(c) {
    const a = c.accounts;
    if (!c.companyNumber) return el("span", { class: "muted small", text: "Add Companies House number" });
    if (!a) return el("span", { class: "muted small", text: data.status.hasChKey ? "Accounts not fetched yet" : "Needs a Companies House key" });
    const [cur, prev] = a.stock;
    if (!cur) return el("span", { class: "muted small", text: a.parsed ? "No stock figure in their accounts" : "Accounts filed as PDF only" });
    const chg = prev && prev.value ? ((cur.value - prev.value) / Math.abs(prev.value)) * 100 : null;
    return el("div", { class: "stock-cell" }, el("strong", { text: gbpBig(cur.value) }),
      el("span", { class: `row-sub ${chg === null ? "" : chg >= 15 ? "is-up" : chg <= -15 ? "is-down" : ""}`, text: `${chg === null ? "" : `${chg >= 0 ? "+" : "−"}${Math.abs(Math.round(chg))}% · `}year end ${fmt.date(cur.date)}` }));
  }
  function renderCompetitors() {
    const list = data.competitors;
    if (!list.length) {
      $("competitors").replaceChildren(el("div", { class: "notes-empty" }, el("strong", { text: "You're not following anyone yet" }),
        el("p", { text: "Use Follow a competitor, or pick from the suggestions below. Their import history appears straight away." })));
      return;
    }
    const months = data.months;
    $("competitors").replaceChildren(
      months.length ? el("div", { class: "comp-axis" }, el("span"), el("div", { class: "act-strip is-axis" }, ...months.map((p, i) => el("span", { class: "act-lab", text: i % 3 === 0 ? perShort(p) : "" }))), el("span")) : null,
      ...list.map((c, i) => {
        const a = c.analysis;
        const [sl, sc] = a ? SIGNAL[a.signal] || [a.signal, ""] : ["No import data", "is-quiet"];
        const isOpen = open.has(c.id);
        const row = el("article", { class: `comp-row${isOpen ? " is-open" : ""}`, style: `--d:${i * 50}ms` },
          el("button", { type: "button", class: "comp-btn", "aria-expanded": String(isOpen), onclick: () => { isOpen ? open.delete(c.id) : open.add(c.id); renderCompetitors(); } },
            el("div", { class: "comp-who" }, el("strong", { text: c.name }),
              el("span", { class: "row-sub", text: c.matched.length ? c.matched.map((m) => [m.town, m.postcode].filter(Boolean).join(" ")).filter(Boolean).slice(0, 2).join(" · ") || `${c.matched.length} importer record${c.matched.length === 1 ? "" : "s"}` : "No importer record matched" })),
            a && !a.summaryOnly ? strip(a) : el("div", { class: "comp-sum" }, a ? `${a.monthsActive} months importing · 2024 ${a.byYear[2024]}/12 · 2025 ${a.byYear[2025]}/12 · 2026 ${a.byYear[2026]} so far` : "Not found in HMRC importer lists"),
            el("div", { class: "comp-side" }, el("span", { class: `sig-pill ${sc}`, text: sl }), stockBlock(c))),
          el("p", { class: "comp-note", text: a ? `${a.note}${a.overlapCodes.length ? ` Imports ${a.overlapCodes.length} of the same codes as you.` : ""}` : "Edit to link their HMRC importer record." }),
          isOpen ? detail(c) : null);
        return row;
      }));
  }
  function detail(c) {
    const a = c.analysis;
    const acc = c.accounts;
    const yours = a ? a.overlapCodes : [];
    const others = a ? a.codes.filter((x) => !yours.includes(x)) : [];
    return el("div", { class: "comp-detail" },
      el("div", { class: "cd-col" },
        el("h4", { text: "What they import" }),
        a ? el("ul", { class: "code-list" },
          ...yours.map((x) => el("li", { class: "is-yours" }, el("b", { text: codeFmt(x) }), ` ${productFor(x).join(", ") || "same product family as yours"}`, a.newCodes.includes(x) ? el("span", { class: "tag", text: "new" }) : null)),
          others.length ? el("li", { class: "muted", text: `+ ${others.length} other steel code${others.length === 1 ? "" : "s"}${a.newCodes.filter((x) => others.includes(x)).length ? ` (${a.newCodes.filter((x) => others.includes(x)).length} new in the last 6 months)` : ""}` }) : null) : el("p", { class: "muted", text: "No importer records linked." }),
        a && a.lastActive ? el("p", { class: "small muted", text: `Last import: ${per(a.lastActive)} · ${a.monthsActive} of ${a.monthsShown} months` }) : null),
      el("div", { class: "cd-col" },
        el("h4", { text: "Accounts (Companies House)" }),
        acc && acc.stock.length ? el("table", { class: "acc-table" }, el("thead", {}, el("tr", {}, el("th", { text: "Year end" }), el("th", { class: "num", text: "Stock" }), el("th", { class: "num", text: "Turnover" }))),
          el("tbody", {}, ...acc.stock.slice(0, 4).map((s) => { const t = acc.turnover.find((x) => x.date === s.date); return el("tr", {}, el("td", { text: fmt.date(s.date) }), el("td", { class: "num", text: gbpBig(s.value) }), el("td", { class: "num", text: t ? gbpBig(t.value) : "—" })); })))
          : el("p", { class: "muted small", text: !c.companyNumber ? "Add their company number to pull stock and turnover from filed accounts." : acc ? (acc.filings.length ? "Their latest accounts don't include a stock figure in digital form." : "No accounts filed yet.") : "Not fetched yet." }),
        acc ? el("p", { class: "small muted", text: `Fetched ${fmt.dateTime(acc.fetchedAt)}${acc.filings[0] ? ` · latest filing ${fmt.date(acc.filings[0].date)}` : ""}` }) : null,
        c.companyNumber ? el("a", { class: "small", href: `https://find-and-update.company-information.service.gov.uk/company/${c.companyNumber}/filing-history`, target: "_blank", rel: "noopener", text: `Companies House ${c.companyNumber} ↗` }) : null),
      c.notes ? el("p", { class: "cd-notes", text: c.notes }) : null,
      data.canEdit ? el("div", { class: "cd-actions" },
        c.companyNumber ? el("button", { class: "btn btn-sm", type: "button", text: "Refresh accounts", onclick: async (e) => {
          const b = e.currentTarget; b.disabled = true; b.textContent = "Fetching…";
          try { const r = await api(`/api/competition/competitors/${c.id}/accounts`, { method: "POST" }); toast(r.ok ? "Accounts updated" : r.error, !r.ok); load(); } catch (error) { toast(error.message, true); b.disabled = false; }
        } }) : null,
        el("button", { class: "btn btn-sm", type: "button", text: "Edit", onclick: () => openForm(c) }),
        el("button", { class: "link-btn", type: "button", text: "Stop following", onclick: async () => { try { await api(`/api/competition/competitors/${c.id}/archive`, { method: "POST" }); load(); } catch (error) { toast(error.message, true); } } })) : null);
  }

  // ---------------------------------------------------------------- suggestions
  function renderSuggestions() {
    const s = data.suggestions;
    if (!data.yourCodes.length) { $("suggestions").replaceChildren(el("p", { class: "muted", text: "Add products to see who imports the same steel." })); return; }
    if (!s.length) { $("suggestions").replaceChildren(el("p", { class: "muted", text: "No overlapping importers found yet." })); return; }
    $("suggestions").replaceChildren(el("ul", { class: "sug-list" }, ...s.map((x, i) => el("li", { style: `--d:${i * 30}ms` },
      el("div", {}, el("strong", { text: x.name }), el("span", { class: "row-sub", text: [x.town, x.postcode].filter(Boolean).join(" ") })),
      el("span", { class: "sug-stat" }, el("b", { text: x.overlap }), ` of your codes`),
      el("span", { class: "sug-stat" }, el("b", { text: x.monthsActive }), x.summaryOnly ? " months since 2024" : " of 12 months"),
      data.canEdit ? el("button", { class: "btn btn-sm", type: "button", text: "Follow", onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await api("/api/competition/competitors", { method: "POST", body: { name: x.name.replace(/\s+(LTD|LIMITED|PLC)\.?$/i, "").replace(/\b\w+/g, (w) => w.charAt(0) + w.slice(1).toLowerCase()), importerIds: [x.id] } }); toast(`Following ${x.name}`); load(); }
        catch (error) { toast(error.message, true); }
      } }) : null))));
  }

  // ---------------------------------------------------------------- add / edit
  function openForm(c) {
    editing = c || null;
    const card = $("add-card"), f = $("add-form");
    const picked = new Set(c ? c.importerIds || [] : []);
    let chNumber = c ? c.companyNumber || "" : "";
    const nameIn = el("input", { name: "name", maxlength: "120", placeholder: "e.g. Barrett Steel", value: c ? c.name : "", autocomplete: "off", required: "" });
    const results = el("ul", { class: "imp-results", "aria-live": "polite" });
    const chResults = el("ul", { class: "imp-results" });
    const chIn = el("input", { name: "companyNumber", maxlength: "10", placeholder: "e.g. 01234567", value: chNumber });
    let timer = null;
    const search = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = nameIn.value.trim();
        if (q.length < 3) { results.replaceChildren(); chResults.replaceChildren(); return; }
        const r = await api(`/api/competition/search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
        results.replaceChildren(...(r.results.length ? r.results.map((x) => {
          const cb = el("input", { type: "checkbox", value: x.id, ...(picked.has(x.id) ? { checked: "" } : {}) });
          cb.addEventListener("change", () => { cb.checked ? picked.add(x.id) : picked.delete(x.id); });
          return el("li", {}, el("label", { class: "imp-opt" }, cb, el("span", {}, el("strong", { text: x.name }), el("span", { class: "row-sub", text: `${[x.town, x.postcode].filter(Boolean).join(" ")} · imported in ${x.months} months · ${x.overlap} of your codes` }))));
        }) : [el("li", { class: "muted small", text: "No HMRC importer by that name. They may buy only in the UK; you can still follow them for their accounts." })]));
        if (data.status.hasChKey) {
          const ch = await api(`/api/competition/ch-search?q=${encodeURIComponent(q)}`).catch(() => ({ results: [] }));
          chResults.replaceChildren(...(ch.results || []).slice(0, 5).map((x) => el("li", {}, el("button", { type: "button", class: `ch-opt${chIn.value === x.number ? " is-on" : ""}`, onclick: () => { chIn.value = x.number; chResults.querySelectorAll(".ch-opt").forEach((b) => b.classList.remove("is-on")); } },
            el("strong", { text: x.name }), el("span", { class: "row-sub", text: `${x.number} · ${x.status || ""} · ${x.address || ""}` })))));
        }
      }, 250);
    };
    nameIn.addEventListener("input", search);
    f.replaceChildren(
      el("label", { class: "nf nf-wide" }, el("span", { text: "Competitor name" }), nameIn),
      el("div", { class: "nf nf-wide" }, el("span", { text: "HMRC importer records" }), results),
      el("label", { class: "nf" }, el("span", { text: "Companies House number" }), chIn, data.status.hasChKey ? chResults : el("span", { class: "hint", text: "Add a Companies House key in Settings to search by name and pull their accounts." })),
      el("label", { class: "nf" }, el("span", { text: "Website" }), el("input", { name: "website", maxlength: "200", placeholder: "https://…", value: c ? c.website || "" : "" })),
      el("label", { class: "nf nf-wide" }, el("span", { text: "Notes" }), el("textarea", { name: "notes", rows: "2", maxlength: "1000", placeholder: "What you know: depots, mills they use, who they sell to", text: c ? c.notes || "" : "" })),
      el("p", { class: "nf-err nf-wide", "aria-live": "polite" }),
      el("div", { class: "nf-actions nf-wide" }, el("button", { class: "btn", type: "button", text: "Cancel", onclick: () => { card.hidden = true; } }), el("button", { class: "btn btn-primary", type: "submit", text: c ? "Save" : "Follow" })));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = { name: nameIn.value, importerIds: [...picked], companyNumber: chIn.value, website: f.elements.website.value, notes: f.elements.notes.value };
      try {
        if (editing) await api(`/api/competition/competitors/${editing.id}`, { method: "PUT", body });
        else await api("/api/competition/competitors", { method: "POST", body });
        card.hidden = true; toast(editing ? "Saved" : `Following ${body.name}`); load();
      } catch (error) { f.querySelector(".nf-err").textContent = error.message; }
    };
    card.hidden = false;
    card.scrollIntoView({ behavior: "smooth", block: "start" });
    nameIn.focus();
    if (nameIn.value) search();
  }

  async function load() {
    try {
      data = await api("/api/competition");
      renderStrip(); renderMarket(); renderCompetitors(); renderSuggestions();
      if (data.status.sync.running) setTimeout(load, 4000);
    } catch (error) {
      $("competitors").replaceChildren(el("p", { class: "muted", text: `Couldn't load: ${error.message}` }));
    }
  }

  $("add-btn").addEventListener("click", () => openForm(null));
  $("sync-btn").addEventListener("click", async () => {
    try { await api("/api/competition/sync", { method: "POST", body: { months: 24 } }); toast("Loading HMRC history in the background"); setTimeout(load, 800); }
    catch (error) { toast(error.message, true); }
  });
  if (window.EventSource) {
    const es = new EventSource((window.OrderTool.apiBase || "") + "/api/benchmarks/events", { withCredentials: Boolean(window.OrderTool.apiBase) });
    let t = null;
    es.addEventListener("competition", () => { clearTimeout(t); t = setTimeout(load, 500); });
  }
  load();
})();
