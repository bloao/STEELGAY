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
    const val = (s) => (by === "quoted" ? s.metrics.pricePerT : by === "ontime" ? -(s.onTimePct ?? -1) : s.metrics.worstCasePerT);
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
    const best = Math.min(...suppliers.map((s) => s.metrics.worstCasePerT).filter(Number.isFinite));
    $("rows").replaceChildren(...list.map((s) => {
      const m = s.metrics;
      const qline = quotaFor(s)[0];
      return el("tr", {
        class: `product-row supplier-row${s.id === highlightId ? " is-new" : ""}`, tabindex: "0",
        "aria-label": `${s.name}, ${perT(m.pricePerT, m.currency)}. Open profile`,
        onclick: () => openDetail(s.id),
        onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(s.id); } },
      },
        el("td", {},
          el("div", { class: "p-name" }, s.name, s.standing !== "active" ? el("span", { class: "tag tag-muted", text: choices.standing[s.standing] }) : null),
          el("div", { class: "p-meta" },
            el("span", { text: s.origin || "Origin not set" }),
            s.type ? el("span", { text: s.type }) : null,
            (s.supplies || []).length ? el("span", { text: s.supplies.join(", ") }) : null)),
        el("td", { class: "num" },
          el("strong", { text: perT(m.pricePerT, m.currency) }),
          el("div", { class: "row-sub" }, el("span", { class: `tag ${m.covers === "everything" ? "" : "tag-warn"}`, text: coversShort(m.covers) }), m.priceExpired ? el("span", { class: "tag tag-bad", text: "expired" }) : null)),
        el("td", { class: "num" },
          el("strong", { class: m.worstCasePerT === best ? "best" : "", text: perT(m.worstCasePerT, m.currency) }),
          el("div", { class: "row-sub" }, m.dutyUnknown ? "set origin to check" : m.dutyExposed ? quotaChip(qline) || "+50% duty" : m.covers === "everything" && isImport(s) ? "supplier carries duty" : isImport(s) ? "" : "no steel duty")),
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
    if (!list.length) $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "8", class: "empty", text: suppliers.length ? "No suppliers match these filters." : "No suppliers yet." })));
  }

  function renderSummary() {
    $("kpi-count").textContent = suppliers.length;
    const allIn = suppliers.filter((s) => !s.metrics.dutyExposed && !s.metrics.dutyUnknown && Number.isFinite(s.metrics.pricePerT));
    const best = allIn.sort((a, b) => a.metrics.pricePerT - b.metrics.pricePerT)[0];
    $("kpi-best").replaceChildren(best ? perT(best.metrics.pricePerT, best.metrics.currency) : "—", best ? el("small", { class: "stat-sub", text: best.name }) : "");
    const on = suppliers.map((s) => s.onTimePct).filter(Number.isFinite);
    $("kpi-ontime").textContent = on.length ? `${Math.round(on.reduce((a, b) => a + b, 0) / on.length)}%` : "—";
    const waiting = suppliers.filter((s) => s.metrics.awaitingQuote).length;
    $("kpi-waiting").textContent = waiting;
    $("kpi-waiting").parentElement.classList.toggle("is-zero", waiting === 0);
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
      section("Notes",
        fieldWrap("dutyRiskNote", "Duty / quota risk note", text("dutyRiskNote", v.dutyRiskNote, { maxlength: "300", placeholder: "How they handle quota and duty" })),
        fieldWrap("notes", "Notes", el("textarea", { id: "f-notes", name: "notes", rows: "3", maxlength: "1000", text: v.notes || "" }))));
    form.onsubmit = (e) => {
      e.preventDefault();
      const body = {};
      for (const k of ["name", "origin", "type", "standing", "website", "priceCovers", "deliveryTerms", "transport", "ddp", "currency", "moqMinT", "moqMaxT", "leadTimeMin", "leadTimeMax", "leadTimeUnit", "onTimePct", "paymentDays", "paymentNote", "dutyRiskNote", "notes"]) body[k] = field(k).value;
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
    footer(el("span", { class: "spacer" }), cancelBtn(s ? backToProfile(s.id) : null), el("button", { class: "btn btn-primary", type: "submit", form: "view-form", id: "save-btn", text: s ? "Save changes" : "Add supplier" }));
    field("name").focus();
  }

  // ---------------------------------------------------------------- quote form
  function openQuoteForm(s) {
    showDrawer("form", `Log a quote — ${s.name}`, "Quote received");
    const supplied = products.filter((p) => (s.supplies || []).includes(p.category));
    const others = products.filter((p) => !supplied.includes(p));
    const productSel = el("select", { id: "f-productId", name: "productId" },
      el("option", { value: "", text: "General price — not for one product" }),
      supplied.length ? el("optgroup", { label: "They supply" }, ...supplied.map((p) => el("option", { value: p.id, text: p.name }))) : null,
      others.length ? el("optgroup", { label: "Other products" }, ...others.map((p) => el("option", { value: p.id, text: p.name }))) : null);
    const awaiting = (s.rfqs || []).filter((r) => r.status === "open").sort((a, b) => b.at.localeCompare(a.at))[0];
    if (awaiting && awaiting.lines.length === 1 && awaiting.lines[0].productId) productSel.value = awaiting.lines[0].productId;
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
  function kv(rows) {
    const dl = el("dl", { class: "kv" });
    for (const [label, value, sub] of rows) dl.append(el("dt", { text: label }), el("dd", {}, value === null || value === undefined || value === "" ? "—" : value, sub ? el("small", { text: sub }) : null));
    return dl;
  }

  function overviewPanel(s) {
    const m = s.metrics;
    const qs = quotaFor(s);
    const supplied = products.filter((p) => (s.supplies || []).includes(p.category));
    const sec = (title, ...kids) => el("section", { class: "detail-section" }, el("h3", { text: title }), ...kids);
    return el("div", { class: "profile-panel profile-overview" },
      el("div", { class: "kv-head span-all" },
        el("div", {}, el("span", { text: "Quoted" }), el("strong", { text: perT(m.pricePerT, m.currency) }), el("small", { class: "kv-sub", text: m.priceDate ? `${coversShort(m.covers)} · ${m.priceChannel === "list" ? "supplier list" : ago(m.priceAgeDays)}` : "No quote yet" })),
        el("div", {}, el("span", { text: "If quota runs out" }), el("strong", { text: perT(m.worstCasePerT, m.currency) }), el("small", { class: "kv-sub", text: m.dutyUnknown ? "set the origin to work this out" : m.dutyExposed ? "+50% steel duty, you pay" : isImport(s) ? "supplier carries duty" : "UK — no steel duty" })),
        el("div", {}, el("span", { text: "On time" }), el("strong", { text: s.onTimePct === null ? "—" : `${s.onTimePct}%` })),
        el("div", {}, el("span", { text: "Lead time" }), el("strong", { text: lead(s) }))),
      sec("Commercial", kv([
        ["Price covers", choices.priceCovers[s.priceCovers] || ""],
        ["Delivery terms", s.deliveryTerms],
        ["Transport", { included: "Included in price", extra: "Charged extra" }[s.transport] || ""],
        ["DDP available", choices.ddp[s.ddp] || ""],
        ["Payment terms", terms(s), s.paymentNote],
        ["Currency", s.currency],
        ["Minimum order", s.moqNote || moq(s)],
      ])),
      sec("Quota & duty exposure",
        qs.length ? el("ul", { class: "exposure" }, ...qs.map((q) => el("li", {},
          el("div", {}, el("strong", { text: `Category ${q.categoryId}` }), el("span", { class: "small muted", text: ` ${categoryName(q.categoryId)}` })),
          el("div", { class: "exp-line" }, quotaChip(q) || "—",
            q.kind === "line" ? el("a", { class: "small", href: `quotas.html?category=${encodeURIComponent(q.categoryId)}`, text: `${q.line.residual ? "Other origins" : q.line.origin} line ${q.line.orderNumber}${q.line.runOutDate && q.line.risk !== "exhausted" ? ` · runs out ${fmt.date(q.line.runOutDate)}` : ""}` }) : null))))
          : el("p", { class: "muted small", style: "margin:0", text: quota ? "Tick what they supply (Edit) to see the quota lines that apply." : "Loading live quota balances…" }),
        s.dutyRiskNote ? el("p", { class: "small", style: "margin:8px 0 0", text: s.dutyRiskNote }) : null),
      sec("Pricing benchmarked against",
        (s.pricingSources || []).length
          ? el("div", { class: "source-chips" }, ...s.pricingSources.map((src) => (SOURCE_LINKS[src]
              ? el("a", { class: "chip", href: SOURCE_LINKS[src], target: "_blank", rel: "noopener", text: `${src} ↗` })
              : el("span", { class: "chip", text: src }))))
          : el("p", { class: "muted small", style: "margin:0", text: "Not recorded." })),
      sec("Your products they supply",
        supplied.length ? el("ul", { class: "mini-list" }, ...supplied.map((p) => el("li", {}, el("a", { href: `products.html?product=${p.id}`, text: p.name }), el("span", { class: "small muted", text: p.metrics && p.metrics.suggestedOrderT ? `order ${p.metrics.suggestedOrderT} t` : "" }))))
          : el("p", { class: "muted small", style: "margin:0", text: "None linked — tick what they supply in Edit." })),
      sec("Main contact",
        m.primaryContact ? contactCard(s, m.primaryContact, true) : el("p", { class: "muted small", style: "margin:0" }, "No contact yet. ", me.canEdit ? el("button", { class: "link-btn", type: "button", text: "Add one", onclick: () => openContactForm(s) }) : null)),
      s.website || s.notes ? el("section", { class: "detail-section span-all" }, el("h3", { text: "Notes" }),
        s.website ? el("p", { class: "small", style: "margin:0 0 6px" }, el("a", { href: s.website, target: "_blank", rel: "noopener", text: s.website.replace(/^https?:\/\//, "") })) : null,
        s.notes ? el("p", { style: "margin:0;white-space:pre-wrap", text: s.notes }) : null) : null);
  }

  function spark(quotes) {
    const pts = [...quotes].filter((q) => q.currency === "GBP").sort((a, b) => (a.date + a.at).localeCompare(b.date + b.at));
    if (pts.length < 2) return null;
    const W = 320, H = 64, pad = 6;
    const xs = pts.map((q) => Date.parse(q.date)), ys = pts.map((q) => q.pricePerT);
    const [x0, x1] = [Math.min(...xs), Math.max(...xs)], [y0, y1] = [Math.min(...ys), Math.max(...ys)];
    const X = (x) => pad + (x1 === x0 ? (W - 2 * pad) / 2 : ((x - x0) / (x1 - x0)) * (W - 2 * pad));
    const Y = (y) => H - pad - (y1 === y0 ? (H - 2 * pad) / 2 : ((y - y0) / (y1 - y0)) * (H - 2 * pad));
    const d = pts.map((q, i) => `${i ? "L" : "M"}${X(xs[i]).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join(" ");
    const wrap = el("div", { class: "spark" });
    wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Price history from £${ys[0]} to £${ys[ys.length - 1]} per tonne"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${pts.map((q, i) => `<circle cx="${X(xs[i]).toFixed(1)}" cy="${Y(ys[i]).toFixed(1)}" r="3" fill="currentColor"><title>${q.date}: £${q.pricePerT}/t</title></circle>`).join("")}</svg>`;
    wrap.append(el("div", { class: "spark-axis" }, el("span", { text: `${fmt.date(pts[0].date)} · £${ys[0]}` }), el("span", { text: `${fmt.date(pts[pts.length - 1].date)} · £${ys[ys.length - 1]}` })));
    return wrap;
  }

  function quotesPanel(s) {
    const quotes = [...(s.quotes || [])].sort((a, b) => (b.date + b.at).localeCompare(a.date + a.at));
    const open = (s.rfqs || []).filter((r) => r.status === "open");
    const today = todayIso();
    return el("div", { class: "profile-panel" },
      open.length ? el("div", { class: "notice" },
        el("strong", { text: `Waiting on ${open.length} quote request${open.length === 1 ? "" : "s"}` }),
        el("ul", { class: "mini-list" }, ...open.map((r) => el("li", {}, el("span", { text: `${fmt.date(r.at.slice(0, 10))} · ${r.lines.map((l) => `${l.name}${l.tonnage ? ` ${l.tonnage} t` : ""}`).join(", ")}` }), el("span", { class: "small muted", text: r.contactName ? `to ${r.contactName}` : "" }))))) : null,
      spark(quotes),
      quotes.length ? el("div", { class: "table-scroll" }, el("table", { class: "quota-table quotes-table" },
        el("thead", {}, el("tr", {}, el("th", { text: "Date" }), el("th", { class: "num", text: "Price" }), el("th", { text: "Covers" }), el("th", { text: "For" }), el("th", { class: "wide-only", text: "Valid until" }), el("th", { class: "wide-only", text: "Source" }), me.canEdit ? el("th", {}, el("span", { class: "sr-only", text: "Remove" })) : null)),
        el("tbody", {}, ...quotes.map((q) => el("tr", {},
          el("td", { text: fmt.date(q.date) }),
          el("td", { class: "num" }, el("strong", { text: perT(q.pricePerT, q.currency) })),
          el("td", { text: coversShort(q.covers) }),
          el("td", { text: `${q.productName || "General"}${q.tonnage ? ` · ${q.tonnage} t` : ""}` }),
          el("td", { class: "wide-only" }, q.validUntil ? el("span", { class: q.validUntil < today ? "status-dot is-bad" : "", text: fmt.date(q.validUntil) }) : "—"),
          el("td", { class: "wide-only", title: q.note || "", text: `${choices.quoteChannels[q.channel] || q.channel}${q.by && q.by !== "setup" ? ` · ${q.by}` : ""}` }),
          me.canEdit ? el("td", {}, q.channel === "list" ? null : el("button", { class: "link-btn", type: "button", text: "Remove", onclick: async (e) => {
            if (e.currentTarget.dataset.confirm !== "1") { e.currentTarget.dataset.confirm = "1"; e.currentTarget.textContent = "Remove?"; return; }
            try { await api(`/api/suppliers/${s.id}/quotes/${q.id}`, { method: "DELETE" }); toast("Quote removed"); await load(); openDetail(s.id, "quotes"); } catch (error) { toast(error.message, true); }
          } })) : null))))) : el("div", { class: "empty-state" }, el("h3", { text: "No quotes yet" }), el("p", { text: "Request a quote, then log their reply here." })),
      el("p", { class: "small muted", style: "margin:0", text: "The latest quote is the price used across the tool. Quotes from the supplier list are kept as the starting point." }));
  }

  function contactCard(s, c, compact) {
    return el("div", { class: "contact-card" },
      el("div", {}, el("strong", { text: c.name }), c.primary && !compact ? el("span", { class: "tag", text: "Main contact" }) : null, c.role ? el("div", { class: "small muted", text: c.role }) : null),
      el("div", { class: "contact-links" },
        c.email ? el("a", { href: `mailto:${c.email}`, text: c.email }) : null,
        c.phone ? el("a", { href: `tel:${c.phone.replace(/[^\d+]/g, "")}`, text: c.phone }) : null),
      compact || !me.canEdit ? null : el("div", { class: "contact-actions" },
        el("button", { class: "link-btn", type: "button", text: "Edit", onclick: () => openContactForm(s, c) }),
        el("button", { class: "link-btn", type: "button", text: "Remove", onclick: async (e) => {
          if (e.currentTarget.dataset.confirm !== "1") { e.currentTarget.dataset.confirm = "1"; e.currentTarget.textContent = "Remove?"; return; }
          try { await api(`/api/suppliers/${s.id}/contacts/${c.id}`, { method: "DELETE" }); toast("Contact removed"); await load(); openDetail(s.id, "contacts"); } catch (error) { toast(error.message, true); }
        } })));
  }

  function contactsPanel(s) {
    const list = [...(s.contacts || [])].sort((a, b) => Number(b.primary) - Number(a.primary));
    return el("div", { class: "profile-panel" },
      list.length ? el("div", { class: "contact-list" }, ...list.map((c) => contactCard(s, c)))
        : el("div", { class: "empty-state" }, el("h3", { text: "No contacts yet" }), el("p", { text: "Add the person you get quotes from — quote requests go to the main contact." })),
      me.canEdit ? el("div", {}, el("button", { class: "btn", type: "button", text: "Add contact", onclick: () => openContactForm(s) })) : null);
  }

  const ACTION = {
    created: ["Added", "is-created"], edited: ["Edited", ""], "quote logged": ["Quote received", "is-quote"], "quote requested": ["Quote requested", "is-stock"],
    "quote removed": ["Quote removed", ""], "contact added": ["Contact added", ""], "contact updated": ["Contact updated", ""], "contact removed": ["Contact removed", ""], archived: ["Archived", ""],
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
    const tabs = [["overview", "Overview", null], ["quotes", "Quotes", (s.quotes || []).length], ["contacts", "Contacts", (s.contacts || []).length], ["audit", "Audit trail", (s.activity || []).length]];
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
    $("view-detail").replaceChildren(tab === "quotes" ? quotesPanel(s) : tab === "contacts" ? contactsPanel(s) : tab === "audit" ? auditPanel(s) : overviewPanel(s));
    $("view-detail").setAttribute("aria-labelledby", `tab-${tab}`);
  }

  function openDetail(id, t) {
    const s = suppliers.find((x) => x.id === id);
    if (!s) return;
    if (detailId !== id) tab = t || "overview";
    if (t) tab = t;
    detailId = id;
    showDrawer("detail", s.name, [s.origin, s.type, choices.standing[s.standing]].filter(Boolean).join(" · "));
    renderTabs(s);
    renderBody(s);
    const archiveBtn = el("button", { class: "btn btn-danger", type: "button", text: "Archive", onclick: async () => {
      if (archiveBtn.dataset.confirm !== "1") { archiveBtn.dataset.confirm = "1"; archiveBtn.textContent = `Archive ${s.name}?`; return; }
      try { await api(`/api/suppliers/${s.id}/archive`, { method: "POST" }); toast(`${s.name} archived`); closeDrawer(true); await load(); } catch (error) { toast(error.message, true); }
    } });
    footer(
      me.canEdit ? archiveBtn : null,
      el("span", { class: "spacer" }),
      me.canEdit ? el("button", { class: "btn", type: "button", text: "Edit", onclick: () => openSupplierForm(s) }) : null,
      me.canEdit ? el("button", { class: "btn", type: "button", text: "Log quote", onclick: () => openQuoteForm(s) }) : null,
      me.canEdit ? el("button", { class: "btn btn-primary", type: "button", text: "Request quote", onclick: () => openRfq({ supplierId: s.id }) }) : null);
    if (!drawer.contains(document.activeElement)) $(`tab-${tab}`).focus();
  }

  // ---------------------------------------------------------------- data
  async function load() {
    try {
      const r = await api("/api/suppliers");
      suppliers = r.suppliers;
      choices = r.choices;
      renderSummary();
      renderTable();
      if (mode === "detail" && detailId) openDetail(detailId);
    } catch (error) {
      $("rows").replaceChildren(el("tr", {}, el("td", { colspan: "8", class: "empty", text: `Could not load suppliers: ${error.message}` })));
    }
  }

  // ---------------------------------------------------------------- events
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
  Promise.all([load(), api("/api/products").then((r) => { products = r.products.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true })); }).catch(() => {})]).then(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("supplier")) openDetail(params.get("supplier"));
    else if (params.get("rfq")) openRfq({ productId: params.get("rfq") });
    api("/api/steel-quotas/live").then((r) => { quota = r; renderTable(); if (mode === "detail" && detailId) { const s = suppliers.find((x) => x.id === detailId); if (s) renderBody(s); } }).catch(() => {});
  });
})();
