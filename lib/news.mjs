// Market news and regulation.
//
// Three things live here:
//  1. REGULATION — a curated tracker of the rules that move steel costs, with
//     dates, what changes, and whether the cost engine already models it.
//  2. GOV.UK feeds — free Atom search feeds, filtered to steel / trade /
//     carbon items and tagged by topic.
//  3. Team insight notes — what you hear from mills, traders and customers,
//     each marked as pushing prices up or down. The forecast uses these.

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const today = () => new Date().toISOString().slice(0, 10);

// Kept short and sourced. "modelled" says where the tool already prices it.
export const REGULATION = [
  {
    id: "uk-steel-measure",
    title: "UK steel trade measure",
    status: "in-force",
    date: "2026-07-01",
    area: "Tariffs & quotas",
    summary: "Replaced the steel safeguard. Tariff-free quotas cut by 51%, and imports over quota pay 50% (up from 25%). Quotas run in quarters, first come first served, and unused quota rolls into the next quarter but not into the next year.",
    impact: "Imports outside quota cost 50% more. The risk of missing quota is priced into every supplier's expected cost.",
    modelled: "Suppliers → cost breakdown (expected quota duty and if-missed cost); Live quotas",
    keyDates: [
      { date: "2026-10-01", label: "Q2 quota period opens" },
      { date: "2027-01-01", label: "Q3 quota period opens" },
      { date: "2027-04-01", label: "Q4 quota period opens" },
      { date: "2027-07-01", label: "New quota year; unused quota doesn't carry over" },
    ],
    source: { label: "GOV.UK: UK's steel trade measure from 1 July 2026", url: "https://www.gov.uk/government/publications/uks-steel-trade-measure-from-1-july-2026/uks-steel-trade-measure-from-1-july-2026" },
  },
  {
    id: "uk-cbam",
    title: "UK Carbon Border Adjustment Mechanism (CBAM)",
    status: "coming",
    date: "2027-01-01",
    area: "Carbon",
    summary: "A charge on the carbon embedded in imported iron and steel, paid by the importer to HMRC. It's emissions × a quarterly UK CBAM rate based on the UK ETS price, less any carbon price already paid abroad. Registration is needed once imports reach £50,000 a year.",
    impact: "Adds roughly £30–£125/t to imported bar depending on the mill (electric arc vs blast furnace), at today's carbon price. The rate and default values aren't published yet.",
    modelled: "Suppliers → UK CBAM toggle; Settings → UK CBAM; Steel forecast (import-cost driver)",
    keyDates: [
      { date: "2027-01-01", label: "CBAM starts; first quarterly rate published" },
      { date: "2028-01-31", label: "Deadline to register for 2027 imports" },
      { date: "2028-05-31", label: "First return and payment, for 2027" },
    ],
    source: { label: "ukcbam.com: iron and steel under the UK CBAM", url: "https://ukcbam.com/sectors/iron-and-steel" },
  },
  {
    id: "eu-steel-measure",
    title: "EU steel measure (replaces the EU safeguard)",
    status: "in-force",
    date: "2026-07-01",
    area: "Tariffs & quotas",
    summary: "The EU cut tariff-free steel quotas by about 47% to around 18.3 million tonnes a year, and doubled the out-of-quota duty to 50%. From 1 October 2026 importers must prove where the steel was first melted and poured.",
    impact: "Less third-country steel can enter the EU, which supports EU mill prices, and those are the prices your EU suppliers quote from.",
    modelled: "Not modelled directly. It shows up in EU quotes and the market prices you log.",
    keyDates: [{ date: "2026-10-01", label: "EU melt-and-pour evidence required" }],
    source: { label: "SMM: EU's permanent steel safeguard takes hold", url: "https://news.metal.com/newscontent/104018661-eus-permanent-steel-safeguard-takes-hold-50-out-of-quota-duty-quotas-cut-47" },
  },
  {
    id: "uk-eu-origin",
    title: "UK–EU trade agreement: 0% duty with proof of origin",
    status: "in-force",
    date: "2021-01-01",
    area: "Origin",
    summary: "EU-origin steel enters at 0% ordinary duty only with a statement on origin on the invoice. The UK steel measure gives the EU its own country quotas.",
    impact: "Missing origin paperwork means ordinary duty on top of any quota exposure.",
    modelled: "Suppliers → cost breakdown (proof of origin check)",
    keyDates: [],
    source: { label: "GOV.UK: UK's steel trade measure (EU allocations)", url: "https://www.gov.uk/government/publications/uks-steel-trade-measure-from-1-july-2026/uks-steel-trade-measure-from-1-july-2026" },
  },
];

