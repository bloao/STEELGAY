(function () {
  "use strict";
  const { api, fmt, el, toast } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let data = null;
  let filter = "all";

  const ago = (iso) => { if (!iso) return "never"; const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
  const etaTxt = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC" : "—");
  const per = (p) => new Date(Date.UTC(Number(p.slice(0, 4)), Number(p.slice(4, 6)) - 1, 1)).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" });
  const shipLink = (v) => (v && v.mmsi ? `https://www.marinetraffic.com/en/ais/details/ships/mmsi:${v.mmsi}` : v && v.imo ? `https://www.marinetraffic.com/en/ais/details/ships/imo:${v.imo}` : null);
  const LIKELY = { high: ["Likely steel", "is-go"], medium: ["Possible", "is-maybe"], watch: ["Loading at a steel port", "is-watch"] };
  const ROUTE_COLORS = { Sea: "#2a78d6", "Road / Ro-Ro": "#eb6834", "Rail / tunnel": "#1baf7a", Other: "#a8adb5" };
  const kn = (s) => (Number.isFinite(s) ? `${s.toFixed(1)} kn` : "");

  // ---------------------------------------------------------------- status
  function renderStrip() {
    const a = data.ais;
    const items = [];
    if (!a.hasKey) {
      items.push(el("div", { class: "ds-row is-busy" }, el("span", { text: "Live ship tracking is off. " }), el("a", { href: "settings.html#connections", text: "Add a free aisstream.io key in Settings →" })));
    } else {
      items.push(el("div", { class: "ds-row" },
        el("span", { class: `ds-item${a.connected ? " is-ok" : ""}` }, el("b", { text: "Live AIS" }), a.connected ? ` connected · last update ${ago(a.lastMessage)}` : ` ${a.error || "connecting…"}`),
        el("span", { class: "ds-item is-ok" }, el("b", { text: `${a.counts.inUk}` }), " cargo ships in UK approaches (3 days)"),
        el("span", { class: "ds-item is-ok" }, el("b", { text: `${a.counts.atSteelPorts}` }), " at steel-export ports"),
        a.tracked ? el("span", { class: "ds-item is-ok" }, el("b", { text: "Your ships" }), " followed worldwide") : null));
    }
    $("ais-strip").replaceChildren(...items);
    $("add-btn").hidden = !data.canEdit;
  }

  // ---------------------------------------------------------------- your shipments
  function renderMine() {
    const list = data.shipments.filter((s) => s.status === "active").concat(data.shipments.filter((s) => s.status === "arrived").slice(0, 5));
    if (!list.length) {
      $("mine").replaceChildren(el("div", { class: "notes-empty" }, el("strong", { text: "No shipments being tracked" }),
        el("p", { text: "When a supplier books your steel on a ship, add it here with the ship's name and MMSI. You'll see where it is and its arrival time without chasing anyone." })));
      return;
    }
    $("mine").replaceChildren(...list.map((s, i) => {
      const v = s.live;
      const sup = data.suppliers.find((x) => x.id === s.supplierId);
      const portName = (data.ports.find((p) => p.id === s.ukPort) || {}).name;
      const stale = v && v.at && Date.now() - Date.parse(v.at) > 6 * 3600_000;
      const status = s.status === "arrived" ? ["Arrived", "is-go"] : !v ? ["Waiting for a signal", "is-quiet"] : v.nearPort ? [`At ${v.nearPort}`, "is-go"] : v.inUk && Date.now() - Date.parse(v.inUk.at) < 86_400_000 ? [`In the ${v.inUk.area}`, "is-maybe"] : ["At sea", ""];
      const etaDiff = v && v.eta && s.expectedEta ? Math.round((Date.parse(v.eta) - Date.parse(`${s.expectedEta}T12:00:00Z`)) / 86_400_000) : null;
      return el("article", { class: "ship-row", style: `--d:${i * 50}ms` },
        el("div", { class: "ship-main" },
          el("div", { class: "ship-head" }, el("strong", { text: (v && v.name) || s.vessel || `MMSI ${s.mmsi}` }), el("span", { class: `sig-pill ${status[1]}`, text: status[0] })),
          el("p", { class: "ship-cargo", text: [s.tonnes ? `${s.tonnes} t` : null, s.product, sup ? `from ${sup.name}` : null, s.loadPort ? `loaded at ${s.loadPort}` : null].filter(Boolean).join(" · ") || "Cargo details not added" }),
          v ? el("p", { class: "ship-live" },
            `${v.area ? `${v.area} · ` : ""}${kn(v.sog)}${v.destination ? ` · heading for “${v.destination}”` : ""}${v.nmToPort !== null ? ` · ${v.nmToPort} nm to ${v.destPortName}` : ""}`,
            el("span", { class: stale ? "is-stale" : "", text: ` · seen ${ago(v.at)}` })) : el("p", { class: "ship-live muted", text: s.mmsi ? "No AIS signal received yet. Ships out of coastal range can go quiet for days." : "Add the MMSI to follow it anywhere; by name, we only spot it near UK or steel ports." })),
        el("div", { class: "ship-eta" },
          el("span", { text: "Ship's ETA" }), el("strong", { text: v && v.eta ? etaTxt(v.eta) : "—" }),
          s.expectedEta ? el("span", { class: `row-sub ${etaDiff > 1 ? "is-up" : ""}`, text: `you expected ${fmt.date(s.expectedEta)}${etaDiff !== null && Math.abs(etaDiff) >= 1 ? ` (${etaDiff > 0 ? `${etaDiff} days late` : `${-etaDiff} days early`})` : ""}` }) : null,
          portName ? el("span", { class: "row-sub", text: `into ${portName}` }) : null),
        el("div", { class: "ship-actions" },
          shipLink(v || s) ? el("a", { class: "link-btn small", href: shipLink(v || s), target: "_blank", rel: "noopener", text: "Map ↗" }) : null,
          data.canEdit && s.status === "active" ? el("button", { class: "link-btn small", type: "button", text: "Arrived", onclick: () => act(s, "arrived") }) : null,
          data.canEdit ? el("button", { class: "link-btn small", type: "button", text: "Edit", onclick: () => openForm(s) }) : null,
          data.canEdit ? el("button", { class: "link-btn small", type: "button", text: "Remove", onclick: () => act(s, "archive") }) : null));
    }));
  }
  async function act(s, what) {
    try { await api(`/api/arrivals/shipments/${s.id}/${what}`, { method: "POST" }); load(); } catch (error) { toast(error.message, true); }
  }

  // ---------------------------------------------------------------- likely steel
  function renderLikely() {
    const all = data.likely;
    const counts = { all: all.length, high: all.filter((x) => x.likelihood === "high").length, watch: all.filter((x) => x.likelihood === "watch").length, medium: all.filter((x) => x.likelihood === "medium").length };
    $("likely-filter").replaceChildren(...[["all", "All"], ["high", "Likely steel"], ["watch", "Loading"], ["medium", "Possible"]].map(([k, l]) => el("button", { type: "button", class: "chip", "aria-pressed": String(filter === k), text: `${l} (${counts[k]})`, onclick: () => { filter = k; renderLikely(); } })));
    const list = all.filter((x) => filter === "all" || x.likelihood === filter);
    if (!data.ais.hasKey) { $("likely").replaceChildren(el("div", { class: "chart-wait" }, el("div", {}, el("strong", { text: "Needs live ship data" }), el("p", { text: "Add an aisstream.io key in Settings. The tool then watches the Humber, Tees, Thames, Bristol Channel, Mersey and Forth, plus steel-export ports in Turkey, Spain, Italy and Poland, and flags cargo ships linking the two." })))); return; }
    if (!list.length) { $("likely").replaceChildren(el("p", { class: "muted", text: data.ais.messages ? "Nothing matching right now. Ships build up over the first few hours as their details come in." : "Listening… the first ships usually appear within a few minutes." })); return; }
    $("likely").replaceChildren(el("div", { class: "table-scroll" }, el("table", { class: "quota-table likely-table" },
      el("thead", {}, el("tr", {}, el("th", { text: "Ship" }), el("th", { text: "Why" }), el("th", { text: "Heading for" }), el("th", { text: "ETA" }), el("th", { text: "Last seen" }), el("th", { text: "" }))),
      el("tbody", {}, ...list.map((v, i) => {
        const [ll, lc] = LIKELY[v.likelihood] || [v.likelihood, ""];
        return el("tr", { class: "opp-row", style: `--d:${Math.min(i, 15) * 30}ms` },
          el("td", {}, el("strong", { text: v.name || `MMSI ${v.mmsi}` }), el("div", { class: "row-sub", text: [v.length ? `${v.length} m` : null, v.draught ? `draught ${v.draught} m` : null, v.yours ? "your shipment" : null].filter(Boolean).join(" · ") })),
          el("td", {}, el("span", { class: `sig ${lc}`, text: ll }), el("div", { class: "row-sub", text: v.why })),
          el("td", {}, el("strong", { text: v.destPortName || "—" }), el("div", { class: "row-sub", text: v.destination ? `“${v.destination}”` : "" })),
          el("td", { text: etaTxt(v.eta) }),
          el("td", {}, el("span", { text: v.area || "—" }), el("div", { class: "row-sub", text: `${ago(v.at)}${v.sog !== null ? ` · ${kn(v.sog)}` : ""}` })),
          el("td", {}, shipLink(v) ? el("a", { class: "link-btn small", href: shipLink(v), target: "_blank", rel: "noopener", text: "Map ↗" }) : null));
      })))));
  }

  // ---------------------------------------------------------------- HMRC ports & routes
  function renderPorts() {
    const h = data.hmrc;
    if (!h.tradeMonths || !h.hasPorts) {
      $("ports").replaceChildren(el("div", { class: "chart-wait" }, el("div", {}, el("strong", { text: h.oldFormat ? "Reload the HMRC volumes to see ports" : "No HMRC volumes loaded yet" }),
        el("p", {}, h.oldFormat ? "The volumes loaded earlier don't include ports. On the Competition page, click Check for new months to fetch them again with ports and routes." : "On the Competition page, click Load HMRC history. The same files give the port and route of every import.", " ", el("a", { href: "competition.html", text: "Open Competition →" })))));
      return;
    }
    const total = Object.values(h.routes).reduce((a, b) => a + b, 0) || 1;
    const routeBar = (routes, sum) => { const bar = el("div", { class: "route-bar", role: "img", "aria-label": Object.entries(routes).map(([k, t]) => `${k} ${Math.round((t / sum) * 100)}%`).join(", ") });
      for (const [k, t] of Object.entries(routes).sort((a, b) => b[1] - a[1])) bar.append(el("span", { style: `width:${(t / sum) * 100}%;background:${ROUTE_COLORS[k] || "#a8adb5"}`, title: `${k}: ${Math.round(t).toLocaleString("en-GB")} t (${Math.round((t / sum) * 100)}%)` }));
      return bar; };
    const months = h.periods;
    const top = h.ports.slice(0, 10);
    const maxP = Math.max(...top.map((p) => p.total)) || 1;
    $("ports-sub").textContent = `UK import tonnes for your product codes, ${per(months[0])} to ${per(months[months.length - 1])}, by port of entry and route (HMRC, about six weeks behind).`;
    $("ports").replaceChildren(
      el("div", { class: "route-summary" },
        el("div", {}, el("span", { class: "glance-l", text: "How it arrives" }), routeBar(h.routes, total),
          el("div", { class: "mk-legend" }, ...Object.entries(h.routes).sort((a, b) => b[1] - a[1]).map(([k, t]) => el("span", { class: "mk-key" }, el("span", { class: "swatch", style: `background:${ROUTE_COLORS[k]}` }), `${k} ${Math.round((t / total) * 100)}%`))))),
      el("div", { class: "table-scroll" }, el("table", { class: "quota-table port-table" },
        el("thead", {}, el("tr", {}, el("th", { text: "Port (HMRC code)" }), el("th", { class: "num", text: "Tonnes, 12 months" }), el("th", { text: "Share" }), el("th", { text: "Route" }), el("th", { text: "Month by month" }))),
        el("tbody", {}, ...top.map((p, i) => {
          const spark = el("span", { class: "port-spark" });
          const vals = months.map((m) => p.byMonth[m] || 0); const mx = Math.max(...vals) || 1;
          vals.forEach((v, j) => spark.append(el("span", { style: `height:${Math.max(2, (v / mx) * 22)}px`, title: `${per(months[j])}: ${Math.round(v).toLocaleString("en-GB")} t` })));
          const rsum = Object.values(p.routes).reduce((a, b) => a + b, 0) || p.total;
          return el("tr", { class: "opp-row", style: `--d:${i * 40}ms` },
            el("td", {}, el("strong", { text: p.port })),
            el("td", { class: "num" }, el("strong", { text: Math.round(p.total).toLocaleString("en-GB") })),
            el("td", {}, el("span", { class: "share-bar" }, el("span", { style: `width:${(p.total / maxP) * 100}%` })), el("span", { class: "row-sub", text: ` ${Math.round((p.total / total) * 100)}%` })),
            el("td", {}, routeBar(p.routes, rsum)),
            el("td", {}, spark));
        })))),
      el("p", { class: "lad-note", text: "Road / Ro-Ro is steel arriving on lorries and trailers through ferry ports. HMRC doesn't publish which company each tonne belongs to." }));
  }

  // ---------------------------------------------------------------- add / edit
  function openForm(s) {
    const card = $("add-card"), f = $("ship-form");
    const v = s || {};
    const sel = (name, opts, value, empty) => { const x = el("select", { name }, el("option", { value: "", text: empty }), ...opts.map((o) => el("option", { value: o.id, text: o.name }))); x.value = value || ""; return x; };
    const fld = (label, control, wide) => el("label", { class: `nf${wide ? " nf-wide" : ""}` }, el("span", { text: label }), control);
    f.replaceChildren(
      fld("Ship name", el("input", { name: "vessel", maxlength: "80", placeholder: "e.g. ARKLOW BEACON", value: v.vessel || "" })),
      fld("MMSI (9 digits)", el("input", { name: "mmsi", inputmode: "numeric", maxlength: "9", placeholder: "e.g. 250004203", value: v.mmsi || "" })),
      fld("IMO (7 digits)", el("input", { name: "imo", inputmode: "numeric", maxlength: "7", placeholder: "optional", value: v.imo || "" })),
      fld("Supplier", sel("supplierId", data.suppliers, v.supplierId, "Not set")),
      fld("What's on board", el("input", { name: "product", maxlength: "120", list: "prod-list", placeholder: "e.g. 40×10 Flat", value: v.product || "" })),
      fld("Tonnes", el("input", { name: "tonnes", type: "number", min: "0", step: "0.1", value: v.tonnes ?? "" })),
      fld("Loaded at", el("input", { name: "loadPort", maxlength: "80", placeholder: "e.g. Bilbao", value: v.loadPort || "" })),
      fld("Arriving into", sel("ukPort", data.ports, v.ukPort, "Not set")),
      fld("Expected arrival", el("input", { name: "expectedEta", type: "date", value: v.expectedEta || "" })),
      fld("Notes", el("textarea", { name: "notes", rows: "2", maxlength: "600", text: v.notes || "" }), true),
      el("datalist", { id: "prod-list" }, ...data.products.map((p) => el("option", { value: p.name }))),
      el("p", { class: "nf-err nf-wide", "aria-live": "polite" }),
      el("div", { class: "nf-actions nf-wide" }, el("button", { class: "btn", type: "button", text: "Cancel", onclick: () => { card.hidden = true; } }), el("button", { class: "btn btn-primary", type: "submit", text: s ? "Save" : "Track it" })));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f).entries());
      try {
        if (s) await api(`/api/arrivals/shipments/${s.id}`, { method: "PUT", body }); else await api("/api/arrivals/shipments", { method: "POST", body });
        card.hidden = true; toast(s ? "Saved" : "Tracking it"); load();
      } catch (error) { f.querySelector(".nf-err").textContent = error.data && error.data.errors ? Object.values(error.data.errors).join(" ") : error.message; }
    };
    card.hidden = false; card.scrollIntoView({ behavior: "smooth", block: "start" });
    f.querySelector("input").focus();
  }

  async function load() {
    try { data = await api("/api/arrivals"); renderStrip(); renderMine(); renderLikely(); renderPorts(); }
    catch (error) { $("mine").replaceChildren(el("p", { class: "muted", text: `Couldn't load: ${error.message}` })); }
  }
  $("add-btn").addEventListener("click", () => openForm(null));
  if (window.EventSource) {
    const es = new EventSource((window.OrderTool.apiBase || "") + "/api/benchmarks/events", { withCredentials: Boolean(window.OrderTool.apiBase) });
    es.addEventListener("arrivals", () => { if ($("add-card").hidden) load(); });
    es.addEventListener("competition", () => load());
  }
  setInterval(() => { if (!document.hidden && $("add-card").hidden) load(); }, 60_000);
  load();
})();
