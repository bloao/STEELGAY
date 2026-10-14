(function () {
  "use strict";
  const { api, fmt, el, statusBadge, toast } = window.OrderTool;
  const ids = (new URLSearchParams(window.location.search).get("ids") || "").split(",").filter(Boolean).slice(0, 4);
  const table = document.getElementById("compare-table");

  const lineValue = (s, key) => {
    const line = (s.result?.lines || []).find((l) => l.key === key);
    if (!line) return "—";
    if (line.status === "missing") return "Needs data";
    if (line.status === "in-price") return "In price";
    if (line.status === "supplier") return "Supplier carries";
    if (line.status === "n/a" && !line.perTonne) return "None";
    return fmt.perT(line.perTonne);
  };

  async function load() {
    if (ids.length < 2) {
      table.replaceChildren(el("tbody", {}, el("tr", {}, el("td", { class: "empty", text: "Pick 2–4 scenarios on the orders page to compare." }))));
      return;
    }
    let scenarios;
    try {
      scenarios = await Promise.all(ids.map((id) => api(`/api/scenarios/${id}`)));
    } catch (error) {
      toast(`Could not load scenarios: ${error.message}`, true);
      return;
    }

    const totals = scenarios.map((s) => s.result?.totals?.expectedPerT ?? Infinity);
    const bestIdx = totals.indexOf(Math.min(...totals));
    const best = scenarios[bestIdx];
    const cheapestHeadline = scenarios.reduce((a, b) => ((a.result?.lines[0]?.perTonne ?? Infinity) <= (b.result?.lines[0]?.perTonne ?? Infinity) ? a : b));
    const name = (s, i) => s.inputs.title || `Option ${String.fromCharCode(65 + i)}`;

    const first = scenarios[0].inputs;
    document.getElementById("compare-context").textContent = `${first.commodityDescription || first.commodityCode} · ${fmt.tonnes(first.tonnage)} · import ${fmt.date(first.importDate)}`;

    const codes = new Set(scenarios.map((s) => s.inputs.commodityCode));
    const tonnes = new Set(scenarios.map((s) => s.inputs.tonnage));
    const mismatch = document.getElementById("mismatch");
    if (codes.size > 1 || tonnes.size > 1) {
      mismatch.hidden = false;
      mismatch.textContent = "These scenarios differ in commodity code or tonnage — compare per-tonne figures with care.";
    }

    const verdict = document.getElementById("verdict");
    verdict.hidden = false;
    const bestName = name(best, bestIdx);
    let text = `Lowest expected cost: ${bestName} at ${fmt.perT(best.result.totals.expectedPerT)}.`;
    if (cheapestHeadline !== best) {
      const gap = cheapestHeadline.result.totals.expectedPerT - best.result.totals.expectedPerT;
      text += ` ${name(cheapestHeadline, scenarios.indexOf(cheapestHeadline))} has the lowest headline price but costs ${fmt.perT(gap)} more once duty, quota risk and costs are included.`;
    }
    verdict.replaceChildren(el("p", { style: "margin:0;font-size:15px", text }),
      el("a", { class: "btn btn-primary no-print", href: `order.html?id=${best.id}`, text: `Open ${bestName}` }));

    const cls = (i) => (i === bestIdx ? "is-best" : "");
    const head = el("thead", {}, el("tr", {}, el("th", {}),
      ...scenarios.map((s, i) => el("th", { class: cls(i) },
        el("div", { style: "font-family:var(--font-display);font-size:16px;font-weight:800" },
          el("a", { href: `order.html?id=${s.id}`, style: "color:inherit;text-decoration:none", text: name(s, i) }),
          i === bestIdx ? el("span", { class: "badge badge-good", style: "margin-left:8px", text: "Best" }) : null),
        el("div", { class: "small muted", style: "font-weight:400", text: `${s.inputs.supplier || "—"} · ${s.inputs.origin} · ${s.inputs.incoterm}` }),
        el("div", { style: "margin-top:6px" }, statusBadge(s.status, s.inputs.quoteValidUntil))))));

    const rows = [
      ["Quoted price", (s) => `${s.inputs.priceAmount} ${s.inputs.priceCurrency}/t`],
      ["Price in GBP", (s) => lineValue(s, "price")],
      ["Freight + insurance", (s) => {
        const lines = s.result?.lines || [];
        const f = lines.find((l) => l.key === "freight"); const ins = lines.find((l) => l.key === "insurance");
        if (f?.status === "supplier" || (f?.status === "in-price" && ins?.status === "in-price")) return "In price";
        const sum = (f?.perTonne || 0) + (ins?.perTonne || 0);
        return f?.status === "in-price" ? (sum ? `In price + ${fmt.perT(sum)} insurance` : "In price") : fmt.perT(sum);
      }],
      ["Import duty", (s) => lineValue(s, "duty")],
      ["Steel measure risk", (s) => {
        const q = s.result?.quota;
        return q ? `${lineValue(s, "quota")} · ${fmt.pct(q.probability)} exhaust chance` : lineValue(s, "quota");
      }],
      ["Anti-dumping / CVD", (s) => lineValue(s, "remedies")],
      ["CBAM", (s) => lineValue(s, "cbam")],
      ["Inland, brokerage, FX, finance", (s) => {
        const sum = ["inland", "brokerage", "fxBuffer", "finance"].reduce((t, k) => t + ((s.result?.lines || []).find((l) => l.key === k)?.perTonne || 0), 0);
        return fmt.perT(sum);
      }],
      ["Lead time", (s) => (s.inputs.leadTimeWeeks ? `${s.inputs.leadTimeWeeks} weeks` : "—")],
      ["Payment terms", (s) => s.inputs.paymentTerms || "—"],
      ["Quote valid until", (s) => fmt.date(s.inputs.quoteValidUntil)],
      ["Range if quota burn is faster / slower", (s) => {
        const t = s.result?.totals || {};
        return t.lowPerT === t.highPerT ? "No spread" : `${fmt.money(t.lowPerT)}–${fmt.money(t.highPerT)}/t`;
      }],
      ["Calculated", (s) => fmt.dateTime(s.result?.sources?.calculatedAt)],
    ];

    const body = el("tbody", {},
      ...rows.map(([label, fn]) => el("tr", {}, el("td", { text: label }), ...scenarios.map((s, i) => el("td", { class: cls(i), text: fn(s) })))),
      el("tr", { class: "total" }, el("td", { text: "Expected landed £/t" }),
        ...scenarios.map((s, i) => el("td", { class: cls(i), text: fmt.perT(s.result?.totals?.expectedPerT) }))));
    table.replaceChildren(head, body);
  }

  document.getElementById("btn-print").addEventListener("click", () => window.print());
  load();
})();