// GOV.UK Atom search feeds (no key). Results are filtered by RELEVANT below.
export const NEWS_FEEDS = [
  { id: "govuk-steel", label: "GOV.UK", url: "https://www.gov.uk/search/all.atom?keywords=steel&order=updated-newest" },
  { id: "govuk-cbam", label: "GOV.UK", url: "https://www.gov.uk/search/all.atom?keywords=carbon+border+adjustment+mechanism&order=updated-newest" },
  { id: "govuk-remedies", label: "GOV.UK", url: "https://www.gov.uk/search/all.atom?keywords=trade+remedies&order=updated-newest" },
];

const RELEVANT = /\b(steel|iron|metal|tariff|quota|safeguard|anti-?dumping|countervailing|trade remed|cbam|carbon border|emissions trading|uk ets|import dut|rules of origin|customs)\b/i;
const TOPICS = [
  ["Carbon", /\b(cbam|carbon border|emissions trading|uk ets|carbon price)\b/i],
  ["Trade remedies", /\b(anti-?dumping|countervailing|trade remed|dumping|subsid)\b/i],
  ["Tariffs & quotas", /\b(tariff|quota|safeguard|import dut|steel trade measure)\b/i],
  ["Energy & costs", /\b(energy|electricity|gas price|power price|supercharger)\b/i],
  ["Industry", /\b(steel|mill|blast furnace|electric arc|scunthorpe|port talbot)\b/i],
];
export const NEWS_TOPICS = [...TOPICS.map((t) => t[0]), "Other"];

const decode = (s) => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const stripTags = (s) => decode(s).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

