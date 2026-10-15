// Procurement assistant: Claude with read-only tools over this app's data.
// Network access to Anthropic lives in server.mjs; this file defines the
// tools, runs them against injected data accessors, and drives the loop.

export const DEFAULT_MODEL = "claude-sonnet-5-5";
export const MAX_TOOL_ROUNDS = 8;

export function systemPrompt({ today, user }) {
  return `You are the procurement assistant inside Datafab AGX's steel order tool, used by a UK steel stockholder's buying team. Today is ${today}. The person asking is ${user}.

What you know about the business:
- They buy steel (mainly merchant bar: angles, flats, rounds) for stock. The Products tab holds stock, monthly usage and stock cost price per product.
- Imports are subject to the UK steel trade measure from 1 July 2026: 72 tariff-rate quota lines (order numbers 058600–058671) across 20 categories, quarterly periods (Q1 Jul–Sep, Q2 Oct–Dec, Q3 Jan–Mar, Q4 Apr–Jun), unused volume carries over within the quota year. Within quota there is no steel duty; once a line is used up, a 50% steel duty applies to the goods value on top of ordinary duty. "Residual" lines cover every origin not named for that category. Ukraine is excluded. HMRC allocates quota first come, first served at declaration.
- Live quota balances come from HMRC's Trade Tariff API (fallback: DBT daily dataset).

How to work:
- Always use the tools to get numbers. Never invent prices, balances, duty rates or stock figures. If a tool fails or data is missing, say so plainly.
- For "what should I order / who from / should I split" questions about the user's own products, use plan_order (it uses their real suppliers and assumptions).
- To price an order, use price_order. It needs commodity code, origin, tonnage, import date and price; ask for missing essentials only if you cannot sensibly assume them, and state any assumption (e.g. "assuming CFR and import in 30 days").
- When you quote a figure, say where it came from and how fresh it is (e.g. "HMRC, 13:05").
- Be concise and practical, in British English. Use short paragraphs, bullet points, or a small table when comparing options. Money in £, tonnes as "t".
- You are read-only: you cannot save scenarios or change products. If asked, explain how to do it in the app (e.g. "Products → Price an order", "Orders → New scenario").
- Estimates only, not customs advice — mention this once when giving duty or landed-cost figures for a decision.`;
}

