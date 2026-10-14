(function () {
  "use strict";
  const { api, fmt, el, toast, loadMe } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  const drawer = $("drawer");
  const form = $("view-form");
  const field = (n) => form.elements.namedItem(n);

  // Product groups → UK steel-measure categories the group mostly falls in.
  const GROUP_CATEGORIES = {
    "Merchant Bar": ["12B"], "Structural Sections": ["17"], "Hollow Sections": ["21"], "Plate & Sheet": ["1", "7", "4"],
    "Bright Bar": ["27"], Reinforcing: ["13"], "Wire & Rod": ["16", "28"], Stainless: ["14"],
  };
  const SOURCE_LINKS = {
    MEPS: "https://mepsinternational.com", Kallanish: "https://www.kallanish.com", Fastmarkets: "https://www.fastmarkets.com", Argus: "https://www.argusmedia.com",
  };
  const RISK = { exhausted: ["Used up", "is-bad"], critical: ["Runs out this quarter", "is-bad"], watch: ["Under 30% left", "is-warn"], open: ["Open", ""], blocked: ["Blocked", "is-bad"], unknown: ["No data", "is-muted"] };
  const SYM = { GBP: "£", EUR: "€", USD: "$" };
  const SIZE_KEY = "agx-profile-size";

  let suppliers = [];
  let costs = {}; // supplier id → full cost model totals (expected / if missed)
  // UK CBAM toggle (remembered per browser)
  let cbamOn = false;
  try { cbamOn = localStorage.getItem("agx-cbam") === "on"; } catch { /* storage blocked */ }
  function setCbam(on) {
    cbamOn = Boolean(on);
    try { localStorage.setItem("agx-cbam", cbamOn ? "on" : "off"); } catch { /* storage blocked */ }
    const t = document.getElementById("cbam-toggle");
    if (t) t.checked = cbamOn;
    document.body.classList.toggle("cbam-on", cbamOn);
    costs = {};
    renderTable();
    loadCosts();
    if (mode === "detail" && detailId) { const s = suppliers.find((x) => x.id === detailId); if (s && tab === "breakdown") loadBreakdown(s, { ...bd.opts }); if (s) renderBody(s); }
  }
  let listOrder = []; // ids in the order the table shows them (for prev / next)
  let choices = null;
  let products = [];
  let quota = null;
  let settings = {};
  let me = { canEdit: true };
  let mode = null;
  let detailId = null;
  let tab = "overview";
  let dirty = false;
  let lastFocus = null;
  let highlightId = null;
  let large = false;
  try { large = localStorage.getItem(SIZE_KEY) === "large"; } catch { /* storage unavailable */ }

  // ---------------------------------------------------------------- helpers
  const money = (v, cur = "GBP") => (Number.isFinite(v) ? `${SYM[cur] || ""}${Math.round(v).toLocaleString("en-GB")}` : "—");
  const perT = (v, cur) => (Number.isFinite(v) ? `${money(v, cur)}/t` : "—");
  const todayIso = () => new Date().toISOString().slice(0, 10);
  const addDays = (iso, d) => new Date(Date.parse(`${iso}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
  const fmtCode = (c) => String(c || "").replace(/^(\d{4})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4");
  const ago = (days) => (days === null || days === undefined ? "—" : days <= 0 ? "today" : days === 1 ? "yesterday" : days < 60 ? `${days} days ago` : `${Math.round(days / 30)} months ago`);
  const moq = (s) => (s.moqMinT === null ? "—" : s.moqMaxT && s.moqMaxT !== s.moqMinT ? `${s.moqMinT}–${s.moqMaxT} t` : `${s.moqMinT} t`);
  const lead = (s) => (s.leadTimeMin === null ? "—" : `${s.leadTimeMin}${s.leadTimeMax && s.leadTimeMax !== s.leadTimeMin ? `–${s.leadTimeMax}` : ""} ${s.leadTimeUnit}`);
  const terms = (s) => (s.paymentDays === null ? "—" : s.paymentDays === 0 ? "Pro-forma" : `${s.paymentDays} days`);
  const coversShort = (c) => ({ everything: "All-in", "except-duty": "+ duty", "ex-works": "Ex works", port: "To port" })[c] || "—";
  const isImport = (s) => s.origin && s.origin !== "UK";
  const firstName = (n) => String(n || "").split(/\s+/)[0];
  const chev = () => { const td = el("td", { class: "chev", "aria-hidden": "true" }); td.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m9 6 6 6-6 6"/></svg>'; return td; };

  function quotaFor(s) {
    if (!quota || !choices) return [];
    const cats = [...new Set((s.supplies || []).flatMap((g) => GROUP_CATEGORIES[g] || []))];
    return cats.map((categoryId) => {
      if (!s.origin) return { categoryId, kind: "unknown" };
      if (s.origin === "UK") return { categoryId, kind: "domestic" };
      if (s.origin === "Ukraine") return { categoryId, kind: "excluded" };
      const country = choices.euMembers.includes(s.origin) ? "European Union" : s.origin;
      const inCat = quota.lines.filter((l) => l.categoryId === categoryId);
      const line = inCat.find((l) => l.origin === country) || inCat.find((l) => l.residual);
      return line ? { categoryId, kind: "line", line } : { categoryId, kind: "none" };
    });
  }
  const categoryName = (id) => ((window.STEEL_TRADE_MEASURE && window.STEEL_TRADE_MEASURE.categories) || []).find((c) => c.id === id)?.name || "";

  function quotaChip(q) {
    if (!q) return null;
    if (q.kind === "domestic") return el("span", { class: "status-dot", text: "UK — no quota" });
    if (q.kind === "excluded") return el("span", { class: "status-dot", text: "Excluded from measure" });
    if (q.kind !== "line") return el("span", { class: "status-dot is-muted", text: "Origin not set" });
    const [label, cls] = RISK[q.line.risk] || [q.line.risk, ""];
    const left = q.line.found ? `${fmt.tonnesRound(q.line.balanceT)} left` : "";
    return el("span", { class: `status-dot ${cls}`, title: `${q.line.residual ? "Other origins" : q.line.origin} line ${q.line.orderNumber}`, text: `${label}${left ? ` · ${left}` : ""}` });
  }

  // ---------------------------------------------------------------- list
  function sorted(list) {
    const by = $("sort").value;
    const val = (s) => (by === "quoted" ? s.metrics.pricePerT : by === "ontime" ? -(s.onTimePct ?? -1) : by === "worst" ? (costs[s.id]?.worstPerT ?? s.metrics.worstCasePerT) : (costs[s.id]?.effectivePerT ?? s.metrics.worstCasePerT));
    if (by === "name") return [...list].sort((a, b) => a.name.localeCompare(b.name));
    return [...list].sort((a, b) => (val(a) ?? 1e9) - (val(b) ?? 1e9) || a.name.localeCompare(b.name));
  }

  function renderTable() {
    const q = $("q").value.trim().toLowerCase();
    const sup = $("flt-supplies").value;
    const org = $("flt-origin").value;
    const list = sorted(suppliers.filter((s) => {
      if (sup && !(s.supplies || []).includes(sup)) return false;
      if (org === "uk" && isImport(s)) return false;
      if (org === "import" && !isImport(s)) return false;
      if (!q) return true;
      return [s.name, s.origin, s.type, ...(s.supplies || []), ...(s.contacts || []).map((c) => c.name)].some((v) => String(v || "").toLowerCase().includes(q));
    }));
    listOrder = list.map((x) => x.id);
    const best = Math.min(...suppliers.map((s) => costs[s.id]?.effectivePerT).filter(Number.isFinite));
    $("rows").replaceChildren(...list.map((s) => {
      const m = s.metrics;
      const qline = quotaFor(s)[0];
      return el("tr", {
        class: `product-row supplier-row${s.id === highlightId ? " is-new" : ""}`, tabindex: "0",
        "aria-label": `${s.name}, ${perT(m.pricePerT, m.currency)}. Open profile`,
        onclick: () => openDetail(s.id),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(s.id); } },
      },
        el("td", {}, el("div", { class: "sup-cell" }, avatar(s.name),
          el("div", {},
            el("div", { class: "p-name" }, s.name, s.standing !== "active" ? el("span", { class: "tag tag-muted", text: choices.standing[s.standing] }) : null),
            el("div", { class: "p-meta" },
              el("span", { text: s.origin || "Origin not set" }),
              s.type ? el("span", { text: s.type }) : null,
              (s.supplies || []).length ? el("span", { text: s.supplies.join(", ") }) : null)))),
        el("td", { class: "num" },
          el("strong", { text: perT(m.pricePerT, m.currency) }),
          el("div", { class: "row-sub" }, el("span", { class: `tag ${m.covers === "everything" ? "" : "tag-warn"}`, text: coversShort(m.covers) }), m.priceExpired ? el("span", { class: "tag tag-bad", text: "expired" }) : null)),
        (() => {
          const c = costs[s.id];
          const sub = m.dutyUnknown ? "set origin to check" : m.covers === "everything" && isImport(s) && !m.dutyExposed ? "supplier carries duty" : !isImport(s) ? "no steel duty" : "";
          if (!c) return el("td", { class: "num" }, el("strong", { class: c === null ? "" : "is-pending", text: c === null ? "—" : "…" }), el("div", { class: "row-sub" }, sub));
          return el("td", { class: "num", title: `Every cost counted for ${c.tonnage} t of ${c.productName}${c.missing && c.missing.length ? ` · not yet costed: ${c.missing.join(", ").toLowerCase()}` : ""}` },
            el("strong", { class: c.effectivePerT === best ? "best" : "", text: perT(c.effectivePerT) }),
            el("div", { class: "row-sub" }, c.cbamPerT > 0.005 ? el("span", { class: "cbam-tag", text: `incl. ${perT(c.cbamPerT)} CBAM` }) : c.probability > 0.005 ? `${Math.round(c.probability * 100)}% quota risk priced in` : c.missPerT > 0.5 ? "quota lasts to arrival" : sub || "all costs in"));
        })(),
        (() => {
          const c = costs[s.id];
          if (!c || !(c.missPerT > 0.5)) return el("td", { class: "num" }, el("span", { class: "muted", text: c ? "nothing to miss" : "" }), el("div", { class: "row-sub" }, m.dutyExposed ? null : ""));
          return el("td", { class: "num" },
            el("strong", { class: "is-bad", text: `+${perT(c.missPerT)}` }),
            el("div", { class: "row-sub" }, quotaChip(qline) || `${money(c.missPerT * c.tonnage)} on ${c.tonnage} t`));
        })(),
        el("td", { text: s.moqNote || moq(s) }),
        el("td", { class: "num", text: s.onTimePct === null ? "—" : `${s.onTimePct}%` }),
        el("td", {}, el("span", { text: terms(s) }), el("div", { class: "row-sub", text: lead(s) })),
        el("td", {},
          m.awaitingQuote
            ? el("span", { class: "status-dot is-warn", text: `Awaiting reply · ${m.awaitingQuote.days ? `${m.awaitingQuote.days}d` : "today"}` })
            : el("span", { text: m.priceChannel === "list" ? "From supplier list" : ago(m.priceAgeDays) }),
          el("div", { class: "row-sub", text: m.primaryContact ? m.primaryContact.name : "No contact yet" })),
        chev());
    }));
    if (!list.length) $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "9", class: "empty", text: suppliers.length ? "No suppliers match these filters." : "No suppliers yet." })));
  }

  function renderSummary() {
    const cnt = document.getElementById("ptab-count");
    if (cnt) cnt.textContent = suppliers.length;
    const groups = [...new Set(suppliers.flatMap((s) => s.supplies || []))].sort();
    const cur = $("flt-supplies").value;
    $("flt-supplies").replaceChildren(el("option", { value: "", text: "Everything they supply" }), ...groups.map((g) => el("option", { value: g, text: g })));
    $("flt-supplies").value = groups.includes(cur) ? cur : "";
  }

  // ---------------------------------------------------------------- drawer
  function showDrawer(newMode, title, eyebrow) {
    mode = newMode;
    if (drawer.hidden) lastFocus = document.activeElement;
    $("drawer-title").textContent = title;
    $("drawer-eyebrow").textContent = eyebrow || "";
    $("drawer-avatar").hidden = true;
    $("drawer-tags").hidden = true;
    $("drawer-prev").hidden = true;
    $("drawer-next").hidden = true;
    $("view-detail").hidden = newMode !== "detail";
    form.hidden = newMode === "detail";
    $("profile-tabs").hidden = newMode !== "detail";
    drawer.classList.toggle("is-large", large);
    syncSize();
    drawer.hidden = false;
    $("backdrop").hidden = false;
    document.body.classList.add("drawer-open");
    dirty = false;
  }

  function closeDrawer(force) {
    if (!force && mode !== "detail" && dirty) {
      const btn = $("drawer-foot").querySelector("[data-cancel]");
      if (btn && !btn.dataset.confirm) {
        btn.dataset.confirm = "1"; btn.textContent = "Discard changes?"; btn.classList.add("btn-danger"); btn.focus();
        return;
      }
    }
    drawer.hidden = true;
    $("backdrop").hidden = true;
    document.body.classList.remove("drawer-open");
    mode = null;
    dirty = false;
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }

  const footer = (...nodes) => $("drawer-foot").replaceChildren(...nodes.filter(Boolean));
  function syncSize() {
    const b = $("drawer-size");
    b.setAttribute("aria-label", large ? "Switch to small view" : "Switch to large view");
    b.title = large ? "Small view" : "Large view";
    b.classList.toggle("is-large", large);
  }
  function setSize(v) {
    large = v;
    drawer.classList.toggle("is-large", large);
    syncSize();
    try { localStorage.setItem(SIZE_KEY, large ? "large" : "small"); } catch { /* ignore */ }
  }

  // Back to the profile after a sub-form (quote, contact, edit).
  const backToProfile = (id, t) => () => { closeDrawer(true); openDetail(id, t); };
  const cancelBtn = (onclick) => el("button", { class: "btn", type: "button", "data-cancel": "", text: "Cancel", onclick: onclick || (() => closeDrawer()) });

  // ---------------------------------------------------------------- form bits
  function fieldWrap(name, label, control, { hint, req, wide } = {}) {
    return el("div", { class: `field${wide ? " field-wide" : ""}`, "data-field": name },
      el("label", { for: `f-${name}` }, el("span", { class: "label-text" }, label, req ? el("span", { class: "req", "aria-hidden": "true", text: " *" }) : null)),
      control,
      hint ? el("span", { class: "hint", text: hint }) : null,
      el("span", { class: "error" }));
  }
  const text = (name, value, attrs = {}) => el("input", { id: `f-${name}`, name, value: value ?? "", autocomplete: "off", ...attrs });
  function select(name, options, value, { empty } = {}) {
    const opts = Array.isArray(options) ? options.map((o) => (Array.isArray(o) ? o : [o, o])) : Object.entries(options);
    const sel = el("select", { id: `f-${name}`, name }, ...(empty !== undefined ? [el("option", { value: "", text: empty })] : []), ...opts.map(([v, l]) => el("option", { value: String(v), text: l })));
    const v = value === null || value === undefined ? "" : String(value);
    if (v && ![...sel.options].some((o) => o.value === v)) sel.append(el("option", { value: v, text: v }));
    sel.value = v;
    return sel;
  }
  // Preset dropdown with "Other…" revealing a number box (value lives in the input).
  function preset(name, values, value, unit, { empty = "Not set" } = {}) {
    const input = el("input", { id: `f-${name}`, name, type: "number", min: "0", step: "any", "aria-label": `${name} ${unit}` });
    const box = el("span", { class: "input-unit", hidden: "" }, input, unit ? el("span", { text: unit }) : null);
    const sel = el("select", { "aria-label": unit, class: "preset" },
      el("option", { value: "", text: empty }), ...values.map((v) => el("option", { value: String(v), text: `${v}${unit ? ` ${unit}` : ""}` })), el("option", { value: "other", text: "Other…" }));
    const v = value === null || value === undefined ? "" : String(value);
    input.value = v;
    const has = v === "" || values.map(String).includes(v);
    sel.value = has ? v : "other";
    box.hidden = has;
    sel.addEventListener("change", () => {
      if (sel.value === "other") { box.hidden = false; input.focus(); } else { box.hidden = true; input.value = sel.value; }
    });
    return el("div", { class: "preset-wrap" }, sel, box);
  }
  function checks(name, options, values) {
    return el("div", { class: "chip-checks", role: "group", id: `f-${name}` }, ...options.map((o) => el("label", { class: "chip-check" },
      el("input", { type: "checkbox", name, value: o, ...(values.includes(o) ? { checked: "" } : {}) }), el("span", { text: o }))));
  }
  const checked = (name) => [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value);
  const section = (title, ...kids) => el("fieldset", {}, el("legend", { text: title }), ...kids);

  function showErrors(errors = {}) {
    form.querySelectorAll("[data-field]").forEach((f) => {
      const msg = errors[f.dataset.field];
      f.classList.toggle("has-error", Boolean(msg));
      const slot = f.querySelector(":scope > .error");
      if (slot) slot.textContent = msg || "";
    });
    const first = form.querySelector(".has-error input, .has-error select, .has-error textarea");
    if (first) first.focus();
  }

  async function submit(btn, request, onDone) {
    btn.disabled = true;
    try {
      const res = await request();
      dirty = false;
      await onDone(res);
    } catch (error) {
      const errors = (error.data && error.data.errors) || {};
      showErrors(errors);
      toast(Object.keys(errors).length ? "Check the highlighted fields" : error.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- supplier form
  function openSupplierForm(s) {
    const c = choices;
    showDrawer("form", s ? `Edit ${s.name}` : "Add supplier", s ? s.origin || "Supplier" : "New supplier");
    const v = s || { standing: "active", currency: "GBP", leadTimeUnit: "weeks", supplies: settings.defaultCategory ? [settings.defaultCategory] : [], pricingSources: [] };
    form.replaceChildren(
      section("Supplier",
        fieldWrap("name", "Name", text("name", v.name, { maxlength: "120", placeholder: "e.g. Megasa" }), { req: true }),
        el("div", { class: "grid-2" },
          fieldWrap("origin", "Origin of the steel", select("origin", c.origins, v.origin, { empty: "Choose country" }), { hint: "Decides which quota line applies." }),
          fieldWrap("type", "Type", select("type", c.types, v.type, { empty: "Not set" })),
          fieldWrap("standing", "Standing", select("standing", c.standing, v.standing)),
          fieldWrap("website", "Website", text("website", v.website, { placeholder: "www.example.com", inputmode: "url" }))),
        fieldWrap("supplies", "Supplies", checks("supplies", c.groups, v.supplies || []), { hint: "Links the supplier to your products in those groups." })),
      section("Price",
        el("div", { class: "grid-2" },
          fieldWrap("priceCovers", "Price covers", select("priceCovers", c.priceCovers, v.priceCovers, { empty: "Not set" })),
          fieldWrap("deliveryTerms", "Delivery terms", select("deliveryTerms", c.deliveryTerms, v.deliveryTerms, { empty: "Not set" })),
          fieldWrap("transport", "Transport", select("transport", { included: "Included in price", extra: "Charged extra" }, v.transport, { empty: "Not set" })),
          fieldWrap("ddp", "DDP available", select("ddp", c.ddp, v.ddp, { empty: "Not set" })),
          fieldWrap("currency", "Quotes in", select("currency", c.currencies, v.currency))),
        fieldWrap("pricingSources", "Pricing benchmarked against", checks("pricingSources", c.pricingSources, v.pricingSources || []))),
      section("Terms & service",
        el("div", { class: "grid-2" },
          fieldWrap("moqMinT", "MOQ from", preset("moqMinT", [1, 5, 10, 15, 20, 23, 24, 25, 26, 28, 30, 50, 100], v.moqMinT, "t", { empty: "None" })),
          fieldWrap("moqMaxT", "MOQ up to", preset("moqMaxT", [5, 10, 15, 20, 23, 25, 26, 28, 30, 50, 100], v.moqMaxT, "t", { empty: "Same" })),
          fieldWrap("leadTimeMin", "Lead time from", preset("leadTimeMin", [1, 2, 3, 4, 5, 6, 7, 8, 10, 12], v.leadTimeMin, "")),
          fieldWrap("leadTimeMax", "Lead time up to", preset("leadTimeMax", [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 16], v.leadTimeMax, "", { empty: "Same" })),
          fieldWrap("leadTimeUnit", "Lead time in", select("leadTimeUnit", { days: "Days", weeks: "Weeks" }, v.leadTimeUnit)),
          fieldWrap("onTimePct", "On-time delivery", preset("onTimePct", [50, 60, 70, 75, 80, 85, 90, 95, 100], v.onTimePct, "%")),
          fieldWrap("paymentDays", "Payment terms", preset("paymentDays", [0, 7, 14, 30, 45, 60, 90, 120], v.paymentDays, "days")),
          fieldWrap("paymentNote", "Payment note", text("paymentNote", v.paymentNote, { maxlength: "120", placeholder: "e.g. may move to 30 days" })))),
      section("Carbon (UK CBAM)",
        el("div", { class: "grid-2" },
          fieldWrap("productionRoute", "How the mill makes steel", select("productionRoute", { eaf: "Electric arc furnace (scrap)", "bf-bof": "Blast furnace (iron ore)" }, v.productionRoute, { empty: "Not known" })),
          fieldWrap("emissionsPerT", "Verified emissions", text("emissionsPerT", v.emissionsPerT, { type: "number", min: "0", max: "5", step: "0.01", placeholder: "t CO₂e per tonne" }), { hint: "From the mill's verified report. Leave blank to use the default for the route." }),
          fieldWrap("carbonPricePaidPerT", "Carbon price already paid", text("carbonPricePaidPerT", v.carbonPricePaidPerT, { type: "number", min: "0", max: "500", step: "0.01", placeholder: "£ per t CO₂e" }), { hint: "e.g. EU ETS cost passed through. Only counts with a CarbonVP1 report from the mill." }))),
      section("Notes",
        el("div", { class: "grid-2" },
          fieldWrap("dutyCosts", "Duty costs", select("dutyCosts", ["Not applicable", "Up to 50%", "50%", "Included in price"], v.dutyCosts, { empty: "Not set" })),
          fieldWrap("otherDuty", "Other duty", select("otherDuty", ["Not applicable", "0%", "Ordinary duty applies"], v.otherDuty, { empty: "Not set" }))),
        fieldWrap("dutyRiskNote", "Duty risk (quota dependent)", text("dutyRiskNote", v.dutyRiskNote, { maxlength: "300", placeholder: "How they handle quota and duty" })),
        fieldWrap("notes", "Notes", el("textarea", { id: "f-notes", name: "notes", rows: "3", maxlength: "1000", text: v.notes || "" }))));
    form.onsubmit = (e) => {
      e.preventDefault();
      const body = {};
      for (const k of ["name", "origin", "type", "standing", "website", "priceCovers", "deliveryTerms", "transport", "ddp", "currency", "moqMinT", "moqMaxT", "leadTimeMin", "leadTimeMax", "leadTimeUnit", "onTimePct", "paymentDays", "paymentNote", "dutyCosts", "otherDuty", "dutyRiskNote", "productionRoute", "emissionsPerT", "carbonPricePaidPerT", "notes"]) body[k] = field(k).value;
      if (body.moqMaxT === "") body.moqMaxT = body.moqMinT;
      if (body.leadTimeMax === "") body.leadTimeMax = body.leadTimeMin;
      body.supplies = checked("supplies");
      body.pricingSources = checked("pricingSources");
      if (s) body.moqNote = s.moqNote && body.moqMinT === String(s.moqMinT) && body.moqMaxT === String(s.moqMaxT) ? s.moqNote : "";
      submit($("save-btn"), () => (s ? api(`/api/suppliers/${s.id}`, { method: "PUT", body }) : api("/api/suppliers", { method: "POST", body })), async (saved) => {
        toast(s ? `${saved.name} updated` : `${saved.name} added`);
        highlightId = saved.id;
        await load();
        closeDrawer(true);
        openDetail(saved.id, s ? undefined : "contacts");
      });
    };
    const archiveBtn = s && me.canEdit ? el("button", { class: "btn btn-danger-quiet", type: "button", text: "Archive supplier", onclick: async () => {
      if (archiveBtn.dataset.confirm !== "1") { archiveBtn.dataset.confirm = "1"; archiveBtn.textContent = `Archive ${s.name}?`; archiveBtn.classList.add("btn-danger"); return; }
      try { await api(`/api/suppliers/${s.id}/archive`, { method: "POST" }); toast(`${s.name} archived`); closeDrawer(true); await load(); } catch (error) { toast(error.message, true); }
    } }) : null;
    footer(archiveBtn, el("span", { class: "spacer" }), cancelBtn(s ? backToProfile(s.id) : null), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", id: "save-btn", text: s ? "Save changes" : "Add supplier" }));
    field("name").focus();
  }

  // ---------------------------------------------------------------- quote form
  function openQuoteForm(s, { productId } = {}) {
    showDrawer("form", `Log a quote — ${s.name}`, "Quote received");
    const supplied = products.filter((p) => (s.supplies || []).includes(p.category));
    const others = products.filter((p) => !supplied.includes(p));
    const productSel = el("select", { id: "f-productId", name: "productId" },
      el("option", { value: "", text: "General price — not for one product" }),
      supplied.length ? el("optgroup", { label: "They supply" }, ...supplied.map((p) => el("option", { value: p.id, text: p.name }))) : null,
      others.length ? el("optgroup", { label: "Other products" }, ...others.map((p) => el("option", { value: p.id, text: p.name }))) : null);
    const awaiting = (s.rfqs || []).filter((r) => r.status === "open").sort((a, b) => b.at.localeCompare(a.at))[0];
    if (productId) productSel.value = productId;
    else if (awaiting && awaiting.lines.length === 1 && awaiting.lines[0].productId) productSel.value = awaiting.lines[0].productId;
    form.replaceChildren(
      awaiting ? el("p", { class: "notice", text: `This will answer your quote request from ${fmt.date(awaiting.at.slice(0, 10))} (${awaiting.lines.map((l) => l.name).join(", ")}).` }) : null,
      section("Price",
        el("div", { class: "grid-2" },
          fieldWrap("pricePerT", "Price per tonne", el("span", { class: "input-unit input-unit-pre" }, el("span", { text: SYM[s.currency] || "£" }), el("input", { id: "f-pricePerT", name: "pricePerT", type: "number", min: "0", step: "0.01", inputmode: "decimal" }), el("span", { text: "/t" })), { req: true }),
          fieldWrap("currency", "Currency", select("currency", choices.currencies, s.currency)),
          fieldWrap("covers", "Price covers", select("covers", choices.priceCovers, s.priceCovers, { empty: "Not stated" })),
          fieldWrap("date", "Quoted on", el("input", { id: "f-date", name: "date", type: "date", value: todayIso(), max: todayIso() })),
          fieldWrap("validFor", "Valid for", select("validFor", [["", "Not stated"], ["1", "1 day"], ["3", "3 days"], ["7", "1 week"], ["14", "2 weeks"], ["30", "1 month"]], ""))),
      ),
      section("What for",
        el("div", { class: "grid-2" },
          fieldWrap("productId", "Product", productSel, { wide: true }),
          fieldWrap("tonnage", "Tonnage", preset("tonnage", [5, 10, 15, 20, 23, 25, 28, 50, 100], null, "t", { empty: "Not stated" })),
          fieldWrap("channel", "Received by", select("channel", Object.fromEntries(Object.entries(choices.quoteChannels).filter(([k]) => k !== "list")), "email")),
          (s.contacts || []).length ? fieldWrap("contactId", "From", select("contactId", s.contacts.map((c) => [c.id, c.name]), (s.contacts.find((c) => c.primary) || s.contacts[0]).id)) : null),
        fieldWrap("note", "Note", text("note", "", { maxlength: "500", placeholder: "e.g. mill, origin of melt, conditions" }))));
    form.onsubmit = (e) => {
      e.preventDefault();
      const date = field("date").value;
      const valid = field("validFor").value;
      const body = {
        pricePerT: field("pricePerT").value, currency: field("currency").value, covers: field("covers").value, date,
        validUntil: valid && date ? addDays(date, Number(valid)) : "", productId: field("productId").value, tonnage: field("tonnage").value,
        channel: field("channel").value, contactId: field("contactId") ? field("contactId").value : "", note: field("note").value,
      };
      submit($("save-btn"), () => api(`/api/suppliers/${s.id}/quotes`, { method: "POST", body }), async () => {
        toast("Quote logged");
        await load();
        backToProfile(s.id, "quotes")();
      });
    };
    footer(el("span", { class: "spacer" }), cancelBtn(backToProfile(s.id)), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", id: "save-btn", text: "Log quote" }));
    field("pricePerT").focus();
  }

  // ---------------------------------------------------------------- contact form
  function openContactForm(s, c) {
    showDrawer("form", c ? `Edit ${c.name}` : `Add a contact — ${s.name}`, s.name);
    form.replaceChildren(
      section("Contact",
        fieldWrap("name", "Name", text("name", c?.name, { maxlength: "80", autocomplete: "name" }), { req: true }),
        fieldWrap("role", "Role", select("role", ["Sales", "Account manager", "Sales director", "Logistics", "Credit control", "Quality", "Director"], c?.role, { empty: "Not set" })),
        el("div", { class: "grid-2" },
          fieldWrap("email", "Email", text("email", c?.email, { type: "email", inputmode: "email", autocomplete: "email", maxlength: "120" }), { hint: "Quote requests are sent here." }),
          fieldWrap("phone", "Phone", text("phone", c?.phone, { type: "tel", inputmode: "tel", autocomplete: "tel", maxlength: "40" }))),
        el("label", { class: "check-line" }, el("input", { type: "checkbox", name: "primary", ...((c ? c.primary : !(s.contacts || []).length) ? { checked: "" } : {}) }), " Main contact for quotes")));
    form.onsubmit = (e) => {
      e.preventDefault();
      const body = { name: field("name").value, role: field("role").value, email: field("email").value, phone: field("phone").value, primary: field("primary").checked };
      submit($("save-btn"), () => api(`/api/suppliers/${s.id}/contacts${c ? `/${c.id}` : ""}`, { method: c ? "PUT" : "POST", body }), async () => {
        toast(c ? "Contact updated" : "Contact added");
        await load();
        backToProfile(s.id, "contacts")();
      });
    };
    footer(el("span", { class: "spacer" }), cancelBtn(backToProfile(s.id, "contacts")), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", id: "save-btn", text: c ? "Save contact" : "Add contact" }));
    field("name").focus();
  }

  // ---------------------------------------------------------------- quote requests
  // Pick products + suppliers, then send each supplier a pre-written email
  // from your own mail app (or copy it). Each send is logged on the supplier
  // so the list shows who you're waiting on.
  function openRfq({ supplierId, productId } = {}) {
    showDrawer("form", "Request quotes", "Quote request");
    const needs = (p) => ["critical", "reorder", "low"].includes(p.metrics?.status);
    const sup = supplierId ? suppliers.find((x) => x.id === supplierId) : null;
    const pre = new Set(productId ? [productId] : products.filter((p) => needs(p) && (!sup || (sup.supplies || []).includes(p.category))).map((p) => p.id));
    const productRows = products.map((p) => {
      const sug = p.metrics?.suggestedOrderT || "";
      return el("label", { class: "rfq-line" },
        el("input", { type: "checkbox", name: "rfqProduct", value: p.id, ...(pre.has(p.id) ? { checked: "" } : {}) }),
        el("span", { class: "rfq-name" }, el("strong", { text: p.name }), el("small", { text: `${p.category}${p.spec ? ` · ${p.spec}` : ""}${needs(p) ? " · needs ordering" : ""}` })),
        el("span", { class: "input-unit rfq-qty" }, el("input", { type: "number", min: "0", step: "1", value: sug || "", "data-qty": p.id, "aria-label": `Tonnes of ${p.name}`, placeholder: "t" }), el("span", { text: "t" })));
    });
    const supplierRows = () => {
      const picked = products.filter((p) => checked("rfqProduct").includes(p.id));
      const groups = new Set(picked.map((p) => p.category));
      const relevant = suppliers.filter((s) => s.standing !== "hold" && (!groups.size || (s.supplies || []).some((g) => groups.has(g))));
      return relevant.map((s) => el("label", { class: "rfq-line" },
        el("input", { type: "checkbox", name: "rfqSupplier", value: s.id, ...((supplierId ? s.id === supplierId : true) ? { checked: "" } : {}) }),
        el("span", { class: "rfq-name" }, el("strong", { text: s.name }),
          el("small", { text: `${s.origin || "origin not set"} · ${s.metrics.primaryContact ? `${s.metrics.primaryContact.name}${s.metrics.primaryContact.email ? ` <${s.metrics.primaryContact.email}>` : " (no email)"}` : "no contact yet"}` }))));
    };
    const supplierBox = el("div", { class: "rfq-list", id: "rfq-suppliers" });
    const refreshSuppliers = () => { const keep = new Set(checked("rfqSupplier")); supplierBox.replaceChildren(...supplierRows()); if (keep.size && !supplierId) supplierBox.querySelectorAll("input").forEach((i) => { i.checked = keep.has(i.value); }); };
    form.replaceChildren(
      section("1. What you need", fieldWrap("lines", "Products and tonnage", el("div", { class: "rfq-list" }, ...(productRows.length ? productRows : [el("p", { class: "muted", text: "No products yet — add them on the Products page." })])))),
      section("2. Who to ask", fieldWrap("suppliers", "Suppliers", supplierBox, { hint: "Only suppliers that supply the products you picked are listed." })),
      section("3. Details",
        el("div", { class: "grid-2" },
          fieldWrap("deliverBy", "Delivered by", el("input", { id: "f-deliverBy", name: "deliverBy", type: "date", value: addDays(todayIso(), 21), min: todayIso() })),
          fieldWrap("respondBy", "Reply by", select("respondBy", [["2", "2 working days"], ["3", "3 working days"], ["5", "1 week"], ["", "No deadline"]], "3"))),
        fieldWrap("extra", "Anything else to add", el("textarea", { id: "f-extra", name: "extra", rows: "2", maxlength: "600", placeholder: "e.g. delivery address, offloading, mill certificates" }))));
    refreshSuppliers();
    form.querySelectorAll('input[name="rfqProduct"]').forEach((i) => i.addEventListener("change", refreshSuppliers));
    form.onsubmit = (e) => { e.preventDefault(); previewRfq(); };
    footer(el("span", { class: "spacer" }), cancelBtn(supplierId ? backToProfile(supplierId) : null), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", id: "save-btn", text: "Write emails" }));
  }

  function rfqEmail(s, lines, deliverBy, respondBy, extra) {
    const c = s.metrics.primaryContact;
    const company = settings.companyName || "[your company]";
    const replyBy = respondBy ? addWorkingDays(todayIso(), Number(respondBy)) : null;
    const subject = `Request for quotation — ${lines.length === 1 ? lines[0].name : `${lines.length} steel products`} — ${company}`;
    const body = [
      `Hello ${c ? firstName(c.name) : s.name + " team"},`,
      "",
      `Please could you quote for the following${deliverBy ? `, delivered by ${fmt.date(deliverBy)}` : ""}:`,
      "",
      ...lines.map((l) => `• ${l.name}${l.spec ? ` (${l.spec})` : ""}${l.tonnage ? ` — ${l.tonnage} t` : ""}${l.code ? ` — tariff code ${fmtCode(l.code)}` : ""}`),
      "",
      `Please include: price per tonne (${s.currency}), what the price covers (delivery, duty), lead time, how long the price is valid, and the mill and country of melt and pour.`,
      ...(extra ? ["", extra] : []),
      ...(replyBy ? ["", `If possible, please reply by ${fmt.date(replyBy)}.`] : []),
      "",
      "Many thanks,",
      company,
    ].join("\n");
    return { to: c && c.email ? c.email : "", subject, body, contact: c };
  }
  function addWorkingDays(iso, n) {
    let d = new Date(`${iso}T00:00:00Z`);
    while (n > 0) { d = new Date(d.getTime() + 86_400_000); if (![0, 6].includes(d.getUTCDay())) n--; }
    return d.toISOString().slice(0, 10);
  }

  function previewRfq() {
    const ids = checked("rfqProduct");
    const lines = products.filter((p) => ids.includes(p.id)).map((p) => {
      const q = form.querySelector(`[data-qty="${p.id}"]`).value;
      return { productId: p.id, name: p.name, spec: p.spec, code: p.commodityCode, tonnage: q ? Number(q) : null };
    });
    const sups = suppliers.filter((s) => checked("rfqSupplier").includes(s.id));
    const errors = {};
    if (!lines.length) errors.lines = "Pick at least one product.";
    if (!sups.length) errors.suppliers = "Pick at least one supplier.";
    if (Object.keys(errors).length) { showErrors(errors); return; }
    const deliverBy = field("deliverBy").value;
    const respondBy = field("respondBy").value;
    const extra = field("extra").value.trim();
    const state = { lines, deliverBy, sent: new Set() };
    const cards = sups.map((s) => {
      const mail = rfqEmail(s, lines, deliverBy, respondBy, extra);
      const bodyBox = el("textarea", { class: "rfq-body", rows: "12", "aria-label": `Email to ${s.name}`, text: mail.body });
      const subjectBox = el("input", { class: "rfq-subject", value: mail.subject, "aria-label": `Subject for ${s.name}` });
      const status = el("span", { class: "small muted" });
      const log = async (channel) => {
        if (state.sent.has(s.id)) return;
        try {
          await api(`/api/suppliers/${s.id}/rfqs`, { method: "POST", body: { lines, contactId: mail.contact ? mail.contact.id : null, channel, deliverBy } });
          state.sent.add(s.id);
          status.replaceChildren(el("span", { class: "status-dot", text: channel === "copy" ? "Copied — logged as requested" : "Opened in your email — logged as requested" }));
          card.classList.add("is-sent");
        } catch (error) { toast(error.message, true); }
      };
      const openMail = el("a", {
        class: `btn btn-primary${mail.to ? "" : " is-disabled"}`, href: "#", role: "button",
        onclick: (e) => {
          if (!mail.to) { e.preventDefault(); return; }
          e.currentTarget.href = `mailto:${encodeURIComponent(mail.to)}?subject=${encodeURIComponent(subjectBox.value)}&body=${encodeURIComponent(bodyBox.value)}`;
          log("email");
        },
        text: "Open in email",
      });
      if (!mail.to) openMail.setAttribute("aria-disabled", "true");
      const copy = el("button", { class: "btn", type: "button", text: "Copy text", onclick: async () => {
        try { await navigator.clipboard.writeText(`Subject: ${subjectBox.value}\n\n${bodyBox.value}`); } catch { bodyBox.select(); document.execCommand && document.execCommand("copy"); }
        toast("Email copied");
        log("copy");
      } });
      const card = el("article", { class: "rfq-card" },
        el("div", { class: "rfq-card-head" },
          el("div", {}, el("strong", { text: s.name }), el("div", { class: "small muted", text: mail.to ? `To: ${mail.contact.name} <${mail.to}>` : mail.contact ? `${mail.contact.name} has no email — copy the text, or add an email in Contacts` : "No contact yet — copy the text, or add a contact first" })),
          el("div", { class: "rfq-actions" }, copy, openMail)),
        subjectBox, bodyBox, status);
      return card;
    });
    $("drawer-title").textContent = `Review ${sups.length} email${sups.length === 1 ? "" : "s"}`;
    form.replaceChildren(el("p", { class: "muted", style: "margin:0", text: "Each email opens in your own mail app, ready to send. Edit anything first. Sending or copying marks the supplier as awaiting a reply; log their answer with “Log quote”." }), ...cards);
    form.onsubmit = (e) => e.preventDefault();
    footer(el("button", { class: "btn", type: "button", text: "Back", onclick: () => openRfq() }), el("span", { class: "spacer" }),
      el("button", { class: "btn btn-primary", type: "button", text: "Done", onclick: async () => { await load(); closeDrawer(true); if (state.sent.size) toast(`${state.sent.size} quote request${state.sent.size === 1 ? "" : "s"} logged`); } }));
  }

  // ---------------------------------------------------------------- profile
  const initials = (name) => {
    const words = String(name || "?").replace(/[^A-Za-z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words.slice(0, 2).map((w) => w[0]).join("") : (words[0] || "?").slice(0, 2)).toUpperCase();
  };
  const avatar = (name, cls = "") => el("span", { class: `avatar ${cls}`, "aria-hidden": "true", text: initials(name) });
  const icon = (path, size = 16) => { const s = el("span", { class: "i", "aria-hidden": "true" }); s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`; return s; };
  const I = {
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z"/>',
    web: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  };
  const meter = (share, cls = "") => el("span", { class: `meter ${cls}`, "aria-hidden": "true" }, el("span", { style: `width:${Math.max(0, Math.min(100, share * 100)).toFixed(1)}%` }));

  // What's missing from a profile — shown as a gentle prompt.
  function missing(s) {
    const gaps = [];
    if (!s.origin) gaps.push("origin");
    if (!(s.supplies || []).length) gaps.push("what they supply");
    if (!s.priceCovers) gaps.push("what the price covers");
    if (!s.deliveryTerms) gaps.push("delivery terms");
    if (!s.transport) gaps.push("transport");
    if (s.paymentDays === null) gaps.push("payment terms");
    if (s.onTimePct === null) gaps.push("on-time %");
    if (s.leadTimeMin === null) gaps.push("lead time");
    if (!(s.contacts || []).length) gaps.push("a contact");
    return gaps;
  }

  // The headline: what this supplier's price really means given quota.
  function exposureCallout(s) {
    const m = s.metrics;
    const q = quotaFor(s).find((x) => x.kind === "line");
    const lineText = (l) => `${l.residual ? "Other-origins" : l.origin === "European Union" ? "EU" : l.origin} quota for Category ${l.categoryId}`;
    if (!s.origin) {
      return el("div", { class: "callout is-muted" }, icon(I.alert, 18),
        el("div", {}, el("strong", { text: "Origin not set" }), el("p", { text: "Set where the steel is melted and poured to see which quota line applies and what the duty risk is." }),
          me.canEdit ? el("button", { class: "link-btn", type: "button", text: "Set origin", onclick: () => openSupplierForm(s) }) : null));
    }
    if (s.origin === "UK") {
      return el("div", { class: "callout is-good" }, icon(I.check, 18),
        el("div", {}, el("strong", { text: "UK steel — no quota, no steel duty" }), el("p", { text: `The quoted ${perT(m.pricePerT, m.currency)} is the price you pay.` })));
    }
    if (s.origin === "Ukraine") {
      return el("div", { class: "callout is-good" }, icon(I.check, 18),
        el("div", {}, el("strong", { text: "Ukrainian origin is excluded from the steel measure" }), el("p", { text: "No quota or 50% steel duty applies." })));
    }
    const lineBlock = q ? el("div", { class: "callout-line" },
      el("div", { class: "callout-line-head" }, el("span", { text: lineText(q.line) }), el("a", { href: `quotas.html?category=${encodeURIComponent(q.categoryId)}`, text: `Line ${q.line.orderNumber} →` })),
      q.line.found && q.line.usedShare !== null && q.line.usedShare !== undefined ? meter(q.line.usedShare, (RISK[q.line.risk] || [])[1] || "") : null,
      el("div", { class: "callout-line-foot" },
        el("span", { text: q.line.found ? `${Math.round((q.line.usedShare || 0) * 100)}% used · ${fmt.tonnesRound(q.line.balanceT)} left` : "No live balance" }),
        el("span", { text: q.line.risk === "exhausted" ? "Used up" : q.line.runOutDate ? `runs out ~${fmt.date(q.line.runOutDate)}` : "" }))) : null;
    if (m.dutyExposed) {
      const bad = q && ["exhausted", "critical"].includes(q.line.risk);
      return el("div", { class: `callout ${bad ? "is-bad" : "is-warn"}` }, icon(I.alert, 18),
        el("div", {},
          el("strong", { text: "You carry the duty risk on this price" }),
          el("p", { text: `${perT(m.pricePerT, m.currency)} is quoted without duty. If the quota is used up before your load clears customs, the 50% steel duty applies: about ${perT(costs[s.id] ? costs[s.id].worstPerT : m.worstCasePerT)} landed.` }),
          lineBlock));
    }
    return el("div", { class: "callout is-info" }, icon(I.shield, 18),
      el("div", {},
        el("strong", { text: "Duty paid by the supplier" }),
        el("p", { text: "They quote duty paid, so the 50% duty risk is theirs — but if the quota runs out they may delay or refuse delivery." }),
        lineBlock));
  }

  function facts(rows) {
    return el("dl", { class: "facts" }, ...rows.filter(([, v]) => v !== null && v !== undefined && v !== "").map(([label, value, sub]) =>
      el("div", { class: "fact" }, el("dt", { text: label }), el("dd", {}, value, sub ? el("small", { text: sub }) : null))));
  }

  function contactActions(c, { compact } = {}) {
    return el("div", { class: "contact-btns" },
      c.email ? el("a", { class: "btn btn-sm", href: `mailto:${c.email}`, title: c.email }, icon(I.mail), compact ? null : "Email") : null,
      c.phone ? el("a", { class: "btn btn-sm", href: `tel:${c.phone.replace(/[^\d+]/g, "")}`, title: c.phone }, icon(I.phone), compact ? null : "Call") : null);
  }

  function overviewPanel(s) {
    const m = s.metrics;
    const supplied = products.filter((p) => (s.supplies || []).includes(p.category));
    const needs = (p) => ["critical", "reorder", "low"].includes(p.metrics && p.metrics.status);
    const gaps = missing(s);
    const rank = suppliers.filter((x) => costs[x.id] && Number.isFinite(costs[x.id].effectivePerT)).sort((a, b) => costs[a.id].effectivePerT - costs[b.id].effectivePerT);
    const c = costs[s.id];
    const pos = rank.findIndex((x) => x.id === s.id);
    const sec = (title, action, ...kids) => el("section", { class: "p-sec" }, el("div", { class: "p-sec-head" }, el("h3", { text: title }), action || null), ...kids);
    const onTime = s.onTimePct;

    const main = el("div", { class: "p-main" },
      el("div", { class: "metric-row" },
        el("div", { class: "metric" }, el("span", { text: "Quoted" }), el("strong", { text: perT(m.pricePerT, m.currency) }),
          el("small", {}, el("span", { class: `tag ${m.covers === "everything" ? "" : "tag-warn"}`, text: coversShort(m.covers) }), " ", m.priceChannel === "list" ? "supplier list" : ago(m.priceAgeDays))),
        el("div", { class: "metric" }, el("span", { text: "Expected cost" }), el("strong", { text: c ? perT(c.effectivePerT) : "…" }),
          el("small", { text: !c ? "pricing every cost…" : pos === 0 ? "cheapest of your suppliers, all costs in" : pos > 0 ? `#${pos + 1} of ${rank.length} · +${money(c.effectivePerT - costs[rank[0].id].effectivePerT)}/t` : "" })),
        el("div", { class: "metric" }, el("span", { text: "If quota missed" }), el("strong", { class: c && c.missPerT > 0.5 ? "is-warn" : "", text: !c ? "…" : c.missPerT > 0.5 ? `+${perT(c.missPerT)}` : "£0" }),
          el("small", { text: !c ? "" : c.missPerT > 0.5 ? `${money(c.missPerT * c.tonnage)} on ${c.tonnage} t` : "no steel duty to miss" })),
        el("div", { class: "metric" }, el("span", { text: "On time" }), el("strong", { text: onTime === null ? "—" : `${onTime}%` }),
          onTime === null ? el("small", { text: "not recorded" }) : meter(onTime / 100, onTime >= 85 ? "is-good" : onTime >= 75 ? "" : "is-warn")),
        el("div", { class: "metric" }, el("span", { text: "Lead time" }), el("strong", { text: lead(s) }), el("small", { text: s.moqNote || (s.moqMinT !== null ? `MOQ ${moq(s)}` : "MOQ not set") }))),
      exposureCallout(s),
      sec("Terms", null, facts([
        ["Price covers", choices.priceCovers[s.priceCovers] ? coversLong(s.priceCovers) : null],
        ["Delivery", s.deliveryTerms || null],
        ["Transport", { included: "Included", extra: "Charged extra" }[s.transport] || null],
        ["DDP", isImport(s) && s.ddp ? choices.ddp[s.ddp] : null],
        ["Payment", s.paymentDays === null ? null : terms(s), s.paymentNote],
        ["Minimum order", s.moqNote || (s.moqMinT !== null ? moq(s) : null)],
        ["Duty costs", s.dutyCosts || null],
        ["Other duty", s.otherDuty || null],
        ["Currency", s.currency],
        ["Steel made by", isImport(s) ? ({ eaf: "Electric arc", "bf-bof": "Blast furnace" }[s.productionRoute] || null) : null],
        ["Verified emissions", isImport(s) && s.emissionsPerT !== null && s.emissionsPerT !== undefined ? `${s.emissionsPerT} t CO₂e/t` : null],
      ]),
        gaps.length && me.canEdit ? el("div", { class: "gaps" }, el("span", { text: `Missing: ${gaps.join(", ")}.` }), el("button", { class: "link-btn", type: "button", text: gaps.includes("a contact") && gaps.length === 1 ? "Add contact" : "Complete profile", onclick: () => (gaps.length === 1 && gaps[0] === "a contact" ? openContactForm(s) : openSupplierForm(s)) })) : null),
      sec(`Your products they supply${supplied.length ? ` · ${supplied.length}` : ""}`,
        supplied.some(needs) && me.canEdit ? el("button", { class: "link-btn", type: "button", text: "Request quote for these", onclick: () => openRfq({ supplierId: s.id }) }) : null,
        supplied.length
          ? el("ul", { class: "prod-list" }, ...supplied.map((p) => {
              const st = p.metrics ? p.metrics.status : "ok";
              const cls = { critical: "is-bad", reorder: "is-bad", low: "is-warn", "no-usage": "is-muted" }[st] || "";
              return el("li", {},
                el("a", { href: `products.html?product=${p.id}` }, el("span", { class: `status-dot ${cls}`, "aria-hidden": "true" }), el("span", { text: p.name })),
                el("span", { class: "prod-meta", text: needs(p) ? `order ${p.metrics.suggestedOrderT} t` : p.metrics && p.metrics.coverMonths !== null ? `${p.metrics.coverMonths.toFixed(1)} mo cover` : "" }));
            }))
          : el("p", { class: "muted small", text: `No products in ${(s.supplies || []).join(", ") || "their groups"} yet.` })));

    const side = el("div", { class: "p-side" },
      sec("Main contact", m.primaryContact && me.canEdit ? el("button", { class: "link-btn", type: "button", text: "All contacts", onclick: () => { tab = "contacts"; renderTabs(s); renderBody(s); } }) : null,
        m.primaryContact
          ? el("div", { class: "contact-mini" }, avatar(m.primaryContact.name),
              el("div", { class: "contact-mini-text" }, el("strong", { text: m.primaryContact.name }), el("span", { text: m.primaryContact.role || m.primaryContact.email || m.primaryContact.phone || "" })),
              contactActions(m.primaryContact, { compact: true }))
          : el("div", { class: "empty-mini" }, el("span", { text: "No contact yet — quote requests need an email." }), me.canEdit ? el("button", { class: "btn btn-sm", type: "button", text: "Add contact", onclick: () => openContactForm(s) }) : null)),
      sec("Supplies", null, (s.supplies || []).length ? el("div", { class: "tag-row" }, ...s.supplies.map((g) => el("span", { class: "tag tag-plain", text: g }))) : el("p", { class: "muted small", text: "Not set" })),
      sec("Prices benchmarked against", null,
        (s.pricingSources || []).length
          ? el("div", { class: "tag-row" }, ...s.pricingSources.map((src) => (SOURCE_LINKS[src]
              ? el("a", { class: "tag tag-plain tag-link", href: SOURCE_LINKS[src], target: "_blank", rel: "noopener", text: `${src} ↗` })
              : el("span", { class: "tag tag-plain", text: src }))))
          : el("p", { class: "muted small", text: "Not recorded" })),
      s.dutyRiskNote ? sec("Duty risk (quota dependent)", null, el("p", { class: "note-text", text: s.dutyRiskNote })) : null,
      s.notes || s.website ? sec("Notes", null,
        s.website ? el("a", { class: "web-link", href: s.website, target: "_blank", rel: "noopener" }, icon(I.web, 14), s.website.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")) : null,
        s.notes ? el("p", { class: "note-text", text: s.notes }) : null) : null);

    return el("div", { class: "supplier-overview" }, main, side);
  }
  const coversLong = (c) => ({ everything: "Everything (delivered, duty paid)", "except-duty": "All except duty", "ex-works": "Ex works", port: "To UK port" })[c] || "—";

  function spark(quotes) {
    const pts = [...quotes].filter((q) => q.currency === "GBP").sort((a, b) => (a.date + a.at).localeCompare(b.date + b.at));
    if (pts.length < 2) return null;
    const W = 560, H = 120, padX = 8, padY = 14;
    const xs = pts.map((q) => Date.parse(q.date)), ys = pts.map((q) => q.pricePerT);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
    const lo = Math.min(...ys), hi = Math.max(...ys), span = Math.max(hi - lo, 20);
    const [y0, y1] = [lo - span * 0.15, hi + span * 0.15];
    const X = (i) => padX + (x1 === x0 ? (i / (pts.length - 1)) * (W - 2 * padX) : ((xs[i] - x0) / (x1 - x0)) * (W - 2 * padX));
    const Y = (y) => H - padY - ((y - y0) / (y1 - y0)) * (H - 2 * padY);
    const line = pts.map((q, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(" ");
    const area = `${line} L${X(pts.length - 1).toFixed(1)},${H} L${X(0).toFixed(1)},${H} Z`;
    const wrap = el("figure", { class: "price-chart" });
    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" role="img" aria-label="Price history from £${ys[0]} to £${ys[ys.length - 1]} per tonne">
      <path d="${area}" class="pc-area"/><path d="${line}" class="pc-line" vector-effect="non-scaling-stroke"/>
      ${pts.map((q, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="3.5" class="pc-dot"><title>${q.date}: £${q.pricePerT}/t</title></circle>`).join("")}</svg>`;
    wrap.append(el("figcaption", {}, el("span", { text: `${fmt.date(pts[0].date)} · £${ys[0]}` }), el("span", { text: `low £${lo} · high £${hi}` }), el("span", { text: `${fmt.date(pts[pts.length - 1].date)} · £${ys[ys.length - 1]}` })));
    return wrap;
  }

  function quotesPanel(s) {
    const quotes = [...(s.quotes || [])].sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
    const open = (s.rfqs || []).filter((r) => r.status === "open");
    const today = todayIso();
    const latest = quotes[0];
    const prev = quotes[1];
    const others = suppliers.filter((x) => x.id !== s.id && Number.isFinite(x.metrics.pricePerT));
    const cheapest = others.sort((a, b) => a.metrics.pricePerT - b.metrics.pricePerT)[0];
    return el("div", { class: "profile-panel" },
      open.length ? el("div", { class: "callout is-warn" }, icon(I.clock, 18), el("div", {},
        el("strong", { text: `Waiting on ${open.length === 1 ? "a reply" : `${open.length} replies`}` }),
        el("ul", { class: "plain-list" }, ...open.map((r) => el("li", { text: `Requested ${fmt.date(r.at.slice(0, 10))}${r.contactName ? ` from ${r.contactName}` : ""}: ${r.lines.map((l) => `${l.name}${l.tonnage ? ` (${l.tonnage} t)` : ""}`).join(", ")}` }))),
        me.canEdit ? el("button", { class: "btn btn-sm", type: "button", text: "Log their quote", onclick: () => openQuoteForm(s) }) : null)) : null,
      latest ? el("div", { class: "latest-quote" },
        el("div", {}, el("span", { class: "lq-label", text: "Latest quote" }), el("strong", { class: "lq-price", text: perT(latest.pricePerT, latest.currency) }),
          el("span", { class: "lq-sub", text: `${coversLong(latest.covers)} · ${latest.channel === "list" ? "from supplier list" : `${fmt.date(latest.date)} by ${(choices.quoteChannels[latest.channel] || latest.channel).toLowerCase()}`}` })),
        el("div", { class: "lq-side" },
          prev ? el("span", { class: latest.pricePerT > prev.pricePerT ? "trend up" : latest.pricePerT < prev.pricePerT ? "trend down" : "trend", text: latest.pricePerT === prev.pricePerT ? "No change" : `${latest.pricePerT > prev.pricePerT ? "▲" : "▼"} ${money(Math.abs(latest.pricePerT - prev.pricePerT), latest.currency)} vs previous` }) : null,
          latest.validUntil ? el("span", { class: latest.validUntil < today ? "status-dot is-bad" : "status-dot", text: latest.validUntil < today ? `Expired ${fmt.date(latest.validUntil)}` : `Valid to ${fmt.date(latest.validUntil)}` }) : el("span", { class: "muted small", text: "Validity not stated" }),
          cheapest ? el("span", { class: "muted small", text: latest.pricePerT <= cheapest.metrics.pricePerT ? "Lowest quoted price right now" : `${cheapest.name} quotes ${perT(cheapest.metrics.pricePerT, cheapest.metrics.currency)}` }) : null)) : null,
      spark(quotes),
      quotes.length ? el("div", { class: "table-scroll" }, el("table", { class: "quota-table quotes-table" },
        el("thead", {}, el("tr", {}, el("th", { text: "Date" }), el("th", { class: "num", text: "Price" }), el("th", { text: "Covers" }), el("th", { text: "For" }), el("th", { class: "wide-only", text: "Valid until" }), el("th", { class: "wide-only", text: "Source" }), me.canEdit ? el("th", {}, el("span", { class: "sr-only", text: "Remove" })) : null)),
        el("tbody", {}, ...quotes.map((q) => el("tr", {},
          el("td", { text: q.channel === "list" ? "Supplier list" : fmt.date(q.date) }),
          el("td", { class: "num" }, el("strong", { text: perT(q.pricePerT, q.currency) })),
          el("td", {}, el("span", { class: `tag ${q.covers === "everything" ? "" : "tag-warn"}`, text: coversShort(q.covers) })),
          el("td", { text: `${q.productName || "General"}${q.tonnage ? ` · ${q.tonnage} t` : ""}` }),
          el("td", { class: "wide-only" }, q.validUntil ? el("span", { class: q.validUntil < today ? "status-dot is-bad" : "", text: fmt.date(q.validUntil) }) : "—"),
          el("td", { class: "wide-only", title: q.note || "", text: `${choices.quoteChannels[q.channel] || q.channel}${q.by && q.by !== "setup" ? ` · ${q.by}` : ""}` }),
          me.canEdit ? el("td", {}, q.channel === "list" ? null : el("button", { class: "link-btn", type: "button", text: "Remove", onclick: async (e) => {
            if (e.currentTarget.dataset.confirm !== "1") { e.currentTarget.dataset.confirm = "1"; e.currentTarget.textContent = "Remove?"; return; }
            try { await api(`/api/suppliers/${s.id}/quotes/${q.id}`, { method: "DELETE" }); toast("Quote removed"); await load(); openDetail(s.id, "quotes"); } catch (error) { toast(error.message, true); }
          } })) : null))))) : el("div", { class: "empty-state" }, el("h3", { text: "No quotes yet" }), el("p", { text: "Request a quote, then log their reply here." })),
      el("p", { class: "small muted", style: "margin:0", text: "The latest quote is this supplier's current price everywhere in the tool." }));
  }

  function contactCard(s, c) {
    const copyBtn = c.email ? el("button", { class: "btn btn-sm", type: "button", title: "Copy email", onclick: async () => { try { await navigator.clipboard.writeText(c.email); toast("Email copied"); } catch { toast(c.email); } } }, icon(I.copy)) : null;
    return el("article", { class: `contact-card${c.primary ? " is-primary" : ""}` },
      avatar(c.name),
      el("div", { class: "contact-body" },
        el("div", { class: "contact-name" }, el("strong", { text: c.name }), c.primary ? el("span", { class: "tag", text: "Main contact" }) : null),
        c.role ? el("div", { class: "small muted", text: c.role }) : null,
        el("div", { class: "contact-lines" },
          c.email ? el("span", {}, icon(I.mail, 13), c.email) : null,
          c.phone ? el("span", {}, icon(I.phone, 13), c.phone) : null)),
      el("div", { class: "contact-side" },
        el("div", { class: "contact-btns" }, contactActions(c), copyBtn),
        me.canEdit ? el("div", { class: "contact-actions" },
          !c.primary ? el("button", { class: "link-btn", type: "button", text: "Make main", onclick: async () => {
            try { await api(`/api/suppliers/${s.id}/contacts/${c.id}`, { method: "PUT", body: { ...c, primary: true } }); await load(); openDetail(s.id, "contacts"); } catch (error) { toast(error.message, true); }
          } }) : null,
          el("button", { class: "link-btn", type: "button", text: "Edit", onclick: () => openContactForm(s, c) }),
          el("button", { class: "link-btn", type: "button", text: "Remove", onclick: async (e) => {
            if (e.currentTarget.dataset.confirm !== "1") { e.currentTarget.dataset.confirm = "1"; e.currentTarget.textContent = "Remove?"; return; }
            try { await api(`/api/suppliers/${s.id}/contacts/${c.id}`, { method: "DELETE" }); toast("Contact removed"); await load(); openDetail(s.id, "contacts"); } catch (error) { toast(error.message, true); }
          } })) : null));
  }

  function contactsPanel(s) {
    const list = [...(s.contacts || [])].sort((a, b) => Number(b.primary) - Number(a.primary));
    return el("div", { class: "profile-panel" },
      list.length ? el("div", { class: "contact-list" }, ...list.map((c) => contactCard(s, c)))
        : el("div", { class: "empty-state" }, el("h3", { text: "No contacts yet" }), el("p", { text: "Add the person you get quotes from — quote requests go to the main contact." })),
      me.canEdit ? el("div", {}, el("button", { class: "btn", type: "button", text: "Add contact", onclick: () => openContactForm(s) })) : null);
  }

  // ---------------------------------------------------------------- cost breakdown
  // Runs this supplier's latest quote through the landed-cost engine for one
  // product, then adds the supplier-specific variables, and lays out every
  // factor worth weighing before buying from them.
  const bd = { key: null, opts: {}, data: null, compare: null, loading: false, error: null };
  let market = null; // /api/benchmarks, loaded once for the market check
  const pctFmt = (p) => `${Math.round(p * 100)}%`;
  const signed = (v, cur) => {
    const a = Math.abs(v);
    return `${v < 0 ? "−" : "+"}${a > 0 && a < 1 ? `${SYM[cur] || "£"}${a.toFixed(2)}` : money(a, cur)}`;
  };

  const fmtEq = (x, unit) => (unit === "£/t" ? `£${x.toFixed(2)}` : unit === "t" ? `${(Math.round(x * 100) / 100).toLocaleString("en-GB")} t` : unit === "months" ? `${x.toFixed(2)} mo` : unit === "£" ? `£${Math.round(x).toLocaleString("en-GB")}` : unit === "£/tCO2" ? `£${x.toFixed(2)}/t CO₂e` : String(Math.round(x * 100) / 100));
  const reduceMotion = () => window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Count a number up from zero (skipped when the user prefers less motion).
  function countUp(node, to, format, ms = 700, delay = 0) {
    if (!Number.isFinite(to) || reduceMotion()) { node.textContent = format(to); return; }
    const start = performance.now() + delay;
    node.textContent = format(0);
    const step = (now) => {
      const t = Math.min(1, Math.max(0, (now - start) / ms));
      const eased = 1 - Math.pow(1 - t, 3);
      node.textContent = format(to * eased);
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  async function loadBreakdown(s, opts) {
    bd.key = s.id;
    bd.opts = { ...opts };
    bd.loading = true;
    bd.error = null;
    const body = { ...opts, ratePct: opts.ratePct ?? settings.costOfCapitalPct ?? 8, cbam: cbamOn };
    try {
      const [data, cmp] = await Promise.all([
        api(`/api/suppliers/${s.id}/breakdown`, { method: "POST", body }),
        api("/api/suppliers/compare", { method: "POST", body: { ...body, productId: opts.productId, arrival: "lead" } }).catch(() => null),
      ]);
      bd.data = data.ok ? data : null;
      bd.error = data.ok ? null : data.error;
      if (data.ok && !opts.productId) bd.opts.productId = data.product.id;
      if (cmp && data.ok && !opts.productId) {
        const again = await api("/api/suppliers/compare", { method: "POST", body: { ...body, productId: data.product.id, arrival: "lead" } }).catch(() => null);
        bd.compare = again;
      } else bd.compare = cmp;
      if (!market) market = await api("/api/benchmarks").catch(() => null);
    } catch (error) {
      bd.error = error.message;
    } finally {
      bd.loading = false;
      if (mode === "detail" && detailId === s.id && tab === "breakdown") renderBody(s);
    }
  }

  function variableCards(s, d) {
    const m = s.metrics;
    const e = d.engine;
    const cur = d.inputs.currency;
    const cards = [];
    const add = (name, value, verdict, note, fix) => cards.push({ name, value, verdict, note, fix });
    const edit = me.canEdit ? { label: "Add", fn: () => openSupplierForm(s) } : null;
    const ask = me.canEdit ? { label: "Request quote", fn: () => openRfq({ supplierId: s.id, productId: d.product.id }) } : null;
    // 1 Price position
    const rows = (bd.compare && bd.compare.rows || []).filter((r) => Number.isFinite(r.effectivePerT));
    const pos = rows.findIndex((r) => r.id === s.id);
    if (pos >= 0) add("Price vs your other suppliers", pos === 0 ? "Cheapest" : `#${pos + 1} of ${rows.length}`, pos === 0 ? "good" : pos === rows.length - 1 ? "risk" : "watch",
      pos === 0 ? `Lowest effective cost for ${d.product.name}.` : `${money(d.effectivePerT - rows[0].effectivePerT, cur)}/t more than ${rows[0].name} once duty risk and terms are counted.`);
    // 2 Market check
    const series = market ? [...market.series, ...market.competition].filter((x) => x.group && (s.supplies || []).includes(x.group) && !(x.computed && x.suppliers && x.suppliers.includes(s.name) && x.suppliers.length === 1)) : [];
    const fx = market ? market.fx : { GBP: 1 };
    const quotedGbp = e.lines.find((l) => l.key === "price").perTonne;
    const benches = series.map((x) => ({ x, l: x.latest })).filter((b) => b.l && fx[b.x.currency || "GBP"]);
    if (benches.length) {
      // Reference: an outside source first (UK, delivered, most recent), else competition.
      const rank = (b) => (b.x.computed ? 10 : 0) + (b.x.region === "UK" ? 0 : 2) + (/deliver|ddp|dap/i.test(b.x.basis || "") ? 0 : 1);
      const best = benches.map((b) => ({ ...b, gbp: b.l.price * fx[b.x.currency || "GBP"] })).sort((a, b) => rank(a) - rank(b) || b.l.date.localeCompare(a.l.date));
      const ext = best.filter((b) => !b.x.computed);
      const ref = best[0];
      const diff = quotedGbp - ref.gbp;
      add("Against the market", `${signed(diff, "GBP")}/t vs ${ref.x.source}`, diff <= 0 ? "good" : diff / ref.gbp > 0.03 ? "risk" : "watch",
        `${ref.x.name}: ${money(ref.gbp)}/t on ${fmt.date(ref.l.date)}.${ext.length > 1 ? ` ${ext.length} market series on Market prices.` : ""}${ext.length ? "" : " Add MEPS or Kallanish prices for an outside view."}`);
    } else add("Against the market", "No benchmark yet", "muted", "Import MEPS or Kallanish prices on Market prices to check this quote against the market.", { label: "Market prices", fn: () => { closeDrawer(true); showPane("market"); } });
    // 3 Duty & quota
    if (s.origin === "UK") add("Duty & quota", "None — UK steel", "good", "No import, so no quota, steel duty or customs paperwork.");
    else if (!e.buyerImports) add("Duty & quota", "Supplier imports", "watch", "They clear customs and pay any duty — but may delay or cancel if the quota runs out. Get that in the contract.");
    else if (e.quota) add("Duty & quota", `${pctFmt(e.quota.probability)} chance of 50% duty`, e.quota.probability >= 0.5 ? "risk" : e.quota.probability >= 0.15 ? "watch" : "good",
      `Expected ${money(d.effectivePerT - d.bestPerT, cur)}/t; if the quota runs out before ${fmt.date(d.inputs.importDate)} it's ${money(d.worstPerT, cur)}/t. ${e.quota.basis || ""}`);
    else add("Duty & quota", "Ordinary duty only", "good", "This product isn't in a steel-measure quota category.");
    // 4 Origin evidence
    if (choices.euMembers.includes(s.origin)) add("Proof of origin", "Needed for 0% duty", "watch", "EU steel enters duty-free under the UK–EU trade agreement only with a statement on origin on the invoice — ask for it with every load.");
    else if (s.origin && s.origin !== "UK") add("Proof of origin", "Check", "watch", "Origin (country of melt and pour) decides the quota line and duty — get mill certificates.");
    // 5 Payment terms
    const terms = d.adjustments.find((a) => a.key === "terms");
    if (s.paymentDays !== null) add("Payment terms", `${s.paymentDays} days`, s.paymentDays >= 60 ? "good" : s.paymentDays >= 30 ? "watch" : "risk",
      `${terms ? `Worth ${money(-terms.perTonne, cur)}/t at ${d.inputs.ratePct}% cost of capital.` : ""}${s.paymentNote ? ` ${s.paymentNote}.` : ""}`);
    else add("Payment terms", "Not recorded", "muted", "Add their terms — longer credit is worth real money.", edit);
    // 6 Lead time
    if (d.inputs.leadDays) add("Lead time", lead(s), d.inputs.leadDays <= 7 ? "good" : d.inputs.leadDays <= 28 ? "watch" : "risk", `Order today, arrives about ${fmt.date(d.inputs.importDate)}.${d.inputs.leadDays > 28 ? " Long lead times tie up more safety stock." : ""}`);
    else add("Lead time", "Not recorded", "muted", "Add a lead time to work out arrival dates and safety stock.", edit);
    // 7 MOQ
    const moqAdj = d.adjustments.find((a) => a.key === "moq");
    add("Minimum order", s.moqNote || moq(s), moqAdj ? "watch" : "good", moqAdj ? `${moqAdj.label} — costs ${money(moqAdj.perTonne, cur)}/t to carry.` : `${d.inputs.tonnage} t meets their minimum.`);
    // 8 Reliability
    // UK CBAM (from 1 January 2027)
    if (d.cbam && isImport(s)) {
      const ci = d.cbam;
      const est = Math.max(ci.rate - ci.relief, 0) * ci.emissions;
      const cbamLine = e.lines.find((l) => l.key === "cbam");
      const toggle = { label: ci.on ? "Turn off" : "Include it", fn: () => setCbam(!ci.on) };
      if (!e.buyerImports) add("UK CBAM", "Supplier pays", "good", "They're importer of record, so they pay the carbon charge from January 2027. Expect it to show up in their prices.");
      else if (!ci.on) add("UK CBAM", `≈ ${money(est, cur)}/t from Jan 2027`, "watch", `Not in the cost yet. At ${ci.emissions} t CO₂e/t × £${ci.rate} it would add about ${money(est * d.inputs.tonnage, cur)} to this order.`, toggle);
      else if (ci.emissionsSource !== "verified") add("UK CBAM", `${money((cbamLine && cbamLine.perTonne) || est, cur)}/t included`, "watch",
        `Based on ${ci.route ? `the ${ci.route === "eaf" ? "electric-arc" : "blast-furnace"} default` : "the higher default, as the mill's route isn't set"} (${ci.emissions} t CO₂e/t). Ask the mill for verified emissions, which could bring it down.`, edit ? { label: "Add emissions", fn: () => openSupplierForm(s) } : null);
      else add("UK CBAM", `${money((cbamLine && cbamLine.perTonne) || est, cur)}/t included`, "good", `Uses the mill's verified ${ci.emissions} t CO₂e/t.`);
    }
    if (s.onTimePct !== null) add("Reliability", `${s.onTimePct}% on time`, s.onTimePct >= 90 ? "good" : s.onTimePct >= 75 ? "watch" : "risk",
      `${100 - s.onTimePct}% of loads late — hold extra safety stock${d.adjustments.find((a) => a.key === "reliability") ? ` (≈ ${money(d.adjustments.find((a) => a.key === "reliability").perTonne, cur)}/t)` : ""}.`);
    else add("Reliability", "Not recorded", "muted", "Add their on-time % from your delivery records.", edit);
    // 9 Currency
    add("Currency", cur, cur === "GBP" ? "good" : "watch", cur === "GBP" ? "Quoted in sterling — no exchange-rate risk." : `Converted at ${e.fx.rate} — the rate on payment day will differ.`);
    // 10 Quote freshness
    if (m.priceChannel === "list") add("Quote freshness", "From supplier list", "watch", "Not a dated quote — request a current price before ordering.", ask);
    else if (m.priceExpired) add("Quote freshness", "Expired", "risk", "The latest quote has passed its validity date.", ask);
    else add("Quote freshness", ago(m.priceAgeDays), m.priceAgeDays <= 14 ? "good" : "watch", m.priceAgeDays <= 14 ? "Recent quote." : "Over two weeks old — prices move; re-confirm.");
    return cards;
  }

  function breakdownPanel(s) {
    const panel = el("div", { class: "profile-panel bd2" });
    if (bd.key !== s.id && !bd.loading) {
      // keep product, tonnage (if you chose it) and cost of capital when moving between suppliers
      const sticky = { productId: bd.opts.productId, ratePct: bd.opts.ratePct, tonnage: bd.userTonnage ? bd.opts.tonnage : undefined };
      bd.data = null; bd.compare = null; loadBreakdown(s, sticky);
    }
    if (bd.loading && !bd.data) {
      panel.append(el("div", { class: "bd2-loading" }, el("span", { class: "spinner", "aria-hidden": "true" }), el("span", { text: "Working out the landed cost with live HMRC duty and quota data…" })));
      return panel;
    }
    if (bd.error && !bd.data) {
      panel.append(el("div", { class: "callout is-muted" }, icon(I.alert, 18), el("div", {}, el("strong", { text: "Can't break this supplier down yet" }), el("p", { text: bd.error }),
        me.canEdit && /origin/i.test(bd.error) ? el("button", { class: "btn btn-sm", type: "button", text: "Set origin", onclick: () => openSupplierForm(s) }) : null,
        me.canEdit && /quote/i.test(bd.error) ? el("button", { class: "btn btn-sm", type: "button", text: "Log a quote", onclick: () => openQuoteForm(s) }) : null)));
      return panel;
    }
    const d = bd.data;
    const e = d.engine;
    const cur = d.inputs.currency;
    const refresh = (patch) => { loadBreakdown(s, { ...bd.opts, ...patch }); renderBody(s); };

    // ---- 1. the scenario, as a sentence with inline choices
    const supplied = products.filter((p) => (s.supplies || []).includes(p.category));
    const others = products.filter((p) => !supplied.includes(p));
    const pill = (control, label) => { control.classList.add("pill-select"); control.setAttribute("aria-label", label); return control; };
    const productSel = pill(el("select", {},
      supplied.length ? el("optgroup", { label: "They supply" }, ...supplied.map((p) => el("option", { value: p.id, text: p.name }))) : null,
      others.length ? el("optgroup", { label: "Other products" }, ...others.map((p) => el("option", { value: p.id, text: p.name }))) : null), "Product");
    productSel.value = d.product.id;
    productSel.addEventListener("change", () => { bd.userTonnage = false; refresh({ productId: productSel.value, tonnage: undefined }); });
    const tonOpts = [...new Set([d.product.suggestedOrderT, s.moqMinT, s.moqMaxT, 5, 10, 20, 25, 28, 50, 100, d.inputs.tonnage].filter((v) => v > 0))].sort((a, b) => a - b);
    const tonSel = pill(el("select", {}, ...tonOpts.map((v) => el("option", { value: String(v), text: `${v} t${v === d.product.suggestedOrderT ? " · suggested" : v === s.moqMinT ? " · MOQ" : ""}` }))), "Tonnage");
    tonSel.value = String(d.inputs.tonnage);
    tonSel.addEventListener("change", () => { bd.userTonnage = true; refresh({ tonnage: Number(tonSel.value) }); });
    const dateIn = pill(el("input", { type: "date", value: d.inputs.importDate, min: todayIso() }), "Arrival date");
    dateIn.addEventListener("change", () => dateIn.value && refresh({ importDate: dateIn.value }));
    const rateSel = pill(el("select", {}, ...[0, 4, 6, 8, 10, 12, 15].map((v) => el("option", { value: String(v), text: `${v}%` }))), "Cost of capital");
    rateSel.value = String(d.inputs.ratePct);
    rateSel.addEventListener("change", () => refresh({ ratePct: Number(rateSel.value) }));
    const sentence = el("div", { class: "bd2-sentence" },
      el("span", { text: "Buying" }), tonSel, el("span", { text: "of" }), productSel, el("span", { text: "arriving" }), dateIn,
      el("span", { class: "bd2-sentence-soft", text: "· cost of capital" }), rateSel,
      el("button", { type: "button", class: `cbam-pill${cbamOn ? " is-on" : ""}`, role: "switch", "aria-checked": String(cbamOn), title: "Include the UK carbon border charge (starts 1 January 2027)", onclick: () => setCbam(!cbamOn) },
        el("span", { class: "cbam-track", "aria-hidden": "true" }, el("span", { class: "cbam-thumb" })), "UK CBAM"),
      s.transport === "extra" ? el("span", { class: "bd2-sentence-soft", text: "· haulage" }) : null,
      s.transport === "extra" ? (() => { const i = pill(el("input", { type: "number", min: "0", step: "1", value: String(d.inputs.transportPerT || ""), placeholder: "£0" }), "Haulage £ per tonne"); i.style.width = "72px"; i.addEventListener("change", () => refresh({ transportPerT: Number(i.value) || 0 })); return i; })() : null,
      bd.loading ? el("span", { class: "spinner sm", "aria-label": "Updating" }) : null);

    // ---- 2. the answer: three scenarios and the cost of missing the quota
    const M = d.model;
    const T = M ? M.totals : { expected: d.effectivePerT, best: d.bestPerT, worst: d.worstPerT, missPerT: d.worstPerT - d.bestPerT, missOrder: (d.worstPerT - d.bestPerT) * d.inputs.tonnage, probability: e.quota ? e.quota.probability : null, missing: [] };
    const tons = d.inputs.tonnage;
    const animateNum = (node, value, fmtFn, key) => { if (bd.animatedFor !== key) countUp(node, value, fmtFn, 800); return node; };
    const animKey = `${s.id}:${T.expected}:${tons}`;
    const scen = (cls, label, value, sub, extra) => el("div", { class: `scen ${cls}` },
      el("span", { class: "scen-l", text: label }),
      animateNum(el("strong", { class: "scen-v", text: perT(value) }), value, (x) => `£${Math.round(x).toLocaleString("en-GB")}/t`, animKey),
      el("span", { class: "scen-s", text: sub }), extra || null);
    const hasRisk = T.missPerT > 0.5;
    const span = T.worst - T.best;
    const pos = span > 0 ? Math.min(100, Math.max(0, ((T.expected - T.best) / span) * 100)) : 0;
    const prob = T.probability;
    const answer = el("div", { class: "bd3-answer" },
      el("div", { class: `scen-row${hasRisk ? "" : " is-single"}` },
        hasRisk ? scen("is-best", "If the quota holds", T.best, `${money(T.best * tons)} for ${tons} t`) : null,
        scen("is-expected", hasRisk ? "Expected cost" : "Landed cost", T.expected, `${money(T.expected * tons)} for ${tons} t${hasRisk ? ` · ${pctFmt(prob || 0)} risk priced in` : ""}`,
          el("span", { class: "scen-q", text: `quoted ${perT(d.inputs.quotedPerT, cur)}` })),
        hasRisk ? scen("is-worst", "If the quota is missed", T.worst, `${money(T.worst * tons)} for ${tons} t`) : null),
      hasRisk ? (() => {
        const fill = el("span", { class: "bd2-fill", style: "width:0%" });
        const marker = el("span", { class: "bd2-marker", style: "left:0%" });
        requestAnimationFrame(() => requestAnimationFrame(() => { fill.style.width = `${pos}%`; marker.style.left = `${pos}%`; }));
        return el("div", { class: "bd3-track-wrap", role: "img", "aria-label": `Expected cost sits ${Math.round(pos)}% of the way from best to worst case` }, el("div", { class: "bd2-track" }, fill, marker));
      })() : null,
      hasRisk
        ? el("div", { class: "miss-banner" }, icon(I.alert, 18),
            el("div", {}, el("strong", { text: `Missing the quota would cost ${money(T.missPerT)}/t more — ${money(T.missOrder)} on this order.` }),
              el("p", { text: prob > 0.005 ? `${pctFmt(prob)} chance it runs out before ${fmt.date(d.inputs.importDate)}, so ${money(prob * T.missPerT)}/t of that is already in the expected cost.` : `At today's burn rate the quota lasts past ${fmt.date(d.inputs.importDate)}, so none of it is priced in yet — a later arrival date raises the risk.` })))
        : el("div", { class: "miss-banner is-calm" }, icon(I.check, 18), el("div", {}, el("strong", { text: s.origin === "UK" ? "UK steel — no quota or steel duty to miss." : !e.buyerImports ? "Duty paid by the supplier — no 50% duty to you." : "No steel-measure duty on this product." }),
            el("p", { text: !e.buyerImports && s.origin !== "UK" ? "The risk is delay or non-delivery if the quota runs out — agree it in the contract." : "Your price is the landed cost below." }))),
      T.missing && T.missing.length ? el("p", { class: "bd3-missing" }, icon(I.alert, 14), ` Not yet costed: ${T.missing.join(", ").toLowerCase()}.`) : null);
    bd.animatedFor = animKey;

    // ---- 3. the full cost model — every variable, each with its equation
    const KIND = { quote: "Quote", supplier: "Supplier", product: "Product", you: "Your choice", live: "Live data", fixed: "Fixed", calc: "Earlier step", intel: "Market intel" };
    const STATUS = { included: ["Included", "st-in"], "in-price": ["In their price", "st-price"], supplier: ["Supplier pays", "st-sup"], "n/a": ["Not applicable", "st-na"], missing: ["Needs input", "st-miss"], scenario: ["If missed", "st-scen"], memo: ["For reference", "st-memo"], off: ["Switched off", "st-na"] };
    const renderEq = (eq, n, total) => {
      let i = 0;
      const tok = (p) => {
        const style = `--i:${i++}`;
        if (p.t === "op") return el("span", { class: "eq-op", style, "aria-hidden": "true", text: p.o });
        return el("div", { class: `eq-v k-${p.kind}`, style },
          el("span", { class: "eq-l", text: p.label }),
          el("strong", { class: "eq-n", text: p.value }),
          el("span", { class: "eq-s", title: p.source || "" }, el("span", { class: "eq-k", text: KIND[p.kind] || "" }), p.source && p.source !== KIND[p.kind] ? ` · ${p.source}` : ""));
      };
      const r = eq.result;
      const resVal = el("strong", { class: "eq-n", "data-count": String(Math.abs(r.value)), "data-unit": r.unit, text: fmtEq(Math.abs(r.value), r.unit) });
      return el("div", { class: "eq" },
        total > 1 ? el("span", { class: "eq-step", text: `Step ${n + 1}` }) : null,
        el("div", { class: "eq-row", role: "math", "aria-label": `${eq.parts.map((p) => (p.t === "op" ? p.o : `${p.label} ${p.value}`)).join(" ")} equals ${r.label} ${fmtEq(Math.abs(r.value), r.unit)}` },
          ...eq.parts.map(tok),
          el("span", { class: "eq-op is-eq", style: `--i:${i++}`, "aria-hidden": "true", text: "=" }),
          el("div", { class: `eq-r${r.sign < 0 ? " is-saving" : ""}${Math.abs(r.value) < 0.005 ? " is-zero" : ""}`, style: `--i:${i++}` }, el("span", { class: "eq-l", text: r.label }), resVal)));
    };
    const openWork = (btn, work, open) => {
      work.classList.toggle("is-open", open);
      btn.setAttribute("aria-expanded", String(open));
      if (open) work.querySelectorAll("[data-count]").forEach((n) => countUp(n, Number(n.dataset.count), (x) => fmtEq(x, n.dataset.unit), 650, 260));
    };
    const rowEls = [];
    let idx = 0;
    const modelRow = (r) => {
      const [stLabel, stCls] = STATUS[r.status] || [r.status, ""];
      const zero = Math.abs(r.perTonne) < 0.005;
      const amount = r.status === "memo" ? perT(r.perTonne) : r.status === "scenario" ? (zero ? "£0" : `+${perT(r.perTonne)}`) : zero ? "£0.00" : `${r.perTonne < 0 ? "−" : "+"}£${Math.abs(r.perTonne).toFixed(2)}`;
      const li = el("li", { class: `cm-row ${stCls}${zero && r.status !== "memo" ? " is-zero" : ""} ${r.perTonne < 0 ? "is-down" : ""}`, style: `--i:${idx++}` });
      const btn = el("button", { type: "button", class: "cm-btn", "aria-expanded": "false" },
        el("span", { class: "cm-label", text: r.label }),
        el("span", { class: `cm-status ${stCls}`, text: stLabel }),
        el("span", { class: "cm-amt", text: amount }),
        icon('<path d="m6 9 6 6 6-6"/>', 14));
      const work = el("div", { class: "bd2-work" }, el("div", { class: "bd2-work-in" },
        ...(r.equations || []).map((q, n) => renderEq(q, n, r.equations.length)),
        r.note ? el("p", { class: "eq-why", text: r.note }) : null));
      btn.addEventListener("click", () => openWork(btn, work, !work.classList.contains("is-open")));
      li.append(btn, work);
      rowEls.push({ r, btn, work });
      return li;
    };
    const groupTotal = (g) => M.rows.filter((r) => r.group === g && r.status === "included" && r.key !== "price").reduce((t, r) => t + r.perTonne, 0);
    const model = M ? el("div", { class: "cm" },
      ...M.groups.filter((g) => M.rows.some((r) => r.group === g)).map((g) => {
        const rows = M.rows.filter((r) => r.group === g);
        const sub = g === "Purchase" ? M.rows.find((r) => r.key === "price").perTonne : groupTotal(g);
        return el("section", { class: "cm-group" },
          el("div", { class: "cm-group-head" }, el("h4", { text: g }), el("span", { class: "cm-group-sum", text: g === "Purchase" ? perT(sub) : Math.abs(sub) < 0.005 ? "£0.00" : `${sub < 0 ? "−" : "+"}£${Math.abs(sub).toFixed(2)}` })),
          el("ul", { class: "cm-list" }, ...rows.map(modelRow)));
      }),
      el("div", { class: "cm-total" },
        el("div", {}, el("span", { text: hasRisk ? "Expected landed cost" : "Landed cost" }), el("small", { text: "Included lines only — reference and if-missed lines aren't added" })),
        el("strong", { text: perT(T.expected) }))) : null;
    const intelBtn = me.canEdit ? el("button", { class: "link-btn", type: "button", text: `+ Log intel for ${s.name}`, onclick: () => window.openMarketIntel({ scope: "supplier", targetId: s.id }) }) : null;
    const allBtn = el("button", { class: "link-btn", type: "button", text: "Show all working", onclick: (ev) => {
      const open = ev.currentTarget.textContent.startsWith("Show");
      ev.currentTarget.textContent = open ? "Hide all working" : "Show all working";
      rowEls.forEach((x) => openWork(x.btn, x.work, open));
    } });
    const legend = el("div", { class: "eq-legend", "aria-label": "Where the numbers come from" },
      ...["quote", "supplier", "product", "you", "live", "fixed", "calc", "intel"].filter((k) => k !== "intel" || (M && M.rows.some((r) => r.group === "Market intel"))).map((k) => el("span", { class: `eq-chip k-${k}`, text: KIND[k] })));
    // open the quota lines (or the biggest cost) straight away
    requestAnimationFrame(() => {
      const pick = rowEls.find((x) => x.r.key === "steelExpected" && x.r.status === "included") || rowEls.filter((x) => x.r.key !== "price" && x.r.status === "included").sort((a, b2) => Math.abs(b2.r.perTonne) - Math.abs(a.r.perTonne))[0];
      if (pick) openWork(pick.btn, pick.work, true);
      const miss = rowEls.find((x) => x.r.key === "quotaMiss" && x.r.perTonne > 0);
      if (miss) openWork(miss.btn, miss.work, true);
    });
    const build = model;

    // ---- 4. what to weigh up — a compact checklist, most important first
    const order = { risk: 0, watch: 1, muted: 2, good: 3 };
    const cards = variableCards(s, d).sort((a, b) => order[a.verdict] - order[b.verdict]);
    const counts = { risk: 0, watch: 0, muted: 0, good: 0 };
    cards.forEach((c) => { counts[c.verdict] += 1; });
    const checklist = el("ul", { class: "bd2-checks" }, ...cards.map((c) => el("li", { class: `bd2-check is-${c.verdict}` },
      el("span", { class: "bd2-dot", "aria-label": { good: "Good", watch: "Watch", risk: "Risk", muted: "Missing" }[c.verdict] }),
      el("div", { class: "bd2-check-main" },
        el("div", { class: "bd2-check-head" }, el("span", { class: "bd2-check-name", text: c.name }), el("strong", { class: "bd2-check-val", text: c.value })),
        el("p", { text: c.note }),
        c.fix ? el("button", { class: "link-btn", type: "button", text: c.fix.label, onclick: c.fix.fn }) : null))));

    // ---- 5. same order, every supplier
    const cmpRows = bd.compare && bd.compare.rows ? bd.compare.rows.filter((r) => !r.error) : [];
    const mine = cmpRows.find((r) => r.id === s.id);
    const compare = cmpRows.length > 1 ? el("ol", { class: "bd2-rank" }, ...cmpRows.map((r, i) => {
      const diff = mine ? r.effectivePerT - mine.effectivePerT : 0;
      return el("li", { class: r.id === s.id ? "is-current" : "" },
        el("span", { class: "bd2-rank-n", text: i + 1 }),
        r.id === s.id ? el("strong", { class: "bd2-rank-name", text: `${r.name} (this supplier)` })
          : el("button", { class: "bd2-rank-name link-btn", type: "button", text: r.name, onclick: () => { openDetail(r.id, "breakdown"); } }),
        el("span", { class: "bd2-rank-meta", text: r.probability ? `${pctFmt(r.probability)} quota risk` : r.origin === "UK" ? "UK" : "" }),
        el("strong", { class: "bd2-rank-val", text: perT(r.effectivePerT) }),
        el("span", { class: `bd2-rank-diff ${diff > 0 ? "is-up" : diff < 0 ? "is-down" : ""}`, text: r.id === s.id ? "" : Math.abs(diff) < 0.5 ? "same" : `${diff > 0 ? "+" : "−"}${money(Math.abs(diff))}` }));
    })) : null;

    // ---- actions
    const save = me.canEdit && d.scenarioInputs ? el("button", { class: "btn btn-sm", type: "button", onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        const saved = await api("/api/scenarios", { method: "POST", body: { inputs: d.scenarioInputs } });
        toast("Saved to Orders as a draft scenario");
        const b = ev.target.closest("button"); b.replaceWith(el("a", { class: "btn btn-sm", href: `orders.html`, text: "Open in Orders →" }));
        return saved;
      } catch (error) { toast(error.message, true); ev.target.closest("button").disabled = false; }
    } }, icon('<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>', 15), "Save as order") : null;

    const sec = (title, aside, ...kids) => el("section", { class: "bd2-sec" }, el("div", { class: "bd2-sec-head" }, el("h3", { text: title }), aside || null), ...kids);
    panel.append(...[
      sentence,
      answer,
      sec("What to weigh up", el("span", { class: "bd2-tally" },
        counts.risk ? el("span", { class: "is-risk", text: `${counts.risk} risk${counts.risk === 1 ? "" : "s"}` }) : null,
        counts.watch ? el("span", { class: "is-watch", text: `${counts.watch} to watch` }) : null,
        counts.muted ? el("span", { class: "is-muted", text: `${counts.muted} missing` }) : null,
        el("span", { class: "is-good", text: `${counts.good} good` })), checklist),
      sec("Full cost model", el("div", { class: "bd2-sec-actions" }, intelBtn, allBtn), legend, build),
      compare ? sec("Same order from each supplier", el("span", { class: "small muted", text: "effective £/t, each at their own lead time" }), compare) : null,
      (e.checks || []).length || (e.warnings || []).length ? sec("Before you order", null, el("ul", { class: "bd2-todo" }, ...[...(e.warnings || []), ...(e.checks || [])].map((c) => el("li", { text: c })))) : null,
      el("div", { class: "bd2-actions" }, el("p", { class: "small muted", text: "Estimates only — not customs advice." }), save),
    ].filter(Boolean));
    return panel;
  }

  const ACTION = {
    created: ["Added", "is-created"], edited: ["Edited", ""], "quote logged": ["Quote received", "is-quote"], "quote requested": ["Quote requested", "is-stock"],
    "quote removed": ["Quote removed", ""], "updated from supplier sheet": ["Updated from supplier sheet", ""], "contact added": ["Contact added", ""], "contact updated": ["Contact updated", ""], "contact removed": ["Contact removed", ""], archived: ["Archived", ""],
  };
  const fmtVal = (v) => (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) ? "—" : Array.isArray(v) ? v.join(", ") : String(v));

  function auditPanel(s) {
    const acts = [...(s.activity || [])].sort((a, b) => b.at.localeCompare(a.at));
    const count = (a) => acts.filter((x) => x.action === a).length;
    const created = acts.find((x) => x.action === "created");
    return el("div", { class: "profile-panel" },
      el("div", { class: "audit-summary" },
        el("div", {}, el("span", { text: "Added" }), el("strong", { style: "font-size:15px", text: created ? fmt.date(created.at) : "—" }), el("span", { text: created ? `by ${created.by}` : "" })),
        el("div", {}, el("span", { text: "Quotes received" }), el("strong", { text: (s.quotes || []).length })),
        el("div", {}, el("span", { text: "Quotes requested" }), el("strong", { text: count("quote requested") })),
        el("div", {}, el("span", { text: "Times edited" }), el("strong", { text: count("edited") }))),
      el("ul", { class: "timeline" }, ...acts.map((a) => {
        const [label, cls] = ACTION[a.action] || [a.action, ""];
        return el("li", {}, el("span", { class: `dot ${cls}`, "aria-hidden": "true" }),
          el("div", { class: "t-head" }, el("strong", { text: label }), el("span", { text: `${a.by} · ${fmt.dateTime(a.at)}` })),
          a.changes && a.changes.length
            ? el("dl", { class: "t-changes" }, ...a.changes.flatMap((c) => [el("dt", { text: c.label }), el("dd", {}, el("del", { text: fmtVal(c.from) }), " → ", el("strong", { text: fmtVal(c.to) }))]))
            : a.detail ? el("p", { class: "t-note", text: a.detail }) : null);
      })));
  }

  function renderTabs(s) {
    const tabs = [["overview", "Overview", null], ["breakdown", "Cost breakdown", null], ["quotes", "Quotes", (s.quotes || []).length], ["contacts", "Contacts", (s.contacts || []).length], ["audit", "Audit trail", (s.activity || []).length]];
    $("profile-tabs").replaceChildren(...tabs.map(([key, label, n]) => el("button", {
      class: "profile-tab", type: "button", role: "tab", id: `tab-${key}`, "aria-selected": String(tab === key), "aria-controls": "view-detail", tabindex: tab === key ? "0" : "-1",
      onclick: () => { tab = key; renderTabs(s); renderBody(s); },
      onkeydown: (e) => {
        if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
        const i = tabs.findIndex((x) => x[0] === key);
        tab = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length][0];
        renderTabs(s); renderBody(s); $(`tab-${tab}`).focus();
      },
    }, label, n !== null ? el("span", { class: "count", text: n }) : null)));
  }

  function renderBody(s) {
    $("view-detail").replaceChildren(tab === "breakdown" ? breakdownPanel(s) : tab === "quotes" ? quotesPanel(s) : tab === "contacts" ? contactsPanel(s) : tab === "audit" ? auditPanel(s) : overviewPanel(s));
    $("view-detail").setAttribute("aria-labelledby", `tab-${tab}`);
  }

  function openDetail(id, t) {
    const s = suppliers.find((x) => x.id === id);
    if (!s) return;
    if (detailId !== id) tab = t || "overview";
    if (t) tab = t;
    detailId = id;
    const m = s.metrics;
    showDrawer("detail", s.name, "Supplier");
    const av = $("drawer-avatar");
    av.textContent = initials(s.name);
    av.hidden = false;
    const tags = $("drawer-tags");
    tags.replaceChildren(...[
      el("span", { class: "ident-tag", text: s.origin || "Origin not set" }),
      s.type ? el("span", { class: "ident-tag", text: s.type }) : null,
      el("span", { class: `ident-tag standing-${s.standing}`, text: choices.standing[s.standing] }),
      m.awaitingQuote ? el("span", { class: "ident-tag is-warn", text: `Awaiting reply · ${m.awaitingQuote.days ? `${m.awaitingQuote.days}d` : "today"}` }) : null,
      m.priceExpired ? el("span", { class: "ident-tag is-bad", text: "Price expired" }) : null].filter(Boolean));
    tags.hidden = false;
    const order = listOrder.length ? listOrder : suppliers.map((x) => x.id);
    const at = order.indexOf(s.id);
    for (const [btnId, step] of [["drawer-prev", -1], ["drawer-next", 1]]) {
      const b = $(btnId);
      const target = order[at + step];
      b.hidden = order.length < 2;
      b.disabled = at < 0 || !target;
      b.onclick = target ? () => openDetail(target, tab) : null;
      if (target) { const n = suppliers.find((x) => x.id === target); b.title = `${step < 0 ? "Previous" : "Next"}: ${n ? n.name : ""}`; }
    }
    renderTabs(s);
    renderBody(s);
    footer(
      me.canEdit ? el("button", { class: "btn", type: "button", onclick: () => openSupplierForm(s) }, icon(I.edit, 15), "Edit") : null,
      el("span", { class: "spacer" }),
      me.canEdit ? el("button", { class: "btn", type: "button", text: "Log quote", onclick: () => openQuoteForm(s) }) : null,
      me.canEdit ? el("button", { class: "btn btn-primary", type: "button", onclick: () => openRfq({ supplierId: s.id }) }, icon(I.mail, 15), "Request quote") : null);
    if (!drawer.contains(document.activeElement)) $(`tab-${tab}`).focus();
  }

  // ---------------------------------------------------------------- data
  async function load() {
    try {
      const r = await api("/api/suppliers");
      suppliers = r.suppliers;
      choices = r.choices;
      bd.key = null; // supplier data changed — recalculate the breakdown
      if (window.MarketTab) window.MarketTab.refresh();
      renderSummary();
      renderTable();
      if (mode === "detail" && detailId) openDetail(detailId);
      loadCosts();
    } catch (error) {
      $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "9", class: "empty", text: `Could not load suppliers: ${error.message}` })));
    }
  }

  // Price every supplier through the full cost model (expected value of the
  // quota duty, terms, MOQ, reliability…) so the list ranks on real cost.
  async function loadCosts() {
    const asked = cbamOn;
    const r = await api("/api/suppliers/compare", { method: "POST", body: { arrival: "lead", cbam: cbamOn } }).catch(() => null);
    if (asked !== cbamOn) return; // toggled again meanwhile
    const next = {};
    for (const s of suppliers) next[s.id] = null;
    for (const row of (r && r.rows) || []) if (Number.isFinite(row.effectivePerT)) next[row.id] = row;
    costs = next;
    renderTable();
    if (mode === "detail" && detailId && tab === "overview") { const s = suppliers.find((x) => x.id === detailId); if (s) renderBody(s); }
  }

  // ---------------------------------------------------------------- events
  {
    const t = document.getElementById("cbam-toggle");
    if (t) { t.checked = cbamOn; t.addEventListener("change", () => setCbam(t.checked)); }
    document.body.classList.toggle("cbam-on", cbamOn);
  }
  form.addEventListener("input", () => {
    dirty = true;
    const cancel = $("drawer-foot").querySelector("[data-cancel]");
    if (cancel && cancel.dataset.confirm) { delete cancel.dataset.confirm; cancel.textContent = "Cancel"; cancel.classList.remove("btn-danger"); }
  });
  form.addEventListener("change", (e) => {
    const f = e.target.closest("[data-field]");
    if (f && f.classList.contains("has-error")) { f.classList.remove("has-error"); const slot = f.querySelector(":scope > .error"); if (slot) slot.textContent = ""; }
  });
  $("add-btn").addEventListener("click", () => openSupplierForm(null));
  $("rfq-btn").addEventListener("click", () => openRfq());
  $("drawer-close").addEventListener("click", () => closeDrawer());
  $("backdrop").addEventListener("click", () => closeDrawer());
  $("drawer-size").addEventListener("click", () => { setSize(!large); if (mode === "detail" && detailId) { const s = suppliers.find((x) => x.id === detailId); if (s) renderBody(s); } });
  document.addEventListener("keydown", (e) => {
    if (drawer.hidden) return;
    if (e.key === "Escape") { e.preventDefault(); closeDrawer(); }
    if (e.key === "Tab") {
      const items = [...drawer.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex='0']")].filter((n) => n.offsetParent !== null);
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  ["q", "flt-supplies", "flt-origin", "sort"].forEach((id) => $(id).addEventListener("input", renderTable));

  loadMe().then((m) => { me = m; if (!me.canEdit) { $("add-btn").hidden = true; $("rfq-btn").hidden = true; } });
  api("/api/settings").then((r) => { settings = r.settings || {}; }).catch(() => {});
  // ---- page sub-tabs: Suppliers | Market prices
  const LEDE = {
    suppliers: "Who can supply what, at what price, and what it really costs once quota and duty are counted.",
    market: "Your supplier quotes against MEPS, Kallanish, market intel and what the competition is quoting.",
  };
  function showPane(name, { push = true } = {}) {
    for (const p of ["suppliers", "market"]) {
      const on = p === name;
      $(`pane-${p}`).hidden = !on;
      $(`ptab-${p}`).setAttribute("aria-selected", String(on));
      $(`ptab-${p}`).tabIndex = on ? 0 : -1;
      document.querySelectorAll(`.actions[data-pane="${p}"]`).forEach((a) => { a.hidden = !on; });
    }
    $("page-lede").textContent = LEDE[name];
    if (name === "market" && window.MarketTab) window.MarketTab.open();
    if (push) history.replaceState(null, "", name === "market" ? "#market" : location.pathname + location.search);
  }
  ["suppliers", "market"].forEach((p) => {
    $(`ptab-${p}`).addEventListener("click", () => showPane(p));
    $(`ptab-${p}`).addEventListener("keydown", (e) => {
      if (!["ArrowRight", "ArrowLeft"].includes(e.key)) return;
      const next = p === "suppliers" ? "market" : "suppliers";
      showPane(next); $(`ptab-${next}`).focus();
    });
  });
  if (location.hash === "#market") showPane("market", { push: false });
  // Live push from the server (new quotes / prices) — refresh unless you're mid-edit.
  window.addEventListener("agx:live", () => { if (mode !== "form") load(); });

  Promise.all([load(), api("/api/products").then((r) => { products = r.products.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true })); }).catch(() => {})]).then(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("supplier")) openDetail(params.get("supplier"));
    else if (params.get("rfq")) openRfq({ productId: params.get("rfq") });
    else if (params.get("quote")) { const s = suppliers.find((x) => x.id === params.get("quote")); if (s) openQuoteForm(s, { productId: params.get("product") || undefined }); }
    api("/api/steel-quotas/live").then((r) => { quota = r; renderTable(); if (mode === "detail" && detailId) { const s = suppliers.find((x) => x.id === detailId); if (s) renderBody(s); } }).catch(() => {});
  });
})();