export function parseAtom(xml, feed = {}) {
  const out = [];
  const entries = String(xml || "").match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  for (const e of entries) {
    const pick = (tag) => { const m = e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`)); return m ? m[1] : ""; };
    const link = (e.match(/<link[^>]*rel="alternate"[^>]*href="([^"]+)"/) || e.match(/<link[^>]*href="([^"]+)"/) || [])[1] || "";
    const title = stripTags(pick("title"));
    const summary = stripTags(pick("summary") || pick("content")).slice(0, 400);
    const updated = (pick("updated") || pick("published")).trim();
    if (!title || !link) continue;
    out.push({ id: decode(pick("id")).trim() || link, title, summary, url: decode(link), date: updated.slice(0, 10), at: updated, source: feed.label || "GOV.UK", feed: feed.id || "" });
  }
  return out;
}

export function classify(item) {
  const text = `${item.title} ${item.summary}`;
  if (!RELEVANT.test(text)) return null;
  const topic = (TOPICS.find(([, re]) => re.test(text)) || ["Other"])[0];
  return { ...item, topic };
}

// Merge feed results: relevant only, de-duplicated by URL, newest first.
export function mergeNews(lists, { limit = 60 } = {}) {
  const seen = new Map();
  for (const item of lists.flat()) {
    const c = classify(item);
    if (!c) continue;
    if (!seen.has(c.url) || (seen.get(c.url).at || "") < (c.at || "")) seen.set(c.url, c);
  }
  return [...seen.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit);
}

export const SCOPES = ["market", "group", "product", "supplier"];

// Is a note in force for something arriving on `date`?
export function noteActive(n, date) {
  if (!n || n.status === "archived") return false;
  const from = n.effectiveFrom || n.date;
  if (date < from) return false;
  const end = new Date(`${from}T00:00:00Z`); end.setUTCMonth(end.getUTCMonth() + (n.horizonMonths || 3));
  return date < end.toISOString().slice(0, 10);
}
// Notes that apply to one supplier/product order.
export function notesFor(notes, { supplierId, productId, group, date }) {
  return notes.filter((n) => n.effectUnit && n.effectUnit !== "none" && Number.isFinite(n.effectValue) && noteActive(n, date) && (
    n.scope === "market" || (n.scope === "group" && n.targetId === group) || (n.scope === "product" && n.targetId === productId) || (n.scope === "supplier" && n.targetId === supplierId)));
}

export const IMPACTS = { up: "Pushes prices up", down: "Pushes prices down", neutral: "No clear direction" };
export const STRENGTHS = { 1: "Slight (about 1%)", 2: "Moderate (about 3%)", 3: "Strong (about 5%)" };
export const STRENGTH_PCT = { 1: 1, 2: 3, 3: 5 };

export function validateNote(raw = {}, { asOf = today() } = {}) {
  const errors = {};
  const n = {
    title: str(raw.title, 140),
    body: str(raw.body, 1200),
    date: isDate(str(raw.date, 10)) ? str(raw.date, 10) : asOf,
    impact: raw.impact in IMPACTS ? raw.impact : "neutral",
    strength: [1, 2, 3].includes(Number(raw.strength)) ? Number(raw.strength) : 1,
    horizonMonths: [1, 3, 6, 12].includes(Number(raw.horizonMonths)) ? Number(raw.horizonMonths) : 3,
    topic: NEWS_TOPICS.includes(raw.topic) ? raw.topic : "Other",
    source: str(raw.source, 120),
    url: str(raw.url, 400),
    // Who it applies to, and by how much: this is what feeds the cost equations
    scope: SCOPES.includes(raw.scope) ? raw.scope : "market",
    targetId: str(raw.targetId, 80),
    targetName: str(raw.targetName, 120),
    effectUnit: ["perT", "pct"].includes(raw.effectUnit) ? raw.effectUnit : "none",
    effectValue: raw.effectValue === "" || raw.effectValue === null || raw.effectValue === undefined ? null : Number(raw.effectValue),
    effectiveFrom: isDate(str(raw.effectiveFrom, 10)) ? str(raw.effectiveFrom, 10) : "",
  };
  if (n.scope !== "market" && !n.targetId) errors.targetId = "Pick who this applies to.";
  if (n.scope === "market") { n.targetId = ""; n.targetName = ""; }
  if (n.effectUnit !== "none") {
    if (!Number.isFinite(n.effectValue) || n.effectValue === 0) errors.effectValue = "Enter the change, e.g. 20 or -15.";
    else if (n.effectUnit === "pct" && Math.abs(n.effectValue) > 60) errors.effectValue = "Use a change between −60% and +60%.";
    else if (n.effectUnit === "perT" && Math.abs(n.effectValue) > 1000) errors.effectValue = "Use a change between −£1,000 and +£1,000 a tonne.";
    else {
      // direction and strength follow the number, so the forecast stays consistent
      n.impact = n.effectValue > 0 ? "up" : "down";
      const pctGuess = n.effectUnit === "pct" ? Math.abs(n.effectValue) : (Math.abs(n.effectValue) / 750) * 100;
      n.strength = pctGuess <= 2 ? 1 : pctGuess <= 4 ? 2 : 3;
    }
  } else n.effectValue = null;
  if (!n.effectiveFrom) n.effectiveFrom = n.date;
  if (!n.title) errors.title = "Say what you heard, in a line.";
  if (n.date > asOf) errors.date = "The date can't be in the future.";
  if (n.url && !/^https?:\/\/[^\s]+\.[^\s]+$/i.test(n.url)) errors.url = "Enter a full web address, or leave it blank.";
  return { note: n, errors, valid: Object.keys(errors).length === 0 };
}

export function daysUntil(date, asOf = today()) {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / 86_400_000);
}
