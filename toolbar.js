// Compact table toolbar: turns each page's search box and filter dropdowns
// into a search icon (opens an input) and a filter icon (opens a panel with
// the filters and sort). The original inputs/selects are moved, not copied,
// so each page's own listeners keep working. Active filters show as chips.
(function () {
  "use strict";
  const SVG = (d, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    filter: '<path d="M3 5h18M6 12h12M10 19h4"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  const make = (tag, attrs = {}, html) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (html !== undefined) n.innerHTML = html;
    return n;
  };
  const labelFor = (sel) => {
    const raw = sel.getAttribute("aria-label") || sel.name || sel.id;
    const t = raw.replace(/^filter by /i, "").replace(/^sort( by)?$/i, "Sort by");
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const isSort = (sel) => /sort/i.test(sel.id) || /sort/i.test(sel.getAttribute("aria-label") || "");

  let uid = 0;
  function enhance(bar) {
    if (bar.dataset.compact) return;
    bar.dataset.compact = "1";
    const n = ++uid;
    const searchLabel = bar.querySelector("label.search");
    const input = searchLabel ? searchLabel.querySelector("input") : bar.querySelector('input[type="search"]');
    const selects = [...bar.querySelectorAll(":scope > select")];
    const extras = [...bar.children].filter((c) => c !== searchLabel && !selects.includes(c));

    bar.classList.add("toolbar-compact");
    const chips = make("div", { class: "tb-chips", "aria-live": "polite" });
    const tools = make("div", { class: "tb-tools" });

    // ---- search
    let searchWrap = null;
    if (input) {
      searchWrap = make("div", { class: "tb-search" });
      const btn = make("button", { type: "button", class: "tb-icon", "aria-label": input.getAttribute("aria-label") || "Search", "aria-expanded": "false", title: "Search  ( / )" }, SVG(ICON.search));
      const box = make("div", { class: "tb-search-box" });
      const clear = make("button", { type: "button", class: "tb-clear", "aria-label": "Clear search", hidden: "" }, SVG(ICON.x, 14));
      input.type = "search";
      box.append(input, clear);
      searchWrap.append(btn, box);
      const open = (focus = true) => { searchWrap.classList.add("is-open"); btn.setAttribute("aria-expanded", "true"); if (focus) input.focus(); };
      const close = () => { if (input.value) return; searchWrap.classList.remove("is-open"); btn.setAttribute("aria-expanded", "false"); };
      const sync = () => { clear.hidden = !input.value; if (input.value) open(false); };
      btn.addEventListener("click", () => (searchWrap.classList.contains("is-open") && !input.value ? close() : open()));
      input.addEventListener("input", sync);
      input.addEventListener("blur", () => setTimeout(close, 120));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.stopPropagation(); input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); input.blur(); close(); }
      });
      clear.addEventListener("mousedown", (e) => e.preventDefault());
      clear.addEventListener("click", () => { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); sync(); });
      document.addEventListener("keydown", (e) => {
        if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey) return;
        const t = e.target;
        if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
        if (document.body.classList.contains("drawer-open")) return;
        e.preventDefault();
        open();
      });
      sync();
      searchLabel && searchLabel.remove();
      tools.append(searchWrap);
    }

    // ---- filters
    let refresh = () => {};
    if (selects.length) {
      const wrap = make("div", { class: "tb-filter" });
      const btn = make("button", { type: "button", class: "tb-icon", "aria-haspopup": "true", "aria-expanded": "false", "aria-controls": `tb-panel-${n}`, "aria-label": "Filters", title: "Filter and sort" }, SVG(ICON.filter));
      const badge = make("span", { class: "tb-badge", hidden: "" });
      btn.append(badge);
      const panel = make("div", { class: "tb-panel", id: `tb-panel-${n}`, role: "dialog", "aria-label": "Filter and sort", hidden: "" });
      const filters = selects.filter((s) => !isSort(s));
      const sorts = selects.filter(isSort);
      const group = (title, list) => {
        if (!list.length) return null;
        const g = make("div", { class: "tb-group" });
        if (title) g.append(make("p", { class: "tb-group-title" }, title));
        for (const sel of list) {
          const id = sel.id || `tb-sel-${n}-${Math.random().toString(36).slice(2, 7)}`;
          sel.id = id;
          const lab = make("label", { class: "tb-field", for: id });
          lab.append(make("span", {}, labelFor(sel)), sel);
          g.append(lab);
        }
        return g;
      };
      const foot = make("div", { class: "tb-panel-foot" });
      const reset = make("button", { type: "button", class: "link-btn" }, "Clear filters");
      const done = make("button", { type: "button", class: "btn btn-sm btn-primary" }, "Done");
      foot.append(reset, done);
      [group(sorts.length ? "Filter" : "", filters), group("Sort", sorts), foot].forEach((x) => x && panel.append(x));
      wrap.append(btn, panel);
      tools.append(wrap);

      const active = () => filters.filter((s) => s.value !== "" && s.selectedIndex > 0);
      refresh = () => {
        const on = active();
        badge.hidden = !on.length;
        badge.textContent = on.length;
        btn.classList.toggle("is-active", on.length > 0);
        reset.hidden = !on.length;
        chips.replaceChildren(...on.map((s) => {
          const chip = make("button", { type: "button", class: "tb-chip", title: `Remove: ${labelFor(s)}` });
          chip.append(make("span", { class: "tb-chip-k" }, `${labelFor(s)}:`), document.createTextNode(` ${s.options[s.selectedIndex].text}`));
          chip.insertAdjacentHTML("beforeend", SVG(ICON.x, 13));
          chip.addEventListener("click", () => { s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); refresh(); });
          return chip;
        }));
        const sortSel = sorts[0];
        if (sortSel && sortSel.selectedIndex > 0) chips.append(make("span", { class: "tb-sort-note" }, sortSel.options[sortSel.selectedIndex].text.replace(/^Sort:\s*/i, "Sorted by ")));
      };
      const openPanel = () => { panel.hidden = false; btn.setAttribute("aria-expanded", "true"); (panel.querySelector("select") || done).focus(); };
      const closePanel = (focusBtn) => { panel.hidden = true; btn.setAttribute("aria-expanded", "false"); if (focusBtn) btn.focus(); };
      btn.addEventListener("click", () => (panel.hidden ? openPanel() : closePanel()));
      done.addEventListener("click", () => closePanel(true));
      reset.addEventListener("click", () => {
        for (const s of filters) { s.value = ""; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); }
        refresh();
      });
      panel.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.stopPropagation(); closePanel(true); } });
      document.addEventListener("click", (e) => { if (!panel.hidden && !wrap.contains(e.target)) closePanel(); });
      selects.forEach((s) => {
        s.addEventListener("input", refresh);
        s.addEventListener("change", refresh);
        // pages rebuild option lists (e.g. categories) — keep chips in step
        new MutationObserver(refresh).observe(s, { childList: true });
      });
    }

    extras.forEach((x) => tools.append(x));
    bar.replaceChildren(chips, tools);
    refresh();
    // pages may preset a filter from the URL after load
    setTimeout(refresh, 0);
    window.addEventListener("load", refresh);
  }

  const run = () => document.querySelectorAll(".table-card > .toolbar").forEach(enhance);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run);
  else run();
})();
