// Plan an order: pick the products, the planner sizes each line from demand,
// meets every supplier's minimum load, and ranks single-supplier and split
// scenarios with the full supplier cost model.
(function () {
  "use strict";
  const { api, fmt, el, toast, loadMe } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let me = { canEdit: true };
  let products = [];
  let picked = new Set();
  const qty = {}; // productId → tonnes typed by the user
  let plan = null;
  let chosen = 0; // index of the scenario shown
  let appetite = "balanced";
  let fill = (() => { try { return localStorage.getItem("agx-fill") === "min" ? "min" : "full"; } catch { return "full"; } })();
  let timer = null, seq = 0;

  const readCbam = () => { try { return localStorage.getItem("agx-cbam") === "on"; } catch { return false; } };
  const gbp = (v) => (Number.isFinite(v) ? `£${Math.round(v).toLocaleString("en-GB")}` : "—");
  const t1 = (v) => (Number.isFinite(v) ? `${Math.round(v * 10) / 10} t` : "—");
  const dmy = (iso) => (iso ? fmt.date(iso) : "—");
  const NEEDS = ["critical", "reorder", "low"];
  const STATUS = { critical: ["Order now", "is-risk"], reorder: ["Order now", "is-risk"], low: ["Order soon", "is-maybe"], ok: ["Stock OK", "is-go"], "no-usage": ["No usage", ""] };
  const APPROACHES = [["cashflow", "Cash flow"], ["speed", "Speed"], ["balanced", "Balanced"]];
  const COLORS = ["#2a78d6", "#4f9a8f", "#6250d6", "#c2862a", "#c4553a", "#5b7083", "#8a5bb0", "#3f8f4f"];
  const colorOf = (pid) => COLORS[Math.max(0, products.findIndex((p) => p.id === pid)) % COLORS.length];

  // ---------------------------------------------------------------- settings bar
  function fillForm() {
    $("pf-appetite").replaceChildren(...APPROACHES.map(([k, l]) => el("button", { type: "button", role: "radio", "aria-checked": String(appetite === k), "aria-pressed": String(appetite === k), tabindex: appetite === k ? "0" : "-1", text: l,
      onclick: () => { appetite = k; fillForm(); run(); },
      onkeydown: (e) => { if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return; e.preventDefault(); const i = APPROACHES.findIndex((x) => x[0] === appetite); appetite = APPROACHES[(i + (e.key === "ArrowRight" ? 1 : 2)) % 3][0]; fillForm(); $("pf-appetite").querySelector('[aria-checked="true"]').focus(); run(); } })));
    for (const b of $("pf-fill").querySelectorAll("button")) { const on2 = b.dataset.fill === fill; b.setAttribute("aria-checked", String(on2)); b.setAttribute("aria-pressed", String(on2)); }
    const on = readCbam(), sw = $("pf-cbam");
    sw.classList.toggle("is-on", on); sw.setAttribute("aria-checked", String(on));
    sw.querySelector(".pf-switch-text").textContent = on ? "Included" : "Not included";
  }

  // ---------------------------------------------------------------- product picker
  function needOf(p) { return Number(qty[p.id]) > 0 ? Number(qty[p.id]) : p.needT > 0 ? p.needT : Math.max(1, Math.ceil(p.usage || 1)); }
  function renderPicker() {
    const order = [...products].sort((a, b) => Number(!NEEDS.includes(a.status)) - Number(!NEEDS.includes(b.status)) || (a.coverMonths ?? 99) - (b.coverMonths ?? 99));
    $("bk-list").replaceChildren(...order.map((p) => {
      const on = picked.has(p.id);
      const [label, cls] = STATUS[p.status] || [p.status, ""];
      const input = el("input", { type: "number", min: "0.1", step: "0.1", inputmode: "decimal", class: "bk-qty-in", value: String(needOf(p)), disabled: on ? null : "", "aria-label": `${p.name} tonnes`,
        oninput: (e) => { qty[p.id] = e.target.value; total(); schedule(); } });
      return el("li", { class: `bk-row${on ? " is-on" : ""}`, style: `--c:${colorOf(p.id)}` },
        el("label", { class: "bk-check" },
          el("input", { type: "checkbox", checked: on ? "" : null, onchange: (e) => { if (e.target.checked) picked.add(p.id); else picked.delete(p.id); renderPicker(); run(); } }),
          el("span", { class: "bk-swatch", "aria-hidden": "true" }),
          el("span", { class: "bk-name" }, el("strong", { text: p.name }), el("span", { class: "bk-meta" }, el("span", { class: `sig ${cls}`, text: label }), `${t1(p.stockT)} · ${p.coverMonths !== null && p.coverMonths !== undefined ? `${p.coverMonths.toFixed(1)} mo` : "—"}`))),
        el("span", { class: "bk-qty" }, input, el("span", { text: "t" })));
    }));
    total();
  }
  function total() {
    const sel = products.filter((p) => picked.has(p.id));
    $("bk-total").replaceChildren(el("span", { text: `${sel.length} product${sel.length === 1 ? "" : "s"}` }), el("strong", { text: t1(sel.reduce((n, p) => n + needOf(p), 0)) }));
  }
  document.querySelector(".bk-quick").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pick]"); if (!b) return;
    picked = new Set(b.dataset.pick === "all" ? products.map((p) => p.id) : b.dataset.pick === "need" ? products.filter((p) => NEEDS.includes(p.status)).map((p) => p.id) : []);
    renderPicker(); run();
  });

  // ---------------------------------------------------------------- run
  function schedule() { clearTimeout(timer); timer = setTimeout(run, 400); }
  async function run() {
    const my = ++seq;
    if (!picked.size) { plan = null; $("plan").replaceChildren(el("div", { class: "card bk-empty" }, el("p", { class: "muted", text: "Pick the products to order" }))); return; }
    $("plan").classList.add("is-busy");
    try {
      const quantities = {};
      for (const p of products) if (picked.has(p.id)) quantities[p.id] = needOf(p);
      const r = await api("/api/orders/basket", { method: "POST", body: { productIds: [...picked], quantities, appetite, fill, cbam: readCbam() } });
      if (my !== seq) return;
      plan = r; chosen = 0;
      renderAssumptions(r); render();
    } catch (error) {
      if (my === seq) $("plan").replaceChildren(el("p", { class: "muted", text: `Couldn't plan this order: ${error.message}` }));
    } finally { if (my === seq) $("plan").classList.remove("is-busy"); }
  }

  function renderAssumptions(r) {
    const a = r.assumptions; if (!a) return;
    const v = a.values, p = (a.approaches || {})[r.appetite] || {};
    $("asm-strip").replaceChildren(
      el("span", { class: "asm-strip-label", text: "Assumptions" }),
      el("span", { class: "asm-strip-ap", text: (APPROACHES.find((x) => x[0] === r.appetite) || APPROACHES[2])[1] }),
      ...[p.quotaWeightPct !== undefined ? `Quota ${p.quotaWeightPct}%` : null, r.appetite === "cashflow" && p.cashRatePct !== undefined ? `Cash ${p.cashRatePct}%/yr` : null, r.appetite === "speed" && p.leadDayPct !== undefined ? `Lead ${p.leadDayPct}%/day` : null,
        `Capital ${v.costOfCapitalPct}%`, `Storage £${v.forecastStoragePerTMonth}/t a month`, v.splitOrderCost ? `Second supplier £${v.splitOrderCost}` : null].filter(Boolean).map((t) => el("span", { text: t })),
      el("a", { href: "assumptions.html", class: "asm-strip-edit", text: "Edit" }));
    $("asm-strip").hidden = false;
  }

  // ---------------------------------------------------------------- results
  function loadBar(part) {
    const cap = part.moqMaxT ? part.moqMaxT * part.loads : Math.max(part.totalT, part.moqMinT || 0);
    const scale = Math.max(cap, part.totalT) || 1;
    const minAt = part.moqMinT ? (part.moqMaxT && part.loads > 1 ? (part.loads - 1) * part.moqMaxT + part.moqMinT : part.moqMinT) : null;
    return el("div", { class: "pkg-bar bk-bar-load", role: "img", "aria-label": `${t1(part.totalT)}${part.moqMinT ? `, minimum ${part.moqMinT} t` : ""}` },
      ...part.lines.flatMap((l) => [
        el("span", { class: "pkg-seg", style: `width:${(l.needT / scale) * 100}%;--c:${colorOf(l.productId)}`, title: `${l.name} · need ${t1(l.needT)}` }),
        l.extraT > 0 ? el("span", { class: "pkg-seg is-fwd", style: `width:${(l.extraT / scale) * 100}%;--c:${colorOf(l.productId)}`, title: `${l.name} · +${t1(l.extraT)} to meet the minimum` }) : null]).filter(Boolean),
      minAt ? el("i", { class: "pkg-min", style: `left:${Math.min(100, (minAt / scale) * 100)}%`, title: `Minimum ${part.moqMinT} t` }) : null,
      ...(part.moqMaxT && part.loads > 1 ? Array.from({ length: part.loads - 1 }, (_, i) => el("i", { class: "pkg-load", style: `left:${(((i + 1) * part.moqMaxT) / scale) * 100}%` })) : []));
  }

  function partBlock(part) {
    const tags = [part.origin && part.origin !== "UK" ? part.origin : "UK", part.origin && part.origin !== "UK" ? (part.ddp === "yes" ? "DDP" : part.ddp === "no" ? "No DDP" : null) : null, Number.isFinite(part.paymentDays) ? `${part.paymentDays} days` : null, Number.isFinite(part.onTimePct) ? `${part.onTimePct}% on time` : null].filter(Boolean);
    return el("div", { class: "bk-part" },
      el("div", { class: "bk-part-head" },
        el("div", {}, el("strong", { class: "bk-part-name", text: part.supplier }), el("span", { class: "bk-part-tags", text: tags.join(" · ") })),
        el("div", { class: "bk-part-load" }, el("strong", { text: t1(part.totalT) }), el("span", { text: part.loads > 1 ? `${part.loads} × ${part.moqMaxT} t` : part.moqMinT ? `min ${part.moqMinT}${part.moqMaxT && part.moqMaxT !== part.moqMinT ? `–${part.moqMaxT}` : ""} t` : "no minimum" }))),
      loadBar(part),
      el("table", { class: "bk-lines" },
        el("thead", {}, el("tr", {}, ...["Product", "Need", "Buy", "Landed", "Arrives"].map((h, i) => el("th", { class: i ? "num" : "", text: h })))),
        el("tbody", {}, ...part.lines.map((l) => el("tr", {},
          el("td", {}, el("span", { class: "bk-dot", style: `--c:${colorOf(l.productId)}` }), l.name),
          el("td", { class: "num", text: t1(l.needT) }),
          el("td", { class: "num" }, el("strong", { text: t1(l.tonnes) }), l.extraT > 0 ? el("span", { class: "bk-extra", text: ` +${t1(l.extraT)}` }) : null),
          el("td", { class: "num", text: `£${l.perT}/t` }),
          el("td", { class: `num${l.lateDays ? " is-bad" : ""}`, text: l.arrival ? `${dmy(l.arrival)}${l.lateDays ? ` · ${l.lateDays}d late` : ""}` : "—" }))))));
  }

  function hero(s, i) {
    const title = s.kind === "single" ? `Bulk order from ${s.parts[0].supplier}` : `Bulk order split: ${s.parts.map((p) => p.supplier).join(" + ")}`;
    const fig = (k, v, cls) => el("div", { class: "bk-fig" }, el("span", { text: k }), el("strong", { class: cls || "", text: v }));
    return el("section", { class: "card bk-hero" },
      el("div", { class: "bk-hero-top" },
        el("span", { class: `sig ${i === 0 ? "is-go" : ""}`, text: i === 0 ? "Best scenario" : `Scenario ${i + 1}` }),
        el("h2", { text: title })),
      el("div", { class: "bk-figs" },
        fig("Order total", gbp(s.landed)),
        fig("Per tonne", `£${s.perT}`),
        fig("Real £/t", `£${s.scorePerT}`),
        fig("Extra stock", s.extraT > 0 ? `+${t1(s.extraT)}` : "None"),
        fig("Quota risk", s.risk > 0 ? gbp(s.risk) : "None", s.risk > 0 ? "is-warn" : ""),
        fig("Arrives", s.arrival ? dmy(s.arrival).replace(/ \d{4}$/, "") : "—", s.lateDays ? "is-bad" : "")),
      ...s.parts.map(partBlock),
      s.warnings.length ? el("ul", { class: "bk-warn" }, ...s.warnings.slice(0, 4).map((w) => el("li", { text: w }))) : null,
      me.canEdit ? el("div", { class: "bk-actions" }, el("button", { type: "button", class: "btn btn-primary", id: "bk-save", text: `Save ${s.parts.reduce((n, p) => n + p.lines.length, 0)} orders${s.parts.length > 1 ? ` · ${s.parts.length} loads` : " · one load"}`, onclick: () => save(s) })) : null);
  }

  function table(r) {
    return el("section", { class: "card bk-scen" },
      el("h2", { text: "Scenarios" }),
      el("div", { class: "table-scroll" }, el("table", { class: "bk-table" },
        el("thead", {}, el("tr", {}, ...["", "Suppliers", "Load", "Extra", "Total", "Real £/t", "Arrives"].map((h, i) => el("th", { class: i > 1 ? "num" : "", text: h })))),
        el("tbody", {}, ...r.scenarios.map((s, i) => el("tr", { class: `bk-srow${i === chosen ? " is-on" : ""}`, tabindex: "0", style: `--d:${i * 35}ms`,
          onclick: () => { chosen = i; render(); }, onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chosen = i; render(); } } },
          el("td", {}, el("span", { class: "bk-rank", text: String(i + 1) })),
          el("td", {}, el("strong", { text: s.parts.map((p) => p.supplier).join(" + ") }), el("div", { class: "row-sub", text: s.parts.map((p) => `${t1(p.totalT)}`).join(" + ") })),
          el("td", { class: "num", text: t1(s.totalT) }),
          el("td", { class: `num${s.extraT > 0 ? " is-warn" : ""}`, text: s.extraT > 0 ? `+${t1(s.extraT)}` : "—" }),
          el("td", { class: "num", text: gbp(s.landed) }),
          el("td", { class: "num" }, el("strong", { text: `£${s.scorePerT}` })),
          el("td", { class: `num${s.lateDays ? " is-bad" : ""}`, text: dmy(s.arrival) })))))));
  }

  function render() {
    const r = plan;
    if (!r) return;
    if (!r.scenarios.length) { $("plan").replaceChildren(el("div", { class: "card bk-empty" }, el("p", { class: "muted", text: r.uncovered.length ? `No supplier can price ${r.uncovered.join(", ")} yet` : "No supplier can price these products yet" }))); return; }
    const s = r.scenarios[chosen] || r.scenarios[0];
    $("plan").replaceChildren(...[
      hero(s, chosen),
      r.uncovered.length ? el("p", { class: "bk-miss", text: `No supplier quote for ${r.uncovered.join(", ")}` }) : null,
      table(r)].filter(Boolean));
  }

  async function save(s) {
    const btn = $("bk-save"); btn.disabled = true;
    try {
      const res = await api("/api/orders/basket/save", { method: "POST", body: { cbam: readCbam(), parts: s.parts.map((p) => ({ supplierId: p.supplierId, lines: p.lines.map((l) => ({ productId: l.productId, tonnes: l.tonnes })) })) } });
      toast(`Saved ${res.ids.length} orders`);
      setTimeout(() => { location.href = "orders.html"; }, 700);
    } catch (error) { toast(error.message, true); btn.disabled = false; }
  }

  // ---------------------------------------------------------------- start
  $("pf-fill").addEventListener("click", (e) => { const b = e.target.closest("button[data-fill]"); if (!b) return; fill = b.dataset.fill; try { localStorage.setItem("agx-fill", fill); } catch { /* blocked */ } fillForm(); run(); });
  $("pf-cbam").addEventListener("click", () => { try { localStorage.setItem("agx-cbam", readCbam() ? "off" : "on"); } catch { /* blocked */ } fillForm(); run(); });
  $("plan-form").addEventListener("submit", (e) => { e.preventDefault(); run(); });
  loadMe().then((m) => { me = m; if (plan) render(); }).catch(() => {});
  fillForm();
  api("/api/orders/basket", { method: "POST", body: { productIds: [], appetite, fill, cbam: readCbam() } }).then((r) => {
    products = r.products;
    const want = new URLSearchParams(location.search).get("product");
    picked = new Set(r.selected.map((x) => x.productId));
    if (want && products.some((p) => p.id === want)) picked.add(want);
    renderPicker();
    if (want && !r.selected.some((x) => x.productId === want)) run();
    else { plan = r; renderAssumptions(r); render(); }
  }).catch((error) => { $("plan").replaceChildren(el("p", { class: "muted", text: `Couldn't load products: ${error.message}` })); });
})();
