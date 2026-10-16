// Plan an order for several products at once. Every load has to meet the
// supplier's minimum, so the plan picks the products, sizes each line from
// demand, then tries every supplier (and every two-supplier split) and ranks
// the scenarios on what each tonne really costs once quota risk, lateness,
// payment terms, speed and the cost of holding any extra stock are counted.

const r1 = (n) => Math.round(n * 10) / 10;

// Size one supplier's load for a group of products: what each needs, then
// topped up in proportion to how fast each is used until the minimum is met.
export function sizeLoad(items, supplier, fill = "min") {
  const min = Number(supplier.moqMinT) > 0 ? Number(supplier.moqMinT) : 0;
  const max = Number(supplier.moqMaxT) > 0 ? Number(supplier.moqMaxT) : Infinity;
  const lines = items.map((x) => ({ productId: x.productId, needT: r1(x.needT), tonnes: r1(x.needT), extraT: 0 }));
  const sum = () => lines.reduce((n, x) => n + x.tonnes, 0);
  const loadsFor = (t) => (Number.isFinite(max) ? Math.max(1, Math.ceil(t / max - 1e-9)) : 1);
  // bulk ("full"): every truck goes full; otherwise just enough to meet the minimum
  const target = () => { const t = sum(); const n = loadsFor(t); if (fill === "full" && Number.isFinite(max)) return Math.max(t, n * max); return Number.isFinite(max) && n > 1 ? Math.max(t, (n - 1) * max + min) : Math.max(t, min); };
  const gap = Math.ceil(r1(target() - sum()));
  if (gap > 0) {
    const use = items.reduce((n, x) => n + (x.usage || 0), 0);
    let left = gap;
    lines.forEach((l, i) => {
      const share = i === lines.length - 1 ? left : Math.round((use > 0 ? (items[i].usage || 0) / use : 1 / lines.length) * gap);
      const add = Math.max(0, Math.min(left, share));
      l.tonnes = r1(l.tonnes + add); l.extraT = r1(add); left -= add;
    });
  }
  const totalT = r1(sum());
  return { lines, totalT, loads: loadsFor(totalT), moqMinT: min || null, moqMaxT: Number.isFinite(max) ? max : null };
}

// One supplier's part of a scenario, fully costed.
function costPart(group, supplier, line, money) {
  if (!group.every((x) => line(supplier.id, x.productId))) return null;
  const load = sizeLoad(group, supplier, money.fill);
  let landed = 0, score = 0, hold = 0, risk = 0, lateDays = 0, arrival = null;
  const warnings = new Set();
  const lines = load.lines.map((l) => {
    const item = group.find((x) => x.productId === l.productId);
    const o = line(supplier.id, l.productId);
    landed += l.tonnes * o.effectivePerT;
    // the tonnes you need carry the full scored cost; extra tonnes replace a later
    // purchase, so they only carry their risk and terms on top of the price, plus holding
    score += l.needT * o.score + l.extraT * (o.score - o.effectivePerT);
    risk += l.tonnes * (o.quotaExposure || 0);
    if (l.extraT > 0) {
      const months = item.usage > 0 ? l.extraT / item.usage : 12;
      hold += (l.extraT * (o.effectivePerT * (money.ratePct / 100) * (months / 12) + money.storagePerTMonth * months)) / 2;
    }
    lateDays = Math.max(lateDays, o.lateDays || 0);
    if (o.arrival && (!arrival || o.arrival > arrival)) arrival = o.arrival;
    (o.warnings || []).forEach((w) => warnings.add(w));
    return { ...l, name: item.name, perT: Math.round(o.effectivePerT), worstPerT: Math.round(o.worstPerT ?? o.effectivePerT), lateDays: o.lateDays || 0, arrival: o.arrival || null };
  });
  return {
    supplierId: supplier.id, supplier: supplier.name, origin: supplier.origin || "", ddp: supplier.ddp || "", paymentDays: supplier.paymentDays ?? null, onTimePct: supplier.onTimePct ?? null,
    ...load, lines, landed, score: score + hold, hold, risk, lateDays, arrival, warnings: [...warnings],
  };
}

