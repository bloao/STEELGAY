import { test } from "node:test";
import assert from "node:assert/strict";
import { createFeedManager, nextDelay, statusOf } from "../lib/feeds.mjs";

const H = 3_600_000;
function fakeClock() {
  let t = Date.parse("2026-10-15T09:00:00Z");
  const timers = [];
  return {
    now: () => t,
    setTimer: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    async advance(ms) { const end = t + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const nx = timers[0]; if (!nx || nx.at > end) break; timers.shift(); t = nx.at; await nx.fn(); await new Promise((r) => setImmediate(r)); } t = end; },
  };
}

test("a failing feed retries with growing back-off, then recovers and goes live", async () => {
  const c = fakeClock();
  let fail = 3, calls = 0;
  const m = createFeedManager({ feeds: [{ key: "q", name: "Quotas", intervalMs: 6 * H, firstDelayMs: 0, run: async () => { calls++; if (fail-- > 0) throw new Error("503"); return { ok: true, detail: "72 lines" }; } }], ...c });
  m.start();
  await c.advance(1);
  assert.equal(m.get("q").status, "error");
  assert.equal(m.get("q").failures, 1);
  await c.advance(60_000 + 120_000 + 300_000 + 10);
  assert.equal(calls, 4);
  assert.equal(m.get("q").status, "live");
  assert.equal(m.get("q").detail, "72 lines");
  assert.equal(m.get("q").failures, 0);
  await c.advance(6 * H);
  assert.equal(calls, 5); // keeps going on its interval
});

test("back-off never exceeds the interval; off and stale states", () => {
  assert.equal(nextDelay({ intervalMs: 2 * 60_000 }, false, 5), 2 * 60_000);
  assert.equal(nextDelay({ intervalMs: H }, true, 0), H);
  const now = Date.parse("2026-10-15T12:00:00Z");
  assert.equal(statusOf({ state: "off" }, { intervalMs: H }, now), "off");
  assert.equal(statusOf({ state: "on", lastOkAt: "2026-10-15T08:00:00Z" }, { intervalMs: H }, now), "stale");
  assert.equal(statusOf({ state: "on", connected: true }, { intervalMs: H, stream: true }, now), "live");
});

test("a feed that needs a key reports off without counting as a failure", async () => {
  const c = fakeClock();
  const m = createFeedManager({ feeds: [{ key: "lme", name: "LME", intervalMs: H, firstDelayMs: 0, run: async () => ({ off: true, detail: "Add a key" }) }], ...c });
  m.start();
  await c.advance(1);
  assert.equal(m.get("lme").status, "off");
  assert.equal(m.get("lme").failures, 0);
  assert.equal(m.get("lme").detail, "Add a key");
});
