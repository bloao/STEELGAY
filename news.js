(function () {
  "use strict";
  const { api, fmt, el, toast } = window.OrderTool;
  const $ = (id) => document.getElementById(id);
  let data = null;
  let topic = "All";

  const when = (days) => (days === 0 ? "today" : days === 1 ? "tomorrow" : days === -1 ? "yesterday" : days > 0 ? (days < 60 ? `in ${days} days` : `in ${Math.round(days / 30.4)} months`) : (days > -60 ? `${-days} days ago` : `${Math.round(-days / 30.4)} months ago`));
  const ICON = {
    up: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    down: '<path d="M12 5v14M5 12l7 7 7-7"/>',
    neutral: '<path d="M5 12h14"/>',
    link: '<path d="M14 4h6v6M20 4l-9 9M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>',
  };
  const svg = (d, n = 14) => { const s = el("span", { class: "ico", "aria-hidden": "true" }); s.innerHTML = `<svg width="${n}" height="${n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`; return s; };

  // ---------------------------------------------------------------- coming up
  function renderUpcoming() {
    const items = data.regulation.flatMap((r) => [{ date: r.date, daysUntil: r.daysUntil, label: r.status === "coming" ? `${r.title} starts` : null, reg: r }, ...r.keyDates.map((k) => ({ ...k, reg: r }))])
      .filter((x) => x.label && x.daysUntil >= -7)
      .filter((x, i, a) => !(x.label.endsWith(" starts") && a.some((y) => y !== x && y.date === x.date && y.reg === x.reg)))
      .sort((a, b) => a.date.localeCompare(b.date)).slice(0, 7);
    $("upcoming").replaceChildren(...(items.length ? items.map((x, i) => el("li", { class: `up-item${x.daysUntil <= 30 ? " is-soon" : ""}`, style: `--d:${i * 50}ms` },
      el("span", { class: "up-when", text: when(x.daysUntil) }),
      el("span", { class: "up-date", text: fmt.date(x.date) }),
      el("strong", { class: "up-label", text: x.label }),
      el("span", { class: "up-area", text: x.reg.title }))) : [el("li", { class: "muted", text: "Nothing scheduled in the tracker." })]));
  }

  // ---------------------------------------------------------------- regulation
  function renderRegulation() {
    $("regulation").replaceChildren(...data.regulation.map((r, i) => {
      const status = r.status === "coming" ? [`Starts ${when(r.daysUntil)}`, "is-coming"] : ["In force", "is-live"];
      const next = r.keyDates.filter((k) => k.daysUntil >= 0).slice(0, 3);
      return el("article", { class: `reg-card ${status[1]}`, style: `--d:${i * 70}ms` },
        el("div", { class: "reg-top" }, el("span", { class: `reg-status ${status[1]}`, text: status[0] }), el("span", { class: "reg-area", text: r.area })),
        el("h3", { text: r.title }),
        el("p", { class: "reg-sum", text: r.summary }),
        el("div", { class: "reg-impact" }, el("span", { text: "What it means for you" }), el("p", { text: r.impact })),
        next.length ? el("ul", { class: "reg-dates" }, ...next.map((k) => el("li", {}, el("b", { text: fmt.date(k.date) }), ` ${k.label}`))) : null,
        el("div", { class: "reg-foot" },
          el("span", { class: "reg-model", title: "Where this tool already accounts for it", text: r.modelled }),
          el("a", { href: r.source.url, target: "_blank", rel: "noopener", class: "reg-src" }, "Source", svg(ICON.link, 12))));
    }));
  }

  // ---------------------------------------------------------------- notes
  function renderNotes() {
    const notes = data.notes;
    const box = $("notes");
    if (!notes.length) {
      box.replaceChildren(el("li", { class: "notes-empty" }, el("strong", { text: "No insight logged yet" }),
        el("p", { text: "Heard a mill's raising prices, or scrap's falling? Log it. Mark whether it pushes prices up or down and the forecast takes it into account." })));
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    box.replaceChildren(...notes.map((n) => {
      const until = new Date(Date.parse(`${n.effectiveFrom || n.date}T00:00:00Z`)); until.setUTCMonth(until.getUTCMonth() + n.horizonMonths);
      const live = n.impact !== "neutral" && until.toISOString().slice(0, 10) > today;
      return el("li", { class: `note is-${n.impact}` },
        el("span", { class: `note-dir is-${n.impact}`, title: data.choices.impacts[n.impact] }, svg(ICON[n.impact], 16)),
        el("div", { class: "note-main" },
          el("div", { class: "note-head" }, el("strong", { text: n.title }),
            data.canEdit ? el("button", { class: "link-btn note-del", type: "button", "aria-label": `Remove “${n.title}”`, text: "Remove", onclick: async () => {
              try { await api(`/api/news/notes/${n.id}/archive`, { method: "POST" }); toast("Removed"); load(); } catch (error) { toast(error.message, true); }
            } }) : null),
          n.body ? el("p", { class: "note-body", text: n.body }) : null,
          el("div", { class: "note-meta" },
            el("span", { text: fmt.date(n.date) }), n.by ? el("span", { text: n.by }) : null, el("span", { text: n.topic }),
            n.effectUnit && n.effectUnit !== "none" && Number.isFinite(n.effectValue)
              ? el("span", { class: "note-effect", text: `${n.effectUnit === "pct" ? `${n.effectValue > 0 ? "+" : ""}${n.effectValue}%` : `${n.effectValue > 0 ? "+" : "−"}£${Math.abs(n.effectValue)}/t`} · ${n.scope === "market" || !n.scope ? "whole market" : n.targetName || n.targetId} · from ${fmt.date(n.effectiveFrom || n.date)} for ${n.horizonMonths} mo` })
              : n.impact !== "neutral" ? el("span", { text: `${data.choices.strengths[n.strength].split(" (")[0]} · over ${n.horizonMonths} month${n.horizonMonths === 1 ? "" : "s"}` }) : null,
            n.source ? (n.url ? el("a", { href: n.url, target: "_blank", rel: "noopener", text: n.source }) : el("span", { text: n.source })) : null,
            live ? el("span", { class: "note-live", text: n.effectUnit && n.effectUnit !== "none" ? `In the cost equations until ${fmt.date(until.toISOString().slice(0, 10))}` : `In the forecast until ${fmt.date(until.toISOString().slice(0, 10))}` }) : null)));
    }));
  }

  function openNoteForm() {
    const f = $("note-form");
    if (!f.hidden) { f.querySelector("input").focus(); return; }
    const c = data.choices;
    const seg = el("div", { class: "seg dir-seg", role: "radiogroup", "aria-label": "Effect on prices" },
      ...Object.entries({ up: "Prices up", down: "Prices down", neutral: "No clear effect" }).map(([v, l], i) => el("label", { class: `dir-opt is-${v}` },
        el("input", { type: "radio", name: "impact", value: v, ...(i === 0 ? { checked: "" } : {}) }), svg(ICON[v], 14), el("span", { text: l }))));
    const sel = (name, opts, value) => { const s = el("select", { name }, ...Object.entries(opts).map(([v, l]) => el("option", { value: v, text: l }))); s.value = String(value); return s; };
    const field = (label, control, cls = "") => el("label", { class: `nf ${cls}` }, el("span", { text: label }), control);
    f.replaceChildren(
      field("What did you hear?", el("input", { name: "title", maxlength: "140", placeholder: "e.g. Megasa adding £20/t from November", required: "" }), "nf-wide"),
      el("div", { class: "nf nf-wide" }, el("span", { text: "Effect on steel prices" }), seg),
      field("How strong", sel("strength", c.strengths, 2)),
      field("Over", sel("horizonMonths", { 1: "1 month", 3: "3 months", 6: "6 months", 12: "12 months" }, 3)),
      field("Topic", sel("topic", Object.fromEntries(c.topics.map((t) => [t, t])), "Industry")),
      field("Date", el("input", { name: "date", type: "date", value: new Date().toISOString().slice(0, 10), max: new Date().toISOString().slice(0, 10) })),
      field("Source", el("input", { name: "source", maxlength: "120", placeholder: "e.g. call with mill, Kallanish" })),
      field("Link", el("input", { name: "url", type: "url", maxlength: "400", placeholder: "https://… (optional)" })),
      field("Notes", el("textarea", { name: "body", rows: "2", maxlength: "1200", placeholder: "Anything else worth remembering" }), "nf-wide"),
      el("p", { class: "nf-err nf-wide", "aria-live": "polite" }),
      el("div", { class: "nf-actions nf-wide" },
        el("button", { class: "btn", type: "button", text: "Cancel", onclick: () => { f.hidden = true; } }),
        el("button", { class: "btn btn-primary", type: "submit", text: "Save insight" })));
    f.onsubmit = async (e) => {
      e.preventDefault();
      const body = Object.fromEntries(new FormData(f).entries());
      const err = f.querySelector(".nf-err");
      try {
        await api("/api/news/notes", { method: "POST", body });
        f.hidden = true; toast("Insight saved. The forecast will use it."); load();
      } catch (error) { err.textContent = error.data && error.data.errors ? Object.values(error.data.errors).join(" ") : error.message; }
    };
    f.hidden = false;
    f.querySelector("input").focus();
  }

  // ---------------------------------------------------------------- feed
  function renderFeed() {
    const items = data.feed;
    const topics = ["All", ...data.choices.topics.filter((t) => items.some((x) => x.topic === t))];
    if (!topics.includes(topic)) topic = "All";
    $("topics").replaceChildren(...topics.map((t) => el("button", { type: "button", class: "chip", "aria-pressed": String(t === topic), text: t === "All" ? `All (${items.length})` : t,
      onclick: () => { topic = t; renderFeed(); } })));
    $("topics").hidden = items.length === 0;
    $("feed-sub").textContent = data.fetchedAt ? `Steel, trade and carbon announcements. Last checked ${fmt.dateTime(data.fetchedAt)}.${data.errors.length ? " Some feeds didn't respond and will be retried." : ""}` : "Checking GOV.UK for the first time…";
    const shown = items.filter((x) => topic === "All" || x.topic === topic).slice(0, 25);
    $("feed").replaceChildren(...(shown.length ? shown.map((x, i) => el("li", { class: "feed-item", style: `--d:${Math.min(i, 10) * 40}ms` },
      el("div", { class: "feed-meta" }, el("span", { class: `topic-tag t-${x.topic.toLowerCase().replace(/[^a-z]+/g, "-")}`, text: x.topic }), el("span", { text: fmt.date(x.date) }), el("span", { text: x.source })),
      el("a", { href: x.url, target: "_blank", rel: "noopener", class: "feed-title", text: x.title }),
      x.summary ? el("p", { class: "feed-sum", text: x.summary }) : null))
      : [el("li", { class: "notes-empty" }, el("strong", { text: data.fetchedAt ? "Nothing relevant right now" : "Fetching…" }), el("p", { text: data.fetchedAt ? "No recent steel, trade or carbon items on GOV.UK. It checks again every 6 hours." : "This takes a few seconds the first time." }))]));
  }

  async function load() {
    try {
      data = await api("/api/news");
      renderUpcoming(); renderRegulation(); renderNotes(); renderFeed();
      $("add-note-btn").hidden = !data.canEdit;
      if (!data.fetchedAt) setTimeout(() => api("/api/news/refresh", { method: "POST" }).then(load).catch(() => {}), 300);
    } catch (error) {
      $("regulation").replaceChildren(el("p", { class: "muted", text: `Couldn't load: ${error.message}` }));
    }
  }

  $("add-note-btn").addEventListener("click", () => window.openMarketIntel({}));
  window.addEventListener("agx:intel", () => load());
  $("refresh-btn").addEventListener("click", async (e) => {
    const b = e.currentTarget; b.disabled = true; b.textContent = "Checking…";
    try { const r = await api("/api/news/refresh", { method: "POST" }); toast(r.added ? `${r.added} new item${r.added === 1 ? "" : "s"}` : "No new items"); await load(); }
    catch (error) { toast(error.message, true); }
    b.disabled = false; b.textContent = "Check for news";
  });
  if (window.EventSource) {
    const es = new EventSource((window.OrderTool.apiBase || "") + "/api/benchmarks/events", { withCredentials: Boolean(window.OrderTool.apiBase) });
    es.addEventListener("news", () => load());
  }
  load();
})();
