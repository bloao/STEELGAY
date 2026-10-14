(function () {
  "use strict";
  const { api, el, toast, loadMe, fmt } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  const form = $("settings-form");
  const field = (n) => form.elements.namedItem(n);
  const CAT = window.STEEL_CATALOGUE;
  const SIMPLE = ["companyName", "defaultCategory", "defaultLeadTimeWeeks", "defaultMoqT", "defaultSafetyStockT", "defaultTargetCoverMonths", "costOfCapitalPct", "cbamRatePerT", "cbamEafTPerT", "cbamBofTPerT", "cbamUnknownTPerT", "metalsApiKey"];

  let saved = null;
  let groups = [];
  let canEdit = true;

  // Dropdowns built from data-options, same presets as the product form.
  form.querySelectorAll("select[data-options]").forEach((sel) => {
    const unit = sel.dataset.unit;
    const opts = sel.dataset.empty ? [el("option", { value: "", text: sel.dataset.empty })] : [];
    for (const v of sel.dataset.options.split(",")) opts.push(el("option", { value: v, text: unit === "%" ? `${v}%` : `${v} ${Number(v) === 1 && unit !== "t" ? unit.replace(/s$/, "") : unit}` }));
    sel.replaceChildren(...opts);
  });

  function ensureOption(sel, v) {
    if (v === "" || [...sel.options].some((o) => o.value === v)) return;
    sel.append(el("option", { value: v, text: `${v} ${sel.dataset.unit || ""}`.trim() }));
  }

  function fill(s) {
    $("s-category").replaceChildren(el("option", { value: "", text: "None — choose each time" }), ...groups.map((g) => el("option", { value: g, text: g })));
    for (const k of SIMPLE) {
      const v = s[k] === null || s[k] === undefined || (k === "defaultSafetyStockT" && !s[k]) ? "" : String(s[k]);
      const input = field(k);
      if (input.tagName === "SELECT") ensureOption(input, v);
      input.value = v;
    }
    const counts = {};
    if (CAT) CAT.families.forEach((f) => { counts[f.group] = (counts[f.group] || 0) + 1; });
    $("groups").replaceChildren(...groups.map((g) => el("label", { class: "check" },
      el("input", { type: "checkbox", name: "catalogueGroups", value: g, ...(s.catalogueGroups.includes(g) ? { checked: "" } : {}) }),
      el("span", { text: g }),
      el("small", { text: counts[g] ? `${counts[g]} product types` : "" }))));
    $("updated").textContent = s.updatedAt ? `Settings last saved ${fmt.date(s.updatedAt.slice(0, 10))}${s.updatedBy ? ` by ${s.updatedBy}` : ""}.` : "";
    markClean();
  }

  function read() {
    const body = {};
    for (const k of SIMPLE) body[k] = field(k).value;
    body.catalogueGroups = [...form.querySelectorAll('input[name="catalogueGroups"]:checked')].map((i) => i.value);
    return body;
  }

  const isDirty = () => saved && JSON.stringify(read()) !== JSON.stringify(snapshot(saved));
  function snapshot(s) {
    const o = {};
    for (const k of SIMPLE) o[k] = s[k] === null || s[k] === undefined || (k === "defaultSafetyStockT" && !s[k]) ? "" : String(s[k]);
    o.catalogueGroups = s.catalogueGroups;
    return o;
  }
  function markClean() { $("save-state").textContent = ""; $("save").disabled = !canEdit; $("reset").hidden = true; }
  function onChange() {
    const d = isDirty();
    $("save-state").textContent = d ? "Unsaved changes" : "";
    $("reset").hidden = !d;
  }

  function showErrors(errors = {}) {
    form.querySelectorAll("[data-field]").forEach((f) => {
      const msg = errors[f.dataset.field];
      f.classList.toggle("has-error", Boolean(msg));
      const slot = f.querySelector(".error");
      if (slot) slot.textContent = msg || "";
    });
  }

  async function save(e) {
    e.preventDefault();
    $("save").disabled = true;
    try {
      const res = await api("/api/settings", { method: "PUT", body: read() });
      saved = res.settings;
      showErrors({});
      fill(saved);
      toast("Settings saved");
    } catch (error) {
      showErrors((error.data && error.data.errors) || {});
      toast(error.message, true);
    } finally {
      $("save").disabled = !canEdit;
    }
  }

  async function connections() {
    api("/api/tariff-auth-check").then((r) => {
      const ok = r.mode === "registered" && r.signIn && r.signIn.ok;
      const node = $("conn-hmrc");
      node.className = `status-dot ${ok ? "" : r.mode === "public" ? "is-warn" : "is-bad"}`;
      node.textContent = ok ? "Connected" : r.mode === "public" ? "Public feed (no credentials)" : "Sign-in failed";
    }).catch(() => { $("conn-hmrc").className = "status-dot is-bad"; $("conn-hmrc").textContent = "Unavailable"; });
    api("/api/benchmarks").then((r) => {
      const ons = r.live.ONS || {}, lme = r.live.LME || {};
      const set = (id, cls, txt) => { $(id).className = `status-dot ${cls}`; $(id).textContent = txt; };
      set("conn-ons", ons.ok ? "" : ons.at ? "is-bad" : "is-muted", ons.ok ? `Live · ${fmt.date(ons.at.slice(0, 10))}` : ons.at ? "Unreachable" : "Starting…");
      set("conn-lme", !lme.hasKey ? "is-warn" : lme.ok ? "" : "is-bad", !lme.hasKey ? "Needs a key" : lme.ok ? "Live" : lme.at ? "Key not working" : "Connecting…");
      if (lme.hasKey && lme.error) $("conn-lme-sub").textContent = lme.error;
    }).catch(() => {});
    api("/api/assistant/status").then((r) => {
      const node = $("conn-claude");
      node.className = `status-dot ${r.configured ? "" : "is-warn"}`;
      node.textContent = r.configured ? "Connected" : "Not set up";
      $("conn-claude-model").textContent = r.configured ? `Model ${r.model}` : "Add ANTHROPIC_API_KEY to .env and restart the server";
    }).catch(() => { $("conn-claude").className = "status-dot is-bad"; $("conn-claude").textContent = "Unavailable"; });
  }

  form.addEventListener("input", onChange);
  form.addEventListener("change", onChange);
  form.addEventListener("submit", save);
  $("reset").addEventListener("click", () => { fill(saved); showErrors({}); });
  $("groups-all").addEventListener("click", () => { form.querySelectorAll('input[name="catalogueGroups"]').forEach((i) => { i.checked = true; }); onChange(); });
  window.addEventListener("beforeunload", (e) => { if (isDirty()) { e.preventDefault(); e.returnValue = ""; } });

  api("/api/settings").then((r) => {
    groups = r.catalogueGroups;
    if (r.metalsKeyFromEnv) $("metals-hint").textContent = "Set in the server's .env (METALS_API_KEY) — that takes priority.";
    canEdit = r.canEdit;
    saved = r.settings;
    fill(saved);
    if (!canEdit) {
      form.querySelectorAll("input, select").forEach((i) => { i.disabled = true; });
      $("save-state").textContent = "Your account can view settings but not change them.";
      $("backup").hidden = true;
    }
  }).catch((error) => toast(`Could not load settings: ${error.message}`, true));
  loadMe().then((me) => { $("signed-in").textContent = me.authEnabled ? `Signed in as ${me.name} (${me.role}).` : "Running locally without sign-in — everyone is an admin."; });
  connections();
})();