export const TOOLS = [
  {
    name: "list_products",
    description: "List the stock products with current stock (t), monthly usage (t), stock cost price (£/t), steel-measure category, and calculated metrics: months of cover, stock-out date, stock value, reorder status (critical/reorder/low/ok) and suggested order quantity. Use for questions about stock, what needs ordering, or before pricing a restock.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_suppliers",
    description: "List suppliers with origin, what product groups they supply, latest quoted price (and what it covers: everything = delivered duty paid, except-duty = you pay any steel duty), worst-case price if the origin's quota runs out (+50% duty), MOQ, lead time, on-time %, payment terms, pricing benchmarks, main contact name, and whether a quote request is awaiting reply. Use for supplier comparisons and 'who should I buy from' questions.",
    input_schema: { type: "object", properties: { supplies: { type: "string", description: "Optional product group filter, e.g. 'Merchant Bar'" } }, additionalProperties: false },
  },
  {
    name: "list_scenarios",
    description: "List saved order scenarios (supplier quotes priced by the tool) with title, commodity code, supplier, origin, Incoterm, tonnage, import date, expected landed £/t, quota exhaustion probability, quota order number and approval status. Optionally filter by status or commodity code.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["draft", "submitted", "approved", "rejected"], description: "Only scenarios with this status." },
        commodityCode: { type: "string", description: "Only scenarios for this 10-digit commodity code." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_scenario",
    description: "Get one saved scenario in full: inputs, the per-tonne cost build-up (price, freight, insurance, duty, steel-measure risk, anti-dumping, CBAM, inland, brokerage, FX, finance), totals, quota position, warnings, checks and activity history. Use the id from list_scenarios.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
  },
  {
    name: "get_quota_lines",
    description: "Live UK steel tariff-quota balances for the current quarter from HMRC: per line the order number, category, origin (or Residual), opening volume, tonnes used and left, average daily use, projected run-out date and risk (open/watch/critical/exhausted), plus history since 2021 (average fill, how often it ran out, typical day it filled, past pace) and when it should fill this quarter / the last safe import date. Filter by category id (e.g. '12B'), origin, or risk.",
    input_schema: {
      type: "object",
      properties: {
        categoryId: { type: "string", description: "Steel-measure category id, e.g. '1', '4', '12B'." },
        origin: { type: "string", description: "Origin name, e.g. 'Turkey', 'European Union', or 'Residual'." },
        risk: { type: "string", enum: ["open", "watch", "critical", "exhausted"] },
      },
      additionalProperties: false,
    },
  },
  {
    name: "price_order",
    description: "Price a hypothetical order with the order tool's landed-cost engine (live HMRC quota data, GOV.UK tariff, FX). Returns expected landed £/t and total, low/high range, each cost line with its source, quota line and run-out probability, VAT (shown separately), warnings and checks. Does not save anything. Origins: United Kingdom, European Union, Turkey, India, China, South Korea, Vietnam, Taiwan, Japan, Ukraine, United States, Switzerland, United Arab Emirates, Other non-UK. Incoterms: EXW, FCA, FOB, CFR, CIF, CPT, CIP, DAP, DPU, DDP.",
    input_schema: {
      type: "object",
      properties: {
        commodityCode: { type: "string", description: "8 or 10 digit UK commodity code." },
        origin: { type: "string" },
        tonnage: { type: "number" },
        importDate: { type: "string", description: "YYYY-MM-DD" },
        priceAmount: { type: "number", description: "Quoted price per tonne in priceCurrency." },
        priceCurrency: { type: "string", enum: ["GBP", "EUR", "USD"] },
        incoterm: { type: "string" },
        importerOfRecord: { type: "string", enum: ["us", "supplier"] },
        freightToUkPerT: { type: "number", description: "£/t, only if not included by the Incoterm." },
        insurancePerT: { type: "number" },
        inlandFreightPerT: { type: "number" },
        brokeragePerShipment: { type: "number" },
        supplier: { type: "string" },
      },
      required: ["commodityCode", "origin", "tonnage", "importDate", "priceAmount"],
      additionalProperties: false,
    },
  },
  {
    name: "plan_order",
    description: "Run the order planner for one of the user's products: prices every supplier for it at the given tonnage with every cost counted (quota risk, CBAM if asked, payment terms, MOQ, reliability, market intel), scores them under an approach (cashflow = values payment terms, speed = values quick and reliable suppliers, balanced), checks whether splitting the order between two suppliers beats one, and recommends supplier, quantity and timing (order now, buy ahead, hold off). Use this for 'what should I order', 'who should I buy from' and 'should I split' questions.",
    input_schema: {
      type: "object",
      properties: {
        product: { type: "string", description: "Product name (e.g. '40×10 Flat') or id, from list_products." },
        tonnage: { type: "number", description: "Optional; defaults to the suggested order." },
        approach: { type: "string", enum: ["cashflow", "speed", "balanced"] },
        cbam: { type: "boolean", description: "Price UK CBAM as if already in force." },
      },
      required: ["product"],
      additionalProperties: false,
    },
  },
  {
    name: "find_commodity_code",
    description: "Search UK commodity codes in chapters 72–73 (iron and steel) by words or digits, returning code, description, heading and steel-measure category. Use when the user names a product (e.g. 'hot rolled coil', 'equal angle', 'rebar') rather than a code.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
  },
];

const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : v);

