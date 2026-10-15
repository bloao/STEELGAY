import { test } from "node:test";
import assert from "node:assert/strict";
import { converse, runTool, TOOLS } from "../lib/assistant.mjs";

const data = {
  products: async () => [{ id: "p1", name: "100×50 Flat", category: "Merchant Bar", commodityCode: "7214911090", steelCategory: { id: "12B" }, stockT: 1.5, monthlyUsageT: 2, costPerT: 781,
    metrics: { coverMonths: 0.75, stockOutDate: "2026-11-04", stockValue: 1171.5, status: "critical", reason: "x", suggestedOrderT: 5 } }],
  scenarios: async () => [{ id: "s1", title: "A", commodityCode: "7208390090", status: "draft", expectedPerT: 700, quotaProbability: 0.5 },
    { id: "s2", title: "B", commodityCode: "7214911090", status: "approved", expectedPerT: 800, quotaProbability: 0 }],
  scenario: async (id) => (id === "s1" ? { id: "s1", status: "draft", inputs: {}, result: { totals: { expectedPerT: 700 }, lines: [] }, activity: [] } : null),
  quotas: async () => ({ sources: { tariff: { lines: 72, auth: "registered" } }, fetchedAt: "t", quarter: { label: "Q2" },
    lines: [{ orderNumber: "058623", categoryId: "12B", categoryName: "Bars", origin: "Turkey", initialT: 100, usedT: 40, balanceT: 60, burnPerDayT: 4, risk: "open" },
      { orderNumber: "058604", categoryId: "4", categoryName: "Coated", origin: "European Union", initialT: 1, usedT: 1, balanceT: 0, risk: "exhausted" }] }),
  price: async (inputs) => ({ ok: true, inputs, totals: { expectedPerT: 650 }, lines: [], warnings: [], checks: [] }),
  commodities: async () => [{ code: "7216210000", description: "L sections", heading: "7216", headingDescription: "Angles, shapes and sections" },
    { code: "7214911090", description: "Other", heading: "7214", headingDescription: "Other bars and rods" }],
  categoryFor: () => "12B",
};

test("eight read-only tools with valid names", () => {
  assert.equal(TOOLS.length, 8);
  for (const t of TOOLS) assert.match(t.name, /^[a-zA-Z0-9_-]{1,128}$/);
});

test("tools filter and shape data", async () => {
  assert.equal((await runTool("list_products", {}, data))[0].suggestedOrderT, 5);
  assert.deepEqual((await runTool("list_scenarios", { status: "approved" }, data)).map((s) => s.id), ["s2"]);
  assert.equal((await runTool("get_quota_lines", { categoryId: "12b" }, data)).lines[0].orderNumber, "058623");
  assert.equal((await runTool("get_quota_lines", { risk: "exhausted" }, data)).lines[0].orderNumber, "058604");
  assert.equal((await runTool("find_commodity_code", { query: "angles sections" }, data))[0].code, "7216210000");
  assert.equal((await runTool("find_commodity_code", { query: "7214 91" }, data))[0].code, "7214911090");
  const priced = await runTool("price_order", { commodityCode: "7214911090", origin: "Turkey", tonnage: 16, importDate: "2026-11-12", priceAmount: 640, priceCurrency: "USD" }, data);
  assert.equal(priced.assumedInputs.incoterm, "CFR");
  await assert.rejects(() => runTool("get_scenario", { id: "nope" }, data));
});

test("the loop runs tools, returns results to the model, and ends with text", async () => {
  const calls = [];
  const callModel = async (body) => {
    calls.push(body);
    if (calls.length === 1) {
      return { stop_reason: "tool_use", content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "t1", name: "list_products", input: {} }], usage: { input_tokens: 10, output_tokens: 5 } };
    }
    const last = body.messages.at(-1);
    assert.equal(last.role, "user");
    assert.equal(last.content[0].type, "tool_result");
    assert.equal(last.content[0].tool_use_id, "t1");
    assert.match(last.content[0].content, /100×50 Flat/);
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Order **5 t** of 100×50 Flat." }], usage: { input_tokens: 20, output_tokens: 8 } };
  };
  const res = await converse({ messages: [{ role: "user", content: "What needs ordering?" }], callModel, data, model: "m", system: "s" });
  assert.equal(res.reply, "Order **5 t** of 100×50 Flat.");
  assert.deepEqual(res.tools.map((t) => t.name), ["list_products"]);
  assert.equal(res.usage.input_tokens, 30);
  assert.equal(calls[0].tools.length, 8);
});

test("tool errors go back to the model as is_error", async () => {
  let seen;
  const callModel = async (body) => {
    if (!seen) { seen = true; return { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t9", name: "get_scenario", input: { id: "missing" } }] }; }
    assert.equal(body.messages.at(-1).content[0].is_error, true);
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Not found." }] };
  };
  const res = await converse({ messages: [{ role: "user", content: "x" }], callModel, data, model: "m", system: "s" });
  assert.equal(res.tools[0].ok, false);
});

test("runaway tool loops stop", async () => {
  const callModel = async () => ({ stop_reason: "tool_use", content: [{ type: "tool_use", id: "t", name: "list_products", input: {} }] });
  const res = await converse({ messages: [{ role: "user", content: "x" }], callModel, data, model: "m", system: "s" });
  assert.equal(res.stopReason, "max_rounds");
});

test("plan_order finds the product by name and summarises the planner", async () => {
  const { runTool } = await import("../lib/assistant.mjs");
  const data = {
    products: async () => [{ id: "p1", name: "40×10 Flat", metrics: {} }],
    plan: async (body) => ({ ok: true, product: { name: "40×10 Flat", stockT: 32, coverMonths: 2, stockOutDate: "2026-12-14" }, inputs: { tonnage: 16, needBy: "2026-12-14", appetite: body.appetite, cbam: false },
      recommendation: { ok: true, best: { name: "Tata Steel UK", effectivePerT: 724.4, arrival: "2026-11-04" }, recTonnes: 16, timing: { action: "order-now", text: "Order now" }, reasons: [], watch: [] },
      options: [], split: { single: { name: "Tata Steel UK", spend: 11590 }, splits: [], better: null, extraOrderCost: 150 } }),
  };
  const r = await runTool("plan_order", { product: "40x10 flat", approach: "speed" }, data);
  assert.equal(r.ok, true);
  assert.equal(r.approach, "speed");
  assert.equal(r.recommendation.supplier, "Tata Steel UK");
  assert.equal(r.split.splitWins, false);
});

test("Messages-style turns translate to and from the OpenAI format (Ollama, Groq, Gemini)", async () => {
  const { toOpenAI, fromOpenAI } = await import("../lib/assistant.mjs");
  const req = toOpenAI({ model: "m", max_tokens: 100, system: "sys", tools: [{ name: "list_products", description: "d", input_schema: { type: "object", properties: {} } }],
    messages: [{ role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "checking" }, { type: "tool_use", id: "t1", name: "list_products", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] }] });
  assert.deepEqual(req.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(req.messages[2].tool_calls[0].function.name, "list_products");
  assert.equal(req.messages[3].tool_call_id, "t1");
  assert.equal(req.tools[0].function.name, "list_products");
  const res = fromOpenAI({ choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "plan_order", arguments: "{\"product\":\"40×10 Flat\"}" } }] } }], usage: { prompt_tokens: 5, completion_tokens: 2 } });
  assert.equal(res.stop_reason, "tool_use");
  assert.equal(res.content[0].input.product, "40×10 Flat");
  assert.equal(fromOpenAI({ choices: [{ message: { content: "Done" } }] }).stop_reason, "end_turn");
});
