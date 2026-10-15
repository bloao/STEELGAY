import test from "node:test";
import assert from "node:assert/strict";
import { buildSchema, SCHEMA, PAGES, ENGINES, schemaFor } from "../lib/data-schema.mjs";

test("every catalogued field points at known pages and calculations", () => {
  for (const [key, s] of Object.entries(SCHEMA)) {
    assert.ok(s.fields.length, key);
    for (const f of s.fields) {
      for (const p of f.usedIn) assert.ok(PAGES[p], `${key}.${f.key} → unknown page ${p}`);
      for (const e of f.engines || []) assert.ok(ENGINES[e], `${key}.${f.key} → unknown engine ${e}`);
    }
  }
  assert.equal(schemaFor("prices-meps"), SCHEMA.prices);
});

test("buildSchema adds live examples and a page index", () => {
  const feeds = [{ key: "fx", name: "Exchange rates", source: "Frankfurter", status: "live", every: 1 }, { key: "hmrc-quotas", name: "HMRC quota balances", source: "HMRC", status: "error", every: 1 }];
  const r = buildSchema(feeds, { fx: { eur: 0.85, date: "2026-10-15" } });
  assert.equal(r.totals.sources, 2);
  const fx = r.sources.find((s) => s.key === "fx");
  assert.equal(fx.fields.find((f) => f.label === "EUR → GBP").example, 0.85);
  assert.equal(fx.fields.find((f) => f.label === "USD → GBP").example, null);
  const plan = r.pages.find((p) => p.key === "plan");
  assert.ok(plan.feeds.some((f) => f.key === "fx" && f.fields.includes("EUR → GBP")));
});
