// "Log market intel": one form, opened from anywhere, for what you hear by
// word of mouth. Saved notes with a £/t or % effect go straight into the
// cost equations (supplier landed cost, product prices) and the forecast.
(function () {
  "use strict";
  if (window.MarketIntel) return;
  const OT = window.OrderTool;
  if (!OT) return;
  const { api, el, toast, fmt } = OT;
  let choices = null;

  async function loadChoices() {
    if (choices) return choices;
    const [p, s] = await Promise.all([api("/api/products").catch(() => ({ products: [] })), api("/api/suppliers").catch(() => ({ suppliers: [] }))]);
    const products = (p.products || []).map((x) => ({ id: x.id, name: x.name, category: x.category })).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
    const suppliers = (s.suppliers || []).map((x) => ({ id: x.id, name: x.name })).sort((a, b) => a.name.localeCompare(b.name));
    const groups = [...new Set([...products.map((x) => x.category), ...(s.suppliers || []).flatMap((x) => x.supplies || [])])].filter(Boolean).sort();
    choices = { products, suppliers, groups };
    return choices;
  }
  const addMonths = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() + n); return d.toISOString().slice(0, 10); };
  const today = () => new Date().toISOString().slice(0, 10);

  async function open(pre = {}) {
    const c = await loadChoices();
    const dlg = el("dialog", { class: "intel-dlg", "aria-labelledby": "intel-title" });
    const f = el("form", { method: "dialog", class: "intel-form", novalidate: "" });
    const radio = (name, value, label, checked) => el("label", { class: "intel-opt" }, el("input", { type: "radio", name, value, ...(checked ? { checked: "" } : {}) }), el("span", { text: label }));
    const scopeSel = el("select", { name: "targetId", "aria-label": "Which one" });
    const fillTargets = () => {
      const scope = f.elements.scope.value;
      const list = scope === "group" ? c.groups.map((g) => ({ id: g, name: g })) : scope === "product" ? c.products : scope === "supplier" ? c.suppliers : [];
      scopeSel.replaceChildren(...list.map((x) => el("option", { value: x.id, text: x.name })));
      scopeSel.hidden = scope === "market";
      if (pre.targetId && list.some((x) => x.id === pre.targetId)) scopeSel.value = pre.targetId;
      preview();
    };
    const amount = el("input", { name: "amount", type: "number", min: "0", step: "0.5", inputmode: "decimal", placeholder: "e.g. 20", value: pre.amount ?? "" });
    const unit = el("select", { name: "effectUnit", "aria-label": "Unit" }, el("option", { value: "perT", text: "£ per tonne" }), el("option", { value: "pct", text: "%" }));
    const prev = el("p", { class: "intel-preview", "aria-live": "polite" });
    const err = el("p", { class: "nf-err", "aria-live": "polite" });
    const preview = () => {
      const dir = f.elements.dir.value, scope = f.elements.scope.value;
      const amt = Number(amount.value);
      const from = f.elements.effectiveFrom.value || today();
      const months = Number(f.elements.horizonMonths.value);
      const who = scope === "market" ? "every supplier's landed cost" : scope === "group" ? `landed costs for ${scopeSel.value || "that group"}` : scope === "product" ? `${(c.products.find((x) => x.id === scopeSel.value) || {}).name || "that product"}'s landed cost from every supplier` : `${(c.suppliers.find((x) => x.id === scopeSel.value) || {}).name || "that supplier"}'s landed cost`;
      const amtTxt = unit.value === "pct" ? `${amt}%` : `£${amt}/t`;
      amount.disabled = unit.disabled = dir === "none";
      if (dir === "none" || !(amt > 0)) { prev.textContent = dir === "none" ? "Saved as a note only. It won't change any numbers." : "Enter how much it changes the price."; return; }
      prev.textContent = `${dir === "up" ? "Adds" : "Takes"} ${amtTxt} ${dir === "up" ? "to" : "off"} ${who} for anything arriving from ${fmt.date(from)} to ${fmt.date(addMonths(from, months))}.${scope === "market" || scope === "group" ? " It also moves the steel forecast. Quotes fixed beyond that date aren't changed." : ""}`;
    };
    f.append(
      el("div", { class: "intel-head" }, el("h2", { id: "intel-title", text: "Log market intel" }), el("button", { type: "button", class: "icon-btn", "aria-label": "Close", text: "×", onclick: () => dlg.close() })),
      el("p", { class: "small muted", style: "margin:0", text: "What you hear from mills, traders and customers. Give it a number and it goes straight into the cost equations." }),
      el("label", { class: "nf" }, el("span", { text: "What did you hear?" }), el("input", { name: "title", maxlength: "140", required: "", placeholder: "e.g. Megasa putting £20/t on merchant bar from November", value: pre.title || "" })),
      el("fieldset", { class: "nf intel-fs" }, el("legend", { text: "Who does it affect?" }),
        el("div", { class: "intel-opts" }, radio("scope", "market", "Whole market", (pre.scope || "market") === "market"), radio("scope", "group", "Product group", pre.scope === "group"), radio("scope", "product", "One product", pre.scope === "product"), radio("scope", "supplier", "One supplier", pre.scope === "supplier")),
        scopeSel),
      el("fieldset", { class: "nf intel-fs" }, el("legend", { text: "Effect on price" }),
        el("div", { class: "intel-opts" }, radio("dir", "up", "Up", (pre.dir || "up") === "up"), radio("dir", "down", "Down", pre.dir === "down"), radio("dir", "none", "No number, just a note", pre.dir === "none")),
        el("div", { class: "intel-amt" }, amount, unit)),
      el("div", { class: "intel-row" },
        el("label", { class: "nf" }, el("span", { text: "From" }), el("input", { name: "effectiveFrom", type: "date", value: pre.effectiveFrom || today() })),
        el("label", { class: "nf" }, el("span", { text: "For" }), el("select", { name: "horizonMonths" }, ...[[1, "1 month"], [3, "3 months"], [6, "6 months"], [12, "12 months"]].map(([v, l]) => el("option", { value: String(v), text: l, ...(v === 3 ? { selected: "" } : {}) })))),
        el("label", { class: "nf" }, el("span", { text: "Who told you" }), el("input", { name: "source", maxlength: "120", placeholder: "e.g. Megasa sales rep" }))),
      el("label", { class: "nf" }, el("span", { text: "Notes" }), el("textarea", { name: "body", rows: "2", maxlength: "1200", placeholder: "Anything else worth remembering" })),
      prev, err,
      el("div", { class: "nf-actions" }, el("button", { class: "btn", type: "button", text: "Cancel", onclick: () => dlg.close() }), el("button", { class: "btn btn-primary", type: "submit", value: "save", text: "Save intel" })));
    f.addEventListener("change", (e) => { if (e.target.name === "scope") fillTargets(); else preview(); });
    f.addEventListener("input", preview);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const dir = f.elements.dir.value, scope = f.elements.scope.value;
      const amt = Number(amount.value);
      const target = scope === "market" ? null : scope === "group" ? { id: scopeSel.value, name: scopeSel.value } : (scope === "product" ? c.products : c.suppliers).find((x) => x.id === scopeSel.value);
      const body = {
        title: f.elements.title.value, body: f.elements.body.value, source: f.elements.source.value, date: today(),
        effectiveFrom: f.elements.effectiveFrom.value, horizonMonths: f.elements.horizonMonths.value,
        scope, targetId: target ? target.id : "", targetName: target ? target.name : "",
        effectUnit: dir === "none" ? "none" : unit.value, effectValue: dir === "none" ? "" : (dir === "down" ? -amt : amt),
        impact: dir === "none" ? "neutral" : dir, topic: scope === "supplier" ? "Industry" : "Other",
      };
      if (dir !== "none" && !(amt > 0)) { err.textContent = "Enter how much it changes the price, or choose “No number”."; amount.focus(); return; }
      try {
        await api("/api/news/notes", { method: "POST", body });
        dlg.close();
        toast(dir === "none" ? "Intel saved" : "Intel saved and applied to the cost equations");
        window.dispatchEvent(new CustomEvent("agx:intel"));
        window.dispatchEvent(new CustomEvent("agx:live", { detail: "intel" }));
      } catch (error) { err.textContent = error.data && error.data.errors ? Object.values(error.data.errors).join(" ") : error.message; }
    });
    dlg.append(f);
    dlg.addEventListener("close", () => dlg.remove());
    document.body.append(dlg);
    fillTargets();
    if (pre.unit) unit.value = pre.unit;
    preview();
    dlg.showModal();
    f.elements.title.focus();
  }

  window.MarketIntel = { open };
})();