// Tool implementations. `data` supplies async accessors from the server.
export async function runTool(name, input, data) {
  switch (name) {
    case "list_products": {
      const products = await data.products();
      return products.map((p) => ({
        id: p.id, name: p.name, category: p.category, commodityCode: p.commodityCode,
        steelCategory: p.steelCategory?.id || null, stockT: p.stockT, monthlyUsageT: p.monthlyUsageT, costPerT: p.costPerT,
        leadTimeWeeks: p.leadTimeWeeks, targetBuyPrice: p.targetBuyPrice,
        coverMonths: round(p.metrics.coverMonths, 1), stockOutDate: p.metrics.stockOutDate, stockValue: round(p.metrics.stockValue, 0),
        status: p.metrics.status, reason: p.metrics.reason, suggestedOrderT: p.metrics.suggestedOrderT, latestOrderDate: p.metrics.latestOrderDate,
      }));
    }
    case "list_suppliers": {
      let rows = data.suppliers ? await data.suppliers() : [];
      if (input.supplies) rows = rows.filter((s) => (s.supplies || []).some((g) => g.toLowerCase() === String(input.supplies).toLowerCase()));
      return rows.map((s) => ({
        name: s.name, origin: s.origin || null, type: s.type || null, supplies: s.supplies, standing: s.standing,
        quotedPerT: s.metrics.pricePerT, currency: s.metrics.currency, priceCovers: s.metrics.covers, quotedOn: s.metrics.priceDate,
        worstCasePerT: s.metrics.worstCasePerT, dutyExposed: s.metrics.dutyExposed,
        moq: s.moqNote || (s.moqMinT !== null ? `${s.moqMinT}${s.moqMaxT && s.moqMaxT !== s.moqMinT ? `-${s.moqMaxT}` : ""} t` : null),
        leadTime: s.leadTimeMin !== null ? `${s.leadTimeMin}${s.leadTimeMax && s.leadTimeMax !== s.leadTimeMin ? `-${s.leadTimeMax}` : ""} ${s.leadTimeUnit}` : null,
        onTimePct: s.onTimePct, paymentDays: s.paymentDays, paymentNote: s.paymentNote || null, ddp: s.ddp || null,
        pricingSources: s.pricingSources, dutyCosts: s.dutyCosts || null, otherDuty: s.otherDuty || null, dutyRiskNote: s.dutyRiskNote || null,
        mainContact: s.metrics.primaryContact ? s.metrics.primaryContact.name : null, awaitingQuote: Boolean(s.metrics.awaitingQuote),
      }));
    }
    case "list_scenarios": {
      let rows = await data.scenarios();
      if (input.status) rows = rows.filter((s) => s.status === input.status);
      if (input.commodityCode) rows = rows.filter((s) => s.commodityCode === String(input.commodityCode).replace(/\s+/g, ""));
      return rows.map((s) => ({
        id: s.id, title: s.title, commodityCode: s.commodityCode, supplier: s.supplier, origin: s.origin, incoterm: s.incoterm,
        tonnage: s.tonnage, importDate: s.importDate, expectedPerT: s.expectedPerT, quotaProbability: s.quotaProbability === null ? null : round(s.quotaProbability, 2),
        quotaOrderNumber: s.quotaOrderNumber, status: s.status, sampleData: s.sample, quoteValidUntil: s.quoteValidUntil,
      }));
    }
    case "get_scenario": {
      const s = await data.scenario(input.id);
      if (!s) throw new Error("No scenario with that id");
      const r = s.result || {};
      return {
        id: s.id, status: s.status, inputs: s.inputs,
        totals: r.totals, lines: (r.lines || []).map((l) => ({ label: l.label, perTonne: l.perTonne, source: l.source, note: l.note, status: l.status })),
        quota: r.quota && { orderNumber: r.quota.orderNumber, probability: round(r.quota.probability, 2), balanceT: round(r.quota.balanceT, 0), projectedBalanceT: round(r.quota.projectedBalanceT, 0), basis: r.quota.basis },
        warnings: r.warnings, checks: r.checks, calculatedAt: r.sources?.calculatedAt, sampleData: Boolean(r.sources?.sample),
        activity: (s.activity || []).slice(-6),
      };
    }
    case "get_quota_lines": {
      const q = await data.quotas();
      const qh = data.quotaHistory ? await data.quotaHistory().catch(() => null) : null;
      const hist = new Map(qh ? qh.lines.map((h) => [h.orderNumber, h]) : []);
      let lines = q.lines;
      if (input.categoryId) lines = lines.filter((l) => l.categoryId.toLowerCase() === String(input.categoryId).toLowerCase());
      if (input.origin) lines = lines.filter((l) => l.origin.toLowerCase() === String(input.origin).toLowerCase());
      if (input.risk) lines = lines.filter((l) => l.risk === input.risk);
      return {
        source: q.sources.tariff.lines ? `HMRC Trade Tariff (${q.sources.tariff.auth})` : "DBT daily dataset",
        fetchedAt: q.fetchedAt, quarter: q.quarter.label,
        lines: lines.slice(0, 40).map((l) => ({
          orderNumber: l.orderNumber, categoryId: l.categoryId, category: l.categoryName, origin: l.origin,
          openingT: round(l.initialT, 0), usedT: round(l.usedT, 0), leftT: round(l.balanceT, 0), burnPerDayT: round(l.burnPerDayT, 1),
          runOutDate: l.runOutDate, risk: l.risk, quarterEnds: l.endDate,
          history: hist.has(l.orderNumber) ? (({ quarters, avgFillPct, exhaustedCount, recentQuarters, dayFullMedian, paceT, outlook }) => ({ quarters, avgFilledPct: round(avgFillPct, 0), ranOutInLast: `${exhaustedCount}/${recentQuarters}`, typicalFullDay: dayFullMedian, pastPaceTPerDay: round(paceT, 0), fillsAround: outlook && outlook.fullOn, safeToImportUntil: outlook && outlook.safeUntil, outlook: outlook && outlook.verdict }))(hist.get(l.orderNumber)) : null,
        })),
        truncated: lines.length > 40,
      };
    }
    case "price_order": {
      const inputs = { incoterm: "CFR", priceCurrency: "GBP", importerOfRecord: "us", ...input };
      const r = await data.price(inputs);
      if (!r.ok) return { ok: false, errors: r.errors };
      return {
        ok: true, assumedInputs: { incoterm: inputs.incoterm, priceCurrency: inputs.priceCurrency, importerOfRecord: inputs.importerOfRecord },
        totals: r.totals, category: r.category, customsValuePerT: r.customsValuePerT,
        lines: r.lines.map((l) => ({ label: l.label, perTonne: l.perTonne, source: l.source, note: l.note, status: l.status })),
        quota: r.quota && { orderNumber: r.quota.orderNumber, matched: r.quota.matched, probability: round(r.quota.probability, 2), leftNowT: round(r.quota.balanceT, 0), projectedAtImportT: round(r.quota.projectedBalanceT, 0), basis: r.quota.basis },
        warnings: r.warnings, checks: r.checks, sources: r.sources,
      };
    }
    case "plan_order": {
      if (!data.plan) throw new Error("Planner not available");
      const products = await data.products();
      const q = String(input.product || "").toLowerCase().replace(/\s+/g, "").replace(/x/g, "×");
      const p = products.find((x) => x.id === input.product) || products.find((x) => x.name.toLowerCase().replace(/\s+/g, "") === q) || products.find((x) => x.name.toLowerCase().replace(/\s+/g, "").includes(q));
      if (!p) return { ok: false, error: `No product matching "${input.product}". Use list_products.` };
      const r = await data.plan({ productId: p.id, tonnage: input.tonnage, appetite: input.approach || "balanced", cbam: input.cbam === true });
      if (!r.ok) return { ok: false, error: r.error };
      const rec = r.recommendation;
      const sp = r.split || {};
      return {
        ok: true, product: r.product.name, tonnage: r.inputs.tonnage, needBy: r.inputs.needBy, approach: r.inputs.appetite, cbam: r.inputs.cbam,
        stock: { stockT: round(r.product.stockT, 1), coverMonths: round(r.product.coverMonths, 1), runsOut: r.product.stockOutDate },
        recommendation: rec.ok ? { supplier: rec.best.name, landedPerT: round(rec.best.effectivePerT, 0), tonnes: rec.recTonnes, total: round(rec.best.effectivePerT * rec.recTonnes, 0), arrives: rec.best.arrival, timing: rec.timing.action, timingText: rec.timing.text, reasons: rec.reasons, watch: rec.watch } : { error: rec.reason },
        suppliers: (r.options || []).slice(0, 6).map((o) => ({ name: o.name, origin: o.origin, landedPerT: round(o.effectivePerT, 0), ifQuotaMissedPerT: round(o.quotaExposure, 0), score: round(o.score, 0), paymentDays: o.payDays, arrives: o.arrival, lateDays: o.lateDays, warnings: o.warnings })),
        split: sp.single ? { oneSupplier: { name: sp.single.name, spend: round(sp.single.spend, 0) }, bestSplits: (sp.splits || []).map((x) => ({ parts: x.parts.map((pp) => `${pp.tonnes} t ${pp.name}`), spend: round(x.spend, 0), savingVsOne: round(x.saving, 0) })), splitWins: Boolean(sp.better), extraOrderCost: sp.extraOrderCost } : null,
        forecast3mPct: r.forecast ? round(r.forecast.in3, 1) : null,
      };
    }
    case "find_commodity_code": {
      const q = String(input.query || "").toLowerCase().trim();
      const digits = q.replace(/\s+/g, "");
      const words = q.split(/\s+/).filter((w) => w.length > 2);
      const list = await data.commodities();
      const scored = list.map((c) => {
        if (/^\d{4,10}$/.test(digits)) return { c, score: c.code.startsWith(digits) ? 10 : 0 };
        const text = `${c.description} ${c.headingDescription}`.toLowerCase();
        return { c, score: words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0) };
      }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 15);
      return scored.map(({ c }) => ({ code: c.code, description: c.description, heading: `${c.heading} ${c.headingDescription}`.slice(0, 160), steelCategory: data.categoryFor(c.code) }));
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

const TOOL_LABELS = {
  list_products: "Checked products",
  list_suppliers: "Compared suppliers",
  list_scenarios: "Looked up saved scenarios",
  get_scenario: "Opened a scenario",
  get_quota_lines: "Checked live HMRC quotas",
  price_order: "Priced an order",
  plan_order: "Ran the order planner",
  find_commodity_code: "Searched commodity codes",
};

// The tool-use loop. `callModel(body)` posts to the Messages API.
export async function converse({ messages, callModel, data, model, system }) {
  const convo = messages.map((m) => ({ role: m.role, content: m.content }));
  const used = [];
  let usage = { input_tokens: 0, output_tokens: 0 };
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await callModel({ model, max_tokens: 2048, system, tools: TOOLS, messages: convo });
    usage = { input_tokens: usage.input_tokens + (res.usage?.input_tokens || 0), output_tokens: usage.output_tokens + (res.usage?.output_tokens || 0) };
    const blocks = res.content || [];
    if (res.stop_reason !== "tool_use") {
      const reply = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
      return { reply: reply || "(No answer returned.)", tools: used, usage, stopReason: res.stop_reason };
    }
    convo.push({ role: "assistant", content: blocks });
    const results = [];
    for (const block of blocks.filter((b) => b.type === "tool_use")) {
      let content;
      let isError = false;
      try {
        // eslint-disable-next-line no-await-in-loop
        content = JSON.stringify(await runTool(block.name, block.input || {}, data));
      } catch (error) {
        isError = true;
        content = `Error: ${error.message}`;
      }
      used.push({ name: block.name, label: TOOL_LABELS[block.name] || block.name, ok: !isError });
      results.push({ type: "tool_result", tool_use_id: block.id, content: content.slice(0, 60_000), is_error: isError });
    }
    convo.push({ role: "user", content: results });
  }
  return { reply: "I needed more steps than allowed to answer that — try asking a narrower question.", tools: used, usage, stopReason: "max_rounds" };
}

// ------------------------------------------------------------ other providers
// Free options for demos: Ollama (runs on your own computer, nothing leaves
// it), Groq and Google Gemini (free tiers with a key). All three speak the
// OpenAI chat-completions format, so the Messages-style loop above is kept and
// requests/responses are translated here.
export const PROVIDERS = {
  anthropic: { label: "Claude (Anthropic)", keyName: "ANTHROPIC_API_KEY", model: DEFAULT_MODEL },
  ollama: { label: "Ollama (on this computer, free)", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
  groq: { label: "Groq (free tier)", baseUrl: "https://api.groq.com/openai/v1", keyName: "GROQ_API_KEY", model: "openai/gpt-oss-120b",
    prefer: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct", "meta-llama/llama-4-maverick-17b-128e-instruct", "qwen/qwen3-32b", "openai/gpt-oss-20b", "meta-llama/llama-4-scout-17b-16e-instruct", "llama-3.1-8b-instant"] },
  gemini: { label: "Google Gemini (free tier)", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", keyName: "GEMINI_API_KEY", model: "gemini-2.5-flash",
    prefer: ["gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash-lite"] },
};

// Free providers retire models often. Pick the best one this key can use
// from the provider's own model list.
const NOT_CHAT = /whisper|tts|guard|embed|vision-preview|playai|distil|orpheus|compound|image|audio|veo|imagen/i;
export function pickModel(provider, ids = []) {
  const p = PROVIDERS[provider];
  const clean = ids.map((id) => String(id).replace(/^models\//, ""));
  for (const want of (p && p.prefer) || []) if (clean.includes(want)) return want;
  return clean.find((id) => !NOT_CHAT.test(id) && (provider !== "gemini" || /^gemini/.test(id))) || null;
}

// Messages API request → chat-completions request
export function toOpenAI(body) {
  const messages = [];
  if (body.system) messages.push({ role: "system", content: body.system });
  for (const m of body.messages || []) {
    if (typeof m.content === "string") { messages.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const calls = blocks.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      messages.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of blocks) {
        if (b.type === "tool_result") messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
        else if (b.type === "text") messages.push({ role: "user", content: b.text });
      }
    }
  }
  return {
    model: body.model, max_tokens: body.max_tokens, messages,
    tools: (body.tools || []).map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    tool_choice: "auto",
  };
}

// chat-completions response → Messages API response
export function fromOpenAI(res) {
  const msg = res?.choices?.[0]?.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: String(msg.content) });
  for (const [i, c] of (msg.tool_calls || []).entries()) {
    let input = {};
    try { input = typeof c.function?.arguments === "string" ? JSON.parse(c.function.arguments || "{}") : c.function?.arguments || {}; } catch { input = {}; }
    content.push({ type: "tool_use", id: c.id || `call_${i}`, name: c.function?.name, input });
  }
  return {
    content,
    stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
    usage: { input_tokens: res?.usage?.prompt_tokens || 0, output_tokens: res?.usage?.completion_tokens || 0 },
  };
}