// Every way to split the products into two groups (each non-empty).
function partitions(items) {
  const out = [];
  const n = items.length;
  for (let mask = 1; mask < (1 << (n - 1)); mask++) {
    const a = [], b = [];
    items.forEach((x, i) => ((i === n - 1 ? 0 : (mask >> i) & 1) ? a : b).push(x));
    if (a.length && b.length) out.push([a, b]);
  }
  return out;
}

export function planBasket({ items, suppliers, line, money = {} }) {
  const m = { ratePct: money.ratePct ?? 8, storagePerTMonth: money.storagePerTMonth ?? 2, splitOrderCost: money.splitOrderCost ?? 0, fill: money.fill === "full" ? "full" : "min" };
  const items2 = items.filter((x) => x.needT > 0);
  if (!items2.length) return { scenarios: [], best: null, uncovered: [] };
  const uncovered = items2.filter((x) => !suppliers.some((s) => line(s.id, x.productId))).map((x) => x.name);
  const want = items2.filter((x) => !uncovered.includes(x.name));
  const needT = r1(want.reduce((n, x) => n + x.needT, 0));
  const finish = (parts, kind) => {
    const totalT = r1(parts.reduce((n, p) => n + p.totalT, 0));
    const landed = parts.reduce((n, p) => n + p.landed, 0);
    const score = parts.reduce((n, p) => n + p.score, 0) + (parts.length - 1) * m.splitOrderCost;
    const extraT = r1(totalT - needT);
    return {
      id: parts.map((p) => p.supplierId).join("+"), kind, parts, totalT, needT, extraT,
      landed: Math.round(landed), perT: totalT ? Math.round(landed / totalT) : null,
      scorePerT: needT ? Math.round(score / needT) : null, hold: Math.round(parts.reduce((n, p) => n + p.hold, 0)),
      risk: Math.round(parts.reduce((n, p) => n + p.risk, 0)), lateDays: Math.max(...parts.map((p) => p.lateDays)),
      arrival: parts.map((p) => p.arrival).filter(Boolean).sort().slice(-1)[0] || null,
      payDays: Math.min(...parts.map((p) => p.paymentDays ?? 0)),
      warnings: [...new Set(parts.flatMap((p) => p.warnings))],
    };
  };
  const scenarios = [];
  // one supplier for everything
  for (const s of suppliers) { const p = costPart(want, s, line, m); if (p) scenarios.push(finish([p], "single")); }
  // two suppliers: every split of the products, best supplier pair for each
  if (want.length > 1) {
    for (const [a, b] of partitions(want)) {
      const pa = suppliers.map((s) => costPart(a, s, line, m)).filter(Boolean).sort((x, y) => x.score - y.score);
      const pb = suppliers.map((s) => costPart(b, s, line, m)).filter(Boolean).sort((x, y) => x.score - y.score);
      const pick = pa.flatMap((x) => pb.filter((y) => y.supplierId !== x.supplierId).slice(0, 2).map((y) => [x, y])).slice(0, 4)
        .map(([x, y]) => finish([x, y], "split")).sort((x, y) => x.scorePerT - y.scorePerT)[0];
      if (pick) scenarios.push(pick);
    }
  }
  // arriving in time first, then the real cost per tonne needed; drop duplicate supplier combinations
  scenarios.sort((x, y) => Number(x.lateDays > 0) - Number(y.lateDays > 0) || x.scorePerT - y.scorePerT);
  const seen = new Set();
  const unique = scenarios.filter((s) => { const k = s.parts.map((p) => p.supplierId).sort().join("|"); /* best allocation per supplier combination */ if (seen.has(k)) return false; seen.add(k); return true; });
  return { scenarios: unique.slice(0, 10), best: unique[0] || null, uncovered, needT };
}
