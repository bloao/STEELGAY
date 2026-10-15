// Packaging orders so a supplier's minimum load is met: put every product
// that needs ordering from that supplier on the same load, then if the load
// is still short, bring forward the next order of other products they supply
// (lowest cover first), and only then top up the lines already on it.

const r1 = (n) => Math.round(n * 10) / 10;

export function packageFor(supplier, { lines, fillers = [], price, ratePct = 8, storagePerTMonth = 2 }) {
  const supplies = new Set(supplier.supplies || []);
  const priced = (p) => supplies.has(p.category) && Number.isFinite(price(supplier.id, p.productId));
  const covered = lines.filter(priced);
  if (!covered.length) return null;
  const items = covered.map((p) => ({ ...p, tonnes: r1(p.needT), extraT: 0, role: "need", perT: price(supplier.id, p.productId) }));
  const min = Number(supplier.moqMinT) > 0 ? Number(supplier.moqMinT) : 0;
  const max = Number(supplier.moqMaxT) > 0 ? Number(supplier.moqMaxT) : Infinity;
  const total = () => items.reduce((n, x) => n + x.tonnes, 0);
  const needT = r1(total());
  // what a full set of loads has to reach
  const loadsFor = (t) => (Number.isFinite(max) ? Math.max(1, Math.ceil(t / max - 1e-9)) : 1);
  const target = () => { const t = total(); const n = loadsFor(t); return Number.isFinite(max) && n > 1 ? Math.max(t, (n - 1) * max + min) : Math.max(t, min); };
  let gap = r1(target() - total());
  // 1. bring forward the next order of other products this supplier sells
  const extra = fillers.filter((p) => priced(p) && !items.some((x) => x.productId === p.productId) && p.usage > 0)
    .sort((a, b) => (a.coverMonths ?? 99) - (b.coverMonths ?? 99));
  for (const p of extra) {
    if (gap <= 0) break;
    const t = Math.min(Math.ceil(gap), Math.max(1, Math.ceil(p.usage)));
    items.push({ ...p, needT: 0, tonnes: t, extraT: t, role: "bring-forward", perT: price(supplier.id, p.productId) });
    gap = r1(target() - total());
  }
  // 2. top up the lines already on the load, in proportion to how fast they're used
  if (gap > 0) {
    const pool = items.filter((x) => x.role === "need");
    const use = pool.reduce((n, x) => n + (x.usage || 0), 0);
    let left = Math.ceil(gap);
    pool.forEach((x, i) => {
      const share = i === pool.length - 1 ? left : Math.round((use > 0 ? (x.usage || 0) / use : 1 / pool.length) * Math.ceil(gap));
      const add = Math.min(left, Math.max(0, share));
      x.tonnes = r1(x.tonnes + add); x.extraT = r1(x.extraT + add); left -= add;
      if (add > 0) x.role = "need+top-up";
    });
  }
  const totalT = r1(total());
  const cost = items.reduce((n, x) => n + x.tonnes * x.perT, 0);
  // carrying the extra stock until it's used: cost of capital plus storage
  const holdCost = items.reduce((n, x) => {
    if (!(x.extraT > 0)) return n;
    const months = x.usage > 0 ? x.extraT / x.usage : 12;
    return n + (x.extraT * (x.perT * (ratePct / 100) * (months / 12) + storagePerTMonth * months)) / 2; // used down evenly, so half held on average
  }, 0);
  const needCost = items.reduce((n, x) => n + Math.min(x.tonnes, x.needT || 0) * x.perT, 0);
  return {
    supplierId: supplier.id, supplier: supplier.name, moqMinT: min || null, moqMaxT: Number.isFinite(max) ? max : null,
    loads: loadsFor(totalT), needT, totalT, extraT: r1(totalT - needT), meetsMoq: !min || totalT >= min,
    cost: Math.round(cost), perT: totalT ? Math.round(cost / totalT) : null, holdCost: Math.round(holdCost),
    // what each tonne you actually need ends up costing, extra stock included
    scorePerT: needT ? Math.round((needCost + holdCost) / needT) : null,
    items, covers: covered.length, uncovered: lines.filter((p) => !covered.includes(p)).map((p) => p.name),
  };
}

// Every supplier's package, best first: covers the most products, then
// cheapest per tonne on what you actually need to buy.
export function planPackages({ lines, fillers = [], suppliers, price, ratePct, storagePerTMonth }) {
  if (!lines.length) return { best: null, options: [] };
  const options = suppliers.map((s) => packageFor(s, { lines, fillers, price, ratePct, storagePerTMonth })).filter(Boolean)
    .sort((a, b) => b.covers - a.covers || a.scorePerT - b.scorePerT);
  return { best: options[0] || null, options };
}
