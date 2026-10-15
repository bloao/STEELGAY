// Settings → Data schema: every data point from every source, its type and
// live example, and the pages and calculations it feeds.
(function () {
  "use strict";
  const { api, el } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let data = null, view = "source", pick = null, q = "";

  const STATUS = { live: ["Live", "is-live"], stale: ["Stale", "is-warn"], retrying: ["Retrying", "is-warn"], error: ["Error", "is-bad"], off: ["Not set up", "is-off"], connecting: ["Connecting", "is-warn"], waiting: ["Waiting", "is-off"] };
  const every = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`; };
  const dot = (status) => el("i", { class: `sc-dot ${(STATUS[status] || ["", "is-off"])[1]}`, "aria-hidden": "true" });
  const fmtEx = (v, unit) => {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") { const n = Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-GB") : Math.abs(v) < 10 ? v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : (Math.round(v * 100) / 100).toLocaleString("en-GB"); return unit && !/·/.test(unit) ? `${n} ${unit}` : n; }
    if (Array.isArray(v)) return v.join(", ");
    return String(v).length > 60 ? `${String(v).slice(0, 58)}…` : String(v);
  };
  const pageChip = (k) => { const p = data.pageInfo[k]; return p ? el("a", { class: "sc-chip", href: p.href, text: p.label }) : null; };
  const engineChip = (k) => el("span", { class: "sc-chip is-engine", text: data.engines[k] || k });
  const match = (fld, src) => !q || [fld.key, fld.label, fld.type, src.name, src.provider, ...fld.usedIn.map((k) => data.pageInfo[k]?.label || k)].join(" ").toLowerCase().includes(q);

  function figs() {
    const t = data.totals, live = data.sources.filter((s) => s.status === "live").length;
    const fig = (k, v) => el("div", { class: "sc-fig" }, el("span", { text: k }), el("strong", { text: String(v) }));
    $("sc-figs").replaceChildren(fig("Sources", t.sources), fig("Live", live), fig("Data points", t.fields), fig("Pages fed", t.pages));
  }

  function sourceList(sources) {
    return el("nav", { class: "sc-list", "aria-label": "Sources" }, ...sources.map((s) => {
      const n = s.fields.filter((x) => match(x, s)).length;
      return el("button", { type: "button", class: `sc-src${s.key === pick ? " is-on" : ""}`, "aria-pressed": String(s.key === pick), onclick: () => { pick = s.key; render(); } },
        dot(s.status), el("span", { class: "sc-src-name", text: s.name }), el("span", { class: "sc-count", text: String(n) }));
    }));
  }

  function sourceDetail(s) {
    const [label, cls] = STATUS[s.status] || [s.status, ""];
    const fields = s.fields.filter((x) => match(x, s));
    return el("section", { class: "card sc-detail" },
      el("header", { class: "sc-head" },
        el("div", {}, el("h2", { text: s.name }), s.url ? el("a", { class: "sc-prov", href: s.url, target: "_blank", rel: "noopener", text: s.provider }) : el("span", { class: "sc-prov", text: s.provider })),
        el("span", { class: `sc-status ${cls}` }, dot(s.status), label)),
      el("dl", { class: "sc-meta" },
        ...[["Format", s.format], ["Refresh", every(s.every)], ["Grain", s.grain], ["Fields", String(s.fields.length)]].filter(([, v]) => v).map(([k, v]) => el("div", {}, el("dt", { text: k }), el("dd", { text: v })))),
      s.endpoint ? el("code", { class: "sc-endpoint", text: s.endpoint }) : null,
      el("div", { class: "sc-flow" }, el("span", { class: "sc-flow-k", text: "Feeds" }), ...s.pages.map(pageChip)),
      fields.length ? el("div", { class: "table-scroll" }, el("table", { class: "sc-table" },
        el("thead", {}, el("tr", {}, ...["Data point", "Type", "Latest value", "Used in"].map((h) => el("th", { text: h })))),
        el("tbody", {}, ...fields.map((x) => {
          const ex = fmtEx(x.example, x.unit);
          return el("tr", { class: x.derived ? "is-derived" : "" },
            el("td", { class: "sc-dp" }, el("strong", { text: x.label }), el("code", { text: x.key })),
            el("td", {}, el("span", { class: "sc-type", text: x.unit ? `${x.type} · ${x.unit}` : x.type })),
            el("td", { class: `sc-ex${ex ? "" : " is-none"}`, text: ex || "—", title: ex || "" }),
            el("td", {}, el("div", { class: "sc-chips" }, ...x.usedIn.map(pageChip), ...(x.engines || []).map(engineChip))));
        })))) : el("p", { class: "muted", text: "No matching data points" }));
  }

  function byPage() {
    const pages = data.pages.map((p) => ({ ...p, feeds: p.feeds.map((f) => ({ ...f, fields: f.fields.filter((l) => !q || `${l} ${f.name} ${p.label}`.toLowerCase().includes(q)) })).filter((f) => f.fields.length) })).filter((p) => p.feeds.length);
    if (!pages.length) return el("p", { class: "muted", text: "No matching data points" });
    return el("div", { class: "sc-pages" }, ...pages.map((p) => el("section", { class: "card sc-page" },
      el("header", { class: "sc-page-head" }, el("a", { href: p.href, class: "sc-page-name", text: p.label }), el("span", { class: "sc-page-sec", text: p.section }),
        el("span", { class: "sc-count", text: String(p.feeds.reduce((n, f) => n + f.fields.length, 0)) })),
      el("ul", { class: "sc-page-feeds" }, ...p.feeds.map((f) => el("li", {},
        el("button", { type: "button", class: "sc-page-src", onclick: () => { pick = f.key; setView("source"); } }, dot(f.status), f.name),
        el("div", { class: "sc-chips" }, ...f.fields.map((l) => el("span", { class: "sc-chip is-field", text: l })))))))));
  }

  function render() {
    if (!data) return;
    if (view === "page") { $("sc-root").replaceChildren(byPage()); return; }
    const sources = data.sources.filter((s) => !q || s.fields.some((x) => match(x, s)));
    if (!sources.length) { $("sc-root").replaceChildren(el("p", { class: "muted", text: "No matching data points" })); return; }
    if (!sources.some((s) => s.key === pick)) pick = sources[0].key;
    $("sc-root").replaceChildren(el("div", { class: "sc-layout" }, sourceList(sources), sourceDetail(sources.find((s) => s.key === pick))));
  }

  function setView(v) {
    view = v;
    for (const b of $("sc-view").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.view === view));
    render();
  }
  $("sc-view").addEventListener("click", (e) => { const b = e.target.closest("button[data-view]"); if (b) setView(b.dataset.view); });
  $("sc-q").addEventListener("input", (e) => { q = e.target.value.trim().toLowerCase(); render(); });

  async function load() {
    try {
      const r = await api("/api/data-schema");
      r.pageInfo = Object.fromEntries(r.pages.map((p) => [p.key, p]));
      // pages that only appear through fields (not in byPage) still need labels
      data = r;
      const want = new URLSearchParams(location.search).get("source");
      if (want) pick = want;
      figs(); render();
    } catch (error) { $("sc-root").replaceChildren(el("p", { class: "muted", text: `Couldn't load the schema: ${error.message}` })); }
  }
  load();
  setInterval(load, 60_000);
})();
