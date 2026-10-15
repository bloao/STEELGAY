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

  // ---- Tree: source → data point → calculation / page, left to right -----
  const open = new Set();
  const seen = new Set(); // nodes/links already shown, so a toggle only animates what's new
  let treeInit = false;
  const NS = "http://www.w3.org/2000/svg";

  function tree() {
    const sources = data.sources.filter((s) => !q || s.fields.some((x) => match(x, s)));
    if (!sources.length) return el("p", { class: "muted", text: "No matching data points" });
    if (!treeInit) { treeInit = true; const first = sources.find((s) => s.status === "live") || sources[0]; open.add(first.key); }
    const links = []; // [fromId, toId, sourceKey]
    const usedTargets = new Set();
    const colSrc = el("div", { class: "tr-col" }, el("h3", { text: "Sources" }));
    const colFld = el("div", { class: "tr-col" }, el("h3", { text: "Data points" }));
    const colTgt = el("div", { class: "tr-col" }, el("h3", { text: "Feeds into" }));
    let delay = 0;
    const node = (id, cls, kids, extra = {}) => { const old = seen.has(id); seen.add(id); return el("div", { class: `tr-node ${cls}${old ? " is-seen" : ""}`, "data-id": id, style: old ? "" : `--d:${(delay += 14)}ms`, ...extra }, ...kids); };
    for (const s of sources) {
      const isOpen = open.has(s.key) || Boolean(q);
      const fields = s.fields.filter((x) => match(x, s));
      colSrc.append(node(`s:${s.key}`, `tr-src${isOpen ? " is-open" : ""}`, [dot(s.status), el("span", { class: "tr-label", text: s.name }), el("span", { class: "tr-n", text: String(fields.length) }),
        el("span", { class: "tr-caret", "aria-hidden": "true" })], { role: "button", tabindex: "0", "aria-expanded": String(isOpen),
        onclick: () => toggle(s.key), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(s.key); } } }));
      if (isOpen) {
        const grp = el("div", { class: "tr-group" });
        for (const x of fields) {
          const fid = `f:${s.key}:${x.key}`;
          const ex = fmtEx(x.example, x.unit);
          grp.append(node(fid, `tr-fld${x.derived ? " is-derived" : ""}`, [el("span", { class: "tr-label", text: x.label }), ex ? el("span", { class: "tr-ex", text: ex }) : el("span", { class: "tr-type", text: x.type })], { title: `${x.key} · ${x.type}${x.unit ? ` · ${x.unit}` : ""}` }));
          links.push([`s:${s.key}`, fid, s.key]);
          for (const e of x.engines || []) { links.push([fid, `e:${e}`, s.key]); usedTargets.add(`e:${e}`); }
          for (const pg of x.usedIn) { links.push([fid, `p:${pg}`, s.key]); usedTargets.add(`p:${pg}`); }
        }
        colFld.append(grp);
      } else {
        for (const pg of s.pages) { links.push([`s:${s.key}`, `p:${pg}`, s.key, true]); usedTargets.add(`p:${pg}`); }
      }
    }
    const engines = Object.entries(data.engines).filter(([k]) => usedTargets.has(`e:${k}`));
    const pages = Object.values(data.pageInfo).filter((p) => usedTargets.has(`p:${p.key}`));
    if (engines.length) colTgt.append(el("div", { class: "tr-sub", text: "Calculations" }), ...engines.map(([k, label]) => node(`e:${k}`, "tr-tgt is-engine", [el("span", { class: "tr-label", text: label })])));
    if (pages.length) colTgt.append(el("div", { class: "tr-sub", text: "Pages" }), ...pages.map((p) => node(`p:${p.key}`, "tr-tgt", [el("a", { class: "tr-label", href: p.href, text: p.label })])));
    if (!colFld.querySelector(".tr-node")) colFld.append(el("p", { class: "tr-hint", text: "Open a source" }));
    const svg = document.createElementNS(NS, "svg"); svg.setAttribute("class", "tr-links"); svg.setAttribute("aria-hidden", "true");
    const wrap = el("div", { class: "tr-wrap" }, svg, el("div", { class: "tr-grid" }, colSrc, colFld, colTgt));
    const box = el("div", { class: "card tr-card" }, wrap);
    requestAnimationFrame(() => drawLinks(wrap, svg, links));
    wireHover(wrap);
    return box;
  }

  function toggle(key) { if (open.has(key)) open.delete(key); else open.add(key); render(); }

  function drawLinks(wrap, svg, links) {
    const base = wrap.getBoundingClientRect();
    svg.setAttribute("width", wrap.scrollWidth); svg.setAttribute("height", wrap.scrollHeight);
    svg.replaceChildren();
    const pos = (id) => { const n = wrap.querySelector(`[data-id="${CSS.escape(id)}"]`); if (!n) return null; const r = n.getBoundingClientRect(); return { l: r.left - base.left, r: r.right - base.left, y: r.top - base.top + r.height / 2 }; };
    links.forEach(([a, b, src, faint], i) => {
      const A = pos(a), B = pos(b); if (!A || !B) return;
      const x1 = A.r, x2 = B.l, mx = (x1 + x2) / 2;
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", `M${x1},${A.y} C${mx},${A.y} ${mx},${B.y} ${x2},${B.y}`);
      p.setAttribute("class", `tr-link${faint ? " is-faint" : ""}${b.startsWith("e:") ? " is-engine" : ""}`);
      p.dataset.a = a; p.dataset.b = b; p.dataset.src = src;
      svg.append(p);
      const lk = `${a}>${b}`;
      if (seen.has(lk)) return;
      seen.add(lk);
      const len = p.getTotalLength();
      p.style.strokeDasharray = `${len}`; p.style.strokeDashoffset = `${len}`;
      p.style.transitionDelay = `${Math.min(i * 6, 600)}ms`;
    });
    requestAnimationFrame(() => svg.classList.add("is-drawn"));
  }

  function wireHover(wrap) {
    const on = (id) => {
      const paths = [...wrap.querySelectorAll(".tr-link")];
      let hot;
      if (id.startsWith("s:")) hot = paths.filter((p) => `s:${p.dataset.src}` === id);
      else if (id.startsWith("f:")) hot = paths.filter((p) => p.dataset.a === id || p.dataset.b === id);
      else {
        const into = paths.filter((p) => p.dataset.b === id);
        const feeders = new Set(into.map((p) => p.dataset.a));
        hot = [...into, ...paths.filter((p) => feeders.has(p.dataset.b))];
      }
      const ids = new Set([id]);
      hot.forEach((p) => { ids.add(p.dataset.a); ids.add(p.dataset.b); });
      wrap.classList.add("is-focus");
      paths.forEach((p) => p.classList.toggle("is-hot", hot.includes(p)));
      wrap.querySelectorAll(".tr-node").forEach((n) => n.classList.toggle("is-hot", ids.has(n.dataset.id)));
    };
    const off = () => { wrap.classList.remove("is-focus"); wrap.querySelectorAll(".is-hot").forEach((n) => n.classList.remove("is-hot")); };
    wrap.addEventListener("pointerover", (e) => { const n = e.target.closest(".tr-node"); if (n) on(n.dataset.id); else off(); });
    wrap.addEventListener("pointerleave", off);
    wrap.addEventListener("focusin", (e) => { const n = e.target.closest(".tr-node"); if (n) on(n.dataset.id); });
    wrap.addEventListener("focusout", off);
  }
  let resizeT = null;
  window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (view === "tree") render(); }, 150); });

  function render() {
    if (!data) return;
    if (view === "page") { $("sc-root").replaceChildren(byPage()); return; }
    if (view === "tree") { $("sc-root").replaceChildren(tree()); return; }
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
      figs(); if (view !== "tree" || !document.querySelector(".tr-wrap")) render();
    } catch (error) { $("sc-root").replaceChildren(el("p", { class: "muted", text: `Couldn't load the schema: ${error.message}` })); }
  }
  load();
  setInterval(load, 60_000);
})();
